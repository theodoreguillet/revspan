// Disk cache for immutable data (contents per commit, merge-base, diffstat between two commits,
// version summaries) + in-memory cache: LRU for immutable data, short lifetime for live data.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MEMORY_BYTES = 256 * 1024 * 1024;
const DAY_MS = 24 * 3600 * 1000;
const EVICT_STAMP = 'last-evict';

/** Approximate size in memory, computed once at insertion. */
function sizeOf(value: unknown): number {
    if (typeof value === 'string') {
        return value.length * 2;
    }
    try {
        return (JSON.stringify(value) ?? '').length * 2;
    } catch {
        return 0;
    }
}

export class Cache {
    private readonly dir: string | null;
    private readonly memory = new Map<string, { value: unknown; size: number }>();
    private readonly memoryBytes: number;
    private memoryUsed = 0;
    private readonly live = new Map<string, { at: number; value: unknown }>();
    private readonly pending = new Map<string, Promise<unknown>>();
    private readonly livePending = new Map<string, Promise<unknown>>();

    constructor(dir: string | null, { memoryBytes = DEFAULT_MEMORY_BYTES }: { memoryBytes?: number } = {}) {
        this.dir = dir;
        this.memoryBytes = memoryBytes;
        if (dir) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
    }

    private fileFor(dir: string, key: string): string {
        const hash = createHash('sha1').update(key).digest('hex');
        return path.join(dir, hash.slice(0, 2), `${hash}.json`);
    }

    private forget(key: string): void {
        const entry = this.memory.get(key);
        if (entry) {
            this.memoryUsed -= entry.size;
            this.memory.delete(key);
        }
    }

    private remember(key: string, value: unknown): void {
        this.forget(key);
        const size = sizeOf(value);
        // Bigger than the whole budget: not kept in memory (it stays on disk).
        if (size > this.memoryBytes) {
            return;
        }
        this.memory.set(key, { value, size });
        this.memoryUsed += size;
        // Map keeps insertion order: the first key is the least recently used.
        for (const oldest of this.memory.keys()) {
            if (this.memoryUsed <= this.memoryBytes) {
                break;
            }
            this.forget(oldest);
        }
    }

    get<T>(key: string): T | undefined {
        if (this.memory.has(key)) {
            const entry = this.memory.get(key)!;
            // Refresh the recency without recomputing the size.
            this.memory.delete(key);
            this.memory.set(key, entry);
            return entry.value as T;
        }
        if (!this.dir) {
            return undefined;
        }
        try {
            const value = (JSON.parse(fs.readFileSync(this.fileFor(this.dir, key), 'utf8')) as { v: T }).v;
            this.remember(key, value);
            return value;
        } catch {
            return undefined;
        }
    }

    set(key: string, value: unknown): void {
        this.remember(key, value);
        if (!this.dir) {
            return;
        }
        const file = this.fileFor(this.dir, key);
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ k: key, v: value }), { mode: 0o600 });
            fs.renameSync(tmp, file);
        } catch (error) {
            console.warn(`revspan: cannot write the cache (${(error as Error).message})`);
        }
    }

    /** Forgets an entry (memory and disk): "immutable" data that disappeared from Bitbucket. */
    delete(key: string): void {
        this.forget(key);
        if (!this.dir) {
            return;
        }
        try {
            fs.rmSync(this.fileFor(this.dir, key), { force: true });
        } catch (error) {
            console.warn(`revspan: cannot delete from the cache (${(error as Error).message})`);
        }
    }

    /**
     * Trims the disk cache: files older than maxAgeDays, then the oldest until under maxBytes.
     * Runs at most once per day (stamp file in the cache directory).
     */
    async evictDisk({ maxAgeDays = 30, maxBytes = 1024 ** 3, now = Date.now() }: { maxAgeDays?: number; maxBytes?: number; now?: number } = {}): Promise<{ removed: number }> {
        const dir = this.dir;
        if (!dir) {
            return { removed: 0 };
        }
        const stamp = path.join(dir, EVICT_STAMP);
        try {
            if (now - (await fsp.stat(stamp)).mtimeMs < DAY_MS) {
                return { removed: 0 };
            }
        } catch {
            // No stamp yet.
        }
        const files: { file: string; size: number; mtime: number }[] = [];
        for (const sub of await fsp.readdir(dir, { withFileTypes: true })) {
            if (!sub.isDirectory()) {
                continue;
            }
            const subDir = path.join(dir, sub.name);
            for (const name of await fsp.readdir(subDir)) {
                try {
                    const file = path.join(subDir, name);
                    const info = await fsp.stat(file);
                    if (info.isFile()) {
                        files.push({ file, size: info.size, mtime: info.mtimeMs });
                    }
                } catch {
                    // Vanished meanwhile.
                }
            }
        }
        files.sort((a, b) => a.mtime - b.mtime);
        let total = files.reduce((sum, f) => sum + f.size, 0);
        let removed = 0;
        for (const f of files) {
            if (now - f.mtime <= maxAgeDays * DAY_MS && total <= maxBytes) {
                break;
            }
            try {
                await fsp.rm(f.file, { force: true });
                total -= f.size;
                removed++;
            } catch {
                // Kept: retried at the next run.
            }
        }
        await fsp.writeFile(stamp, String(now), { mode: 0o600 });
        await fsp.utimes(stamp, new Date(now), new Date(now));
        return { removed };
    }

    /**
     * Computes an immutable value only once (concurrent requests deduplicated).
     * keep(value) = false: result not memoized (e.g. a possibly transient 404).
     */
    async getOrCompute<T>(key: string, compute: () => Promise<T>, keep: (value: T) => boolean = () => true): Promise<T> {
        const cached = this.get<T>(key);
        if (cached !== undefined) {
            return cached;
        }
        const pending = this.pending.get(key);
        if (pending) {
            return pending as Promise<T>;
        }
        const promise = (async () => {
            try {
                const value = await compute();
                if (keep(value)) {
                    this.set(key, value);
                }
                return value;
            } finally {
                this.pending.delete(key);
            }
        })();
        this.pending.set(key, promise);
        return promise;
    }

    /** Live data (PR, activity, comments): memory only, short lifetime. */
    async getLive<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
        const hit = this.live.get(key);
        if (hit && Date.now() - hit.at < ttlMs) {
            return hit.value as T;
        }
        // Concurrent computations with the same key are shared; an error is never cached.
        const pending = this.livePending.get(key);
        if (pending) {
            return pending as Promise<T>;
        }
        const own: { promise?: Promise<T> } = {};
        const promise = (async () => {
            try {
                const value = await compute();
                // Invalidated while in flight (the slot was dropped): the value predates the invalidation, never keep it.
                if (this.livePending.get(key) === own.promise) {
                    this.live.set(key, { at: Date.now(), value });
                }
                return value;
            } finally {
                if (this.livePending.get(key) === own.promise) {
                    this.livePending.delete(key);
                }
            }
        })();
        own.promise = promise;
        this.livePending.set(key, promise);
        return promise;
    }

    invalidateLive(prefix: string): void {
        for (const key of this.live.keys()) {
            if (key.startsWith(prefix)) {
                this.live.delete(key);
            }
        }
        // In-flight reads started before the invalidation must not be joined by later reads, nor stored.
        for (const key of this.livePending.keys()) {
            if (key.startsWith(prefix)) {
                this.livePending.delete(key);
            }
        }
    }
}
