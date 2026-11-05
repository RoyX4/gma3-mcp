import { mkdir, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Journal, jobId } from "../jobs/journal.js";

/** Publish a complete immutable record with an atomic, create-only hard link. Never replace an existing ID. */
export class CheckpointStore extends Journal {
  async create<T>(value: T): Promise<string> {
    const id = randomUUID(), text = JSON.stringify({ ...value, id }, null, 2);
    if (Buffer.byteLength(text, "utf8") > 32 * 1024 * 1024) throw new Error("checkpoint exceeds the 32 MiB bound; reduce its explicit scope");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${jobId(id)}.json`), temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(text, "utf8"); await file.sync(); } finally { await file.close(); }
    try { await link(temp, path); } finally { await unlink(temp); }
    const directory = await open(this.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return id;
  }
}
