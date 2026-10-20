// Global ChatGPT request intent shared by every session. Separate from shared mod settings and native Claude Fast.
// The legacy per-session API stays as an alias of the one global setting.
// Acknowledgements follow the atomic save, so the bar never claims an unsaved choice is active.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_SESSIONS = 2048;
const MAX_BYTES = 1024 * 1024;

export type FastSnapshot = { scope: "global"; fast: boolean | null; revision: number };

// Node cannot sync directory handles on Windows. Elsewhere, flush the rename when the filesystem
// supports it; a directory-sync failure after commit must not falsely report an unchanged choice.
function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(directory, "r");
    try { fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch { /* directory flushing is best-effort; the file itself was synced before commit */ }
}

export function validFastSession(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,128}$/.test(value);
}

export class SessionFastInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export class SessionFastStore {
  private readonly file: string;
  private fast: boolean | null = null;
  private revision = 0;
  // True while the in-memory value came from a version 1 file that has not been rewritten yet.
  private legacy = false;
  private loadError = false;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  private load(): void {
    const file = this.file;
    try {
      if (fs.statSync(file).size > MAX_BYTES) throw new Error("Fast file too large");
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown; revision?: unknown; fast?: unknown; entries?: unknown } | null;
      if (!data || typeof data !== "object" || typeof data.revision !== "number" || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error("invalid Fast file");
      let fast: boolean | null;
      let legacy = false;
      if (data.version === 2) {
        if (data.fast !== null && typeof data.fast !== "boolean") throw new Error("invalid Fast value");
        fast = data.fast;
      } else if (data.version === 1) {
        if (!Array.isArray(data.entries) || data.entries.length > MAX_SESSIONS) throw new Error("invalid Fast file");
        const seen = new Set<string>();
        const values = new Set<boolean>();
        for (const row of data.entries as unknown[]) {
          if (!Array.isArray(row) || row.length !== 2 || !validFastSession(row[0]) || typeof row[1] !== "boolean" || seen.has(row[0])) throw new Error("invalid Fast entry");
          seen.add(row[0]);
          values.add(row[1]);
        }
        // Unanimous explicit choices carry over; empty or mixed ones fall back to auto.
        fast = values.size === 1 ? [...values][0]! : null;
        legacy = true;
      } else throw new Error("invalid Fast file");
      this.fast = fast;
      this.revision = data.revision;
      this.legacy = legacy;
      this.loadError = false;
    } catch (error) {
      this.loadError = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  // An unavailable control must not break model calls or infer Fast. The API reports the error.
  getGlobal(): boolean | null {
    if (this.loadError) this.load();
    return !this.loadError ? this.fast : null;
  }

  // Legacy per-session lookup: every session, valid id or not, sees the one global setting.
  get(_session?: unknown): boolean | null {
    return this.getGlobal();
  }

  snapshotGlobal(): FastSnapshot {
    if (this.loadError) this.load();
    if (this.loadError) throw new Error("Fast settings could not be read; the file was not modified");
    return { scope: "global", fast: this.fast, revision: this.revision };
  }

  snapshot(session: unknown): FastSnapshot & { session: string } {
    if (!validFastSession(session)) throw new SessionFastInputError("invalid session id");
    return { session, ...this.snapshotGlobal() };
  }

  set(session: unknown, fast: unknown): FastSnapshot & { session: string } {
    if (!validFastSession(session)) throw new SessionFastInputError("invalid session id");
    return { session, ...this.setGlobal(fast) };
  }

  setGlobal(fast: unknown): FastSnapshot {
    const before = this.snapshotGlobal();
    if (fast !== null && typeof fast !== "boolean") throw new SessionFastInputError("fast must be true, false, or null");
    if (before.fast === fast && !this.legacy) return before;
    if (this.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Fast revision limit reached");
    const revision = this.revision + 1;
    const data = JSON.stringify({ version: 2, revision, fast }) + "\n";
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let created = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(temporary, "wx", 0o600);
      created = true;
      try {
        fs.writeFileSync(fd, data, "utf8");
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      syncDirectory(path.dirname(this.file));
    } catch {
      throw new Error("Unable to save Fast settings; the previous choice is unchanged");
    } finally {
      if (created) {
        try { fs.unlinkSync(temporary); }
        catch { /* renamed, or already removed */ }
      }
    }
    this.fast = fast;
    this.revision = revision;
    this.legacy = false;
    return { scope: "global", fast, revision };
  }
}

const stores = new Map<string, SessionFastStore>();

export function getSessionFastStore(home: string): SessionFastStore {
  const file = path.resolve(home, "session-fast.json");
  let store = stores.get(file);
  if (!store) {
    store = new SessionFastStore(file);
    stores.set(file, store);
  }
  return store;
}
