import { mkdir, open, readFile, rename, readdir, lstat, unlink, access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const jobId = (id: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) throw new Error("invalid job ID");
  return id;
};
/** Atomic, fsynced journal replacement. No arbitrary paths or symlink-following reads. */
export class Journal {
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}
  async read<T>(id: string): Promise<T> {
    const path = join(this.directory, `${jobId(id)}.json`);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error("invalid or oversized job journal");
    return JSON.parse(await readFile(path, "utf8")) as T;
  }
  write(id: string, value: unknown): Promise<void> {
    // Capture now; a concurrent cancellation must not race object serialization.
    const data = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(data, "utf8") > 32 * 1024 * 1024) return Promise.reject(new Error("job journal exceeds 32 MiB; reduce the plan scope before running"));
    const write = this.pending.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, `${jobId(id)}.json`), temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(data, "utf8"); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    });
    this.pending = write.catch(() => {}); // Keep the queue usable; the caller still receives the failure.
    return write;
  }
  async ids(): Promise<string[]> {
    const names = await readdir(this.directory).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return []; throw err; });
    return names.filter((n) => /^[0-9a-f]{8}-[0-9a-f-]{27}\.json$/i.test(n)).map((n) => n.slice(0, -5));
  }
  async claimIds(): Promise<string[]> {
    const names = await readdir(this.directory).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return []; throw err; });
    return names.filter(name => /^[0-9a-f]{8}-[0-9a-f-]{27}\.lock$/i.test(name)).map(name => name.slice(0, -5));
  }
  async claim(id: string): Promise<() => Promise<void>> {
    return this.claimFile(`${jobId(id)}.lock`);
  }
  async claimRebindGate():Promise<()=>Promise<void>> { return this.claimFile(".rebind.lock"); }
  async hasRebindGate():Promise<boolean> {
    try {await access(join(this.directory,".rebind.lock"));return true;}
    catch(err) {if((err as NodeJS.ErrnoException).code==="ENOENT") return false;throw err;}
  }
  private async claimFile(name:string): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, name), token = randomUUID();
    const file = await open(path, "wx", 0o600).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") throw new Error("job has a writer claim from another run; a crash claim must be inspected, never stolen automatically");
      throw err;
    });
    try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.sync(); } finally { await file.close(); }
    return async () => {
      const owner = JSON.parse(await readFile(path, "utf8"));
      if (owner.token !== token) throw new Error("job writer claim changed unexpectedly");
      await unlink(path);
    };
  }
  async hasLiveClaim(id: string): Promise<boolean> {
    try {
      const owner = JSON.parse(await readFile(join(this.directory, `${jobId(id)}.lock`), "utf8"));
      if (!Number.isInteger(owner.pid) || owner.pid < 1) return false;
      try { process.kill(owner.pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
    } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; throw err; }
  }
  async cancellation(id: string, value?: boolean): Promise<boolean> {
    const path = join(this.directory, `${jobId(id)}.cancel`);
    if (value === true) { const f = await open(path, "w", 0o600); await f.close(); return true; }
    if (value === false) { await unlink(path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; }); return false; }
    try { await access(path); return true; } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; throw err; }
  }
}
