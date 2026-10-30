import net from "node:net";

/**
 * JSON-lines over TCP client for the gma3_mcp_bridge Lua plugin running inside grandMA3 onPC.
 */

export interface BridgeOptions {
  host: string;
  port: number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  /**
   * Do not let the open socket keep the Node event loop alive. Pending requests still hold the
   * loop through their timers. Used by test runners so a process exits once its tests are done.
   */
  unref?: boolean;
  /** Optional exact named-instance guard, checked freshly before each potentially mutating op. */
  expectedStation?: string;
  expectedShows?: readonly string[];
}

const READ_ONLY_OPS = new Set(("ping modules object children objects dump getfader executor executors api fixtureAttributes programmer fixtureOutput dmx cueContents cue.content view.content feedback.describe feedback.read feedback.context feedback.watch feedback.unwatch input.status input.routing input.sequence.status control.status patch.state patch.types patch.list patch.check patch.collections patch.fingerprint patch.library patch.libraryStat patch.typeInfo patch.typeStructure patch.importState patch.cellLayout patch.moveCheck patch.moveState patch.groupsOf dmx.output vars.get tags tags.of show.files dialog.read osc.read group.read selection.grid preset.read preset.context timecode.read fast.context programmer.snapshot fast.lease").split(" "));

interface Pending {
  op: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class BridgeError extends Error {
  /**
   * True when the request was already written to the bridge before the failure
   * (timeout, or the connection dropped while waiting for the reply). The
   * command may or may not have executed inside onPC; callers must not retry
   * non-idempotent commands on another transport.
   *
   * `code` is the bridge's bracketed error code ("busy", "conflict", "press-failed", ...) when the
   * reply carried one, and `detail` the structured error the plugin reported (since bridge 0.7.0:
   * partial progress of a combo, the owner of a busy lock, the remaining lease). Both are preserved
   * so a caller can tell a refusal before dispatch from a failure after input went out.
   */
  constructor(
    message: string,
    public readonly op?: string,
    public readonly dispatched = false,
    public readonly code?: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

/** The bracketed code at the start of a bridge error message ("[busy] ..."), if any. */
export function bridgeErrorCode(message: string): string | undefined {
  const m = /^\[([\w.-]+)\]/.exec(message);
  return m ? m[1] : undefined;
}

/** The bridge could not be reached at all; nothing was sent. Safe to fall back to another transport. */
export class BridgeUnreachableError extends BridgeError {
  constructor(message: string, op?: string) {
    super(message, op, false);
    this.name = "BridgeUnreachableError";
  }
}

export class Gma3Bridge {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private connectingSocket: net.Socket | null = null;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private lastError: string | null = null;
  private connections = 0;
  private disconnects = 0;
  private timeouts = 0;
  private lastReplyAt: string | null = null;
  private lastConnectedAt: string | null = null;
  private lastDisconnectedAt: string | null = null;
  private expectedDisconnect = false;
  private unresponsive = false;

  constructor(private readonly opts: BridgeOptions) {
    if (opts.expectedStation !== undefined && !opts.expectedStation.trim()) throw new Error("expectedStation must not be empty");
    if (opts.expectedShows !== undefined && (!opts.expectedShows.length || opts.expectedShows.some(show => !show.trim()))) throw new Error("expectedShows must be a nonempty list of exact show names");
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  get description(): string {
    return `${this.opts.host}:${this.opts.port}`;
  }

  get lastErrorMessage(): string | null {
    return this.lastError;
  }

  /** Transport observations only. A live TCP socket does not prove the console is replying. */
  get diagnostics() {
    return {
      address: this.description,
      state: this.connected ? (this.unresponsive ? "unresponsive" : this.lastReplyAt ? "responsive" : "connected") : this.connecting ? "connecting" : "disconnected",
      tcpConnected: this.connected,
      pendingRequests: this.pending.size,
      connections: this.connections,
      disconnects: this.disconnects,
      timeouts: this.timeouts,
      lastConnectedAt: this.lastConnectedAt,
      lastReplyAt: this.lastReplyAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastDisconnectExpected: this.expectedDisconnect,
      lastError: this.lastError,
      expectedIdentity: { station: this.opts.expectedStation ?? null, shows: this.opts.expectedShows ?? null },
      note: "Counters belong to this MCP server process. A command-line client may intentionally close its session after each invocation. A timeout never cancels or replays a request.",
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    const sock = new net.Socket();
    this.connectingSocket = sock;
    this.connecting = new Promise<void>((resolve, reject) => {
      const timeout = this.opts.connectTimeoutMs ?? 3000;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        if (this.connectingSocket === sock) this.lastError = err.message;
        sock.destroy();
        reject(err instanceof BridgeUnreachableError ? err : new BridgeUnreachableError(`cannot connect to bridge at ${this.description}: ${err.message}`));
      };
      sock.setNoDelay(true);
      sock.setTimeout(timeout, () => fail(new BridgeUnreachableError(`connect timeout to ${this.description}`)));
      sock.once("error", (err) => {
        if (!settled) fail(err);
        else this.handleClose(sock, err);
      });
      sock.connect(this.opts.port, this.opts.host, () => {
        if (settled || sock.destroyed) return;
        settled = true;
        sock.setTimeout(0);
        this.socket = sock;
        this.lastError = null;
        this.connections++;
        this.lastConnectedAt = new Date().toISOString();
        this.lastReplyAt = null;
        this.unresponsive = false;
        if (this.opts.unref) sock.unref();
        // setEncoding uses a streaming decoder so multi-byte UTF-8 sequences split across TCP packets are reassembled.
        sock.setEncoding("utf8");
        sock.on("data", (chunk: string) => { if (this.socket === sock) this.onData(chunk); });
        sock.on("close", () => this.handleClose(sock));
        resolve();
      });
    }).finally(() => {
      if (this.connectingSocket === sock) {
        this.connecting = null;
        this.connectingSocket = null;
      }
    });
    return this.connecting;
  }

  close(): void {
    const connecting = this.connectingSocket;
    this.connecting = null;
    this.connectingSocket = null;
    connecting?.destroy(new BridgeUnreachableError("connection cancelled by client before dispatch"));
    const sock = this.socket;
    if (!sock) return;
    this.handleClose(sock, undefined, true);
    sock.destroy();
  }

  private handleClose(sock: net.Socket, err?: Error, expected = false): void {
    // Error and close can both arrive, including after the caller already connected a new socket.
    // A retired socket must never clear the replacement socket, buffer or pending requests.
    if (this.socket !== sock) return;
    this.socket = null;
    this.buffer = "";
    this.disconnects++;
    this.lastDisconnectedAt = new Date().toISOString();
    this.expectedDisconnect = expected;
    const reason = err ? err.message : expected ? "client closed connection" : "connection closed";
    this.lastError = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      // The request was already on the wire: its outcome is unknown.
      p.reject(new BridgeError(`bridge ${reason} while waiting for reply`, p.op, true));
      this.pending.delete(id);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const id = msg?.id !== undefined && msg?.id !== null ? String(msg.id) : null;
      if (!id) continue;
      const p = this.pending.get(id);
      if (!p) continue;
      this.lastReplyAt = new Date().toISOString();
      this.lastError = null;
      this.unresponsive = false;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else {
        const message = String(msg.error ?? "unknown bridge error");
        const code = typeof msg.code === "string" ? msg.code : bridgeErrorCode(message);
        const detail = msg.detail && typeof msg.detail === "object" ? (msg.detail as Record<string, unknown>) : undefined;
        p.reject(new BridgeError(message, p.op, false, code, detail));
      }
    }
  }

  /** The command line the console receives for `command` (a data_pool bridge rewrites it; see tools/datapool.ts). */
  sentCommand(command: string): string {
    return command;
  }

  async request<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    await this.connect();
    const sock = this.socket;
    if (!sock) throw new BridgeUnreachableError("not connected", op);
    const leaseWrite = op === "fast.lease" && !["status", "release"].includes(String(args.action ?? "status"));
    const batchInspection = op === "fast.batch" && ["status", "list", "cancel"].includes(String(args.action ?? "start"));
    if ((this.opts.expectedStation || this.opts.expectedShows) && ((!READ_ONLY_OPS.has(op) && !batchInspection) || leaseWrite)) {
      // This is a fresh read on the same socket, never a cached identity or a mutation retry.
      const identity = await this.requestConnected<Record<string, unknown>>(sock, "ping", {}, timeoutMs);
      if (this.opts.expectedStation && identity.hostname !== this.opts.expectedStation) throw new BridgeError(`expected station ${JSON.stringify(this.opts.expectedStation)}, observed ${JSON.stringify(identity.hostname)}; mutation refused`, op, false, "wrong-instance");
      if (this.opts.expectedShows && !this.opts.expectedShows.includes(String(identity.showfile))) throw new BridgeError(`expected show in ${JSON.stringify(this.opts.expectedShows)}, observed ${JSON.stringify(identity.showfile)}; mutation refused`, op, false, "wrong-instance");
      if (this.socket !== sock || sock.destroyed) throw new BridgeUnreachableError("connection changed after identity check; nothing dispatched", op);
    }
    return this.requestConnected<T>(sock, op, args, timeoutMs);
  }

  private requestConnected<T>(sock: net.Socket, op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (this.socket !== sock || sock.destroyed) return Promise.reject(new BridgeUnreachableError("connection changed before dispatch", op));
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, op, args }) + "\n";
    const timeout = timeoutMs ?? this.opts.requestTimeoutMs ?? 15000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.timeouts++;
        this.unresponsive = true;
        this.lastError = `timeout after ${timeout}ms waiting for '${op}'`;
        reject(new BridgeError(`timeout after ${timeout}ms waiting for '${op}'`, op, true));
      }, timeout);
      this.pending.set(id, { op, resolve: resolve as (v: unknown) => void, reject, timer });
      sock.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          // A write error does not prove the bytes never left; treat the outcome as unknown.
          reject(new BridgeError(`bridge write failed: ${err.message}`, op, true));
        }
      });
    });
  }
}
