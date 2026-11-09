// Cache disque pour les données immuables (contenus par commit, merge-base, diffstat entre deux commits,
// résumés de versions) + cache mémoire : LRU pour l'immuable, durée de vie courte pour les données vivantes.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MEMORY_LIMIT = 400;

export class Cache {
    private readonly dir: string | null;
    private readonly memory = new Map<string, unknown>();
    private readonly live = new Map<string, { at: number; value: unknown }>();
    private readonly pending = new Map<string, Promise<unknown>>();
    private readonly livePending = new Map<string, Promise<unknown>>();

    constructor(dir: string | null) {
        this.dir = dir;
        if (dir) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
    }

    private fileFor(dir: string, key: string): string {
        const hash = createHash('sha1').update(key).digest('hex');
        return path.join(dir, hash.slice(0, 2), `${hash}.json`);
    }

    private remember(key: string, value: unknown): void {
        this.memory.delete(key);
        this.memory.set(key, value);
        // Map garde l'ordre d'insertion : la première clé est la moins récemment utilisée.
        const oldest = this.memory.keys().next();
        if (this.memory.size > MEMORY_LIMIT && !oldest.done) {
            this.memory.delete(oldest.value);
        }
    }

    get<T>(key: string): T | undefined {
        if (this.memory.has(key)) {
            const value = this.memory.get(key) as T;
            this.remember(key, value);
            return value;
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
            console.warn(`revspan: écriture du cache impossible (${(error as Error).message})`);
        }
    }

    /** Oublie une entrée (mémoire et disque) : donnée « immuable » qui a disparu de Bitbucket. */
    delete(key: string): void {
        this.memory.delete(key);
        if (!this.dir) {
            return;
        }
        try {
            fs.rmSync(this.fileFor(this.dir, key), { force: true });
        } catch (error) {
            console.warn(`revspan: suppression dans le cache impossible (${(error as Error).message})`);
        }
    }

    /**
     * Calcule une seule fois une valeur immuable (requêtes concurrentes dédupliquées).
     * keep(value) = false : résultat non mémorisé (ex. 404 peut-être transitoire).
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

    /** Données vivantes (PR, activité, commentaires) : mémoire seulement, durée courte. */
    async getLive<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
        const hit = this.live.get(key);
        if (hit && Date.now() - hit.at < ttlMs) {
            return hit.value as T;
        }
        // Calculs concurrents de même clé partagés ; une erreur n'est jamais mise en cache.
        const pending = this.livePending.get(key);
        if (pending) {
            return pending as Promise<T>;
        }
        const promise = (async () => {
            try {
                const value = await compute();
                this.live.set(key, { at: Date.now(), value });
                return value;
            } finally {
                this.livePending.delete(key);
            }
        })();
        this.livePending.set(key, promise);
        return promise;
    }

    invalidateLive(prefix: string): void {
        for (const key of this.live.keys()) {
            if (key.startsWith(prefix)) {
                this.live.delete(key);
            }
        }
    }
}
