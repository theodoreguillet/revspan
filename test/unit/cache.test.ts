import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cache } from '../../src/server/infra/cache.ts';

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-cache-'));
    dirs.push(dir);
    return dir;
};

afterEach(() => {
    vi.useRealTimers();
    dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe('Disk cache', () => {
    it('reads a written value back from disk', () => {
        const dir = tempDir();
        new Cache(dir).set('k', { a: 1 });
        expect(new Cache(dir).get('k')).toEqual({ a: 1 });
    });

    it('delete forgets an entry in memory and on disk', () => {
        const dir = tempDir();
        const cache = new Cache(dir);
        cache.set('k', { a: 1 });
        cache.set('autre', 2);
        cache.delete('k');
        expect(cache.get('k')).toBeUndefined();
        expect(new Cache(dir).get('k')).toBeUndefined();
        expect(new Cache(dir).get('autre')).toBe(2);
        expect(() => cache.delete('absente')).not.toThrow();
    });

    it('delete never throws: a failed removal is only a warning', () => {
        const dir = tempDir();
        const cache = new Cache(dir);
        cache.set('k', 1);
        // A folder in place of the entry's file: rmSync fails.
        const hash = createHash('sha1').update('k').digest('hex');
        const file = path.join(dir, hash.slice(0, 2), `${hash}.json`);
        fs.rmSync(file);
        fs.mkdirSync(file);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect(() => cache.delete('k')).not.toThrow();
            expect(warn).toHaveBeenCalledTimes(1);
            expect(cache.get('k')).toBeUndefined();
        } finally {
            warn.mockRestore();
        }
    });

    it('ignores a corrupt cache file', () => {
        const dir = tempDir();
        new Cache(dir).set('k', 1);
        const file = fs.readdirSync(dir).flatMap((sub) => fs.readdirSync(path.join(dir, sub)).map((f) => path.join(dir, sub, f)))[0] as string;
        fs.writeFileSync(file, '{pas du json');
        expect(new Cache(dir).get('k')).toBeUndefined();
    });
});

describe('Cache.getOrCompute', () => {
    it('does not memoize when keep returns false', async () => {
        const cache = new Cache(null);
        const compute = vi.fn(async () => null);
        await cache.getOrCompute('k', compute, (value) => value !== null);
        await cache.getOrCompute('k', compute, (value) => value !== null);
        expect(compute).toHaveBeenCalledTimes(2);
    });

    it('deduplicates concurrent calls', async () => {
        const cache = new Cache(null);
        const compute = vi.fn(async () => 5);
        await Promise.all([cache.getOrCompute('k', compute), cache.getOrCompute('k', compute)]);
        expect(compute).toHaveBeenCalledTimes(1);
    });
});

describe('Cache.getLive', () => {
    it('shares the computation of two concurrent calls', async () => {
        const cache = new Cache(null);
        const compute = vi.fn(async () => 'v');
        const [a, b] = await Promise.all([cache.getLive('k', 1000, compute), cache.getLive('k', 1000, compute)]);
        expect([a, b]).toEqual(['v', 'v']);
        expect(compute).toHaveBeenCalledTimes(1);
    });

    it('does not cache an error', async () => {
        const cache = new Cache(null);
        const compute = vi.fn<() => Promise<string>>()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce('ok');
        await expect(cache.getLive('k', 1000, compute)).rejects.toThrow('boom');
        await expect(cache.getLive('k', 1000, compute)).resolves.toBe('ok');
        expect(compute).toHaveBeenCalledTimes(2);
    });

    it('honors the TTL', async () => {
        vi.useFakeTimers();
        const cache = new Cache(null);
        const compute = vi.fn(async () => 'v');
        await cache.getLive('k', 1000, compute);
        await cache.getLive('k', 1000, compute);
        expect(compute).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1001);
        await cache.getLive('k', 1000, compute);
        expect(compute).toHaveBeenCalledTimes(2);
    });

    it('invalidateLive clears the keys with the prefix', async () => {
        const cache = new Cache(null);
        const compute = vi.fn(async () => 'v');
        await cache.getLive('live:a:1', 1000, compute);
        await cache.getLive('live:b:1', 1000, compute);
        cache.invalidateLive('live:a:');
        await cache.getLive('live:a:1', 1000, compute);
        await cache.getLive('live:b:1', 1000, compute);
        expect(compute).toHaveBeenCalledTimes(3);
    });
});

describe('Memory budget', () => {
    it('evicts the least recently used entries beyond the byte budget', () => {
        const cache = new Cache(null, { memoryBytes: 1000 });
        cache.set('a', 'x'.repeat(200));
        cache.set('b', 'y'.repeat(200));
        cache.set('c', 'z'.repeat(200));
        expect([cache.get('a'), cache.get('b') === undefined, cache.get('c') === undefined]).toEqual([undefined, false, false]);
    });

    it('a recent hit protects an entry', () => {
        const cache = new Cache(null, { memoryBytes: 1000 });
        cache.set('a', 'x'.repeat(200));
        cache.set('b', 'y'.repeat(200));
        cache.get('a');
        cache.set('c', 'z'.repeat(200));
        expect([cache.get('a') === undefined, cache.get('b'), cache.get('c') === undefined]).toEqual([false, undefined, false]);
    });

    it('does not keep in memory a value bigger than the budget, but still writes it to disk', () => {
        const dir = tempDir();
        const cache = new Cache(dir, { memoryBytes: 100 });
        cache.set('big', 'x'.repeat(500));
        const files = fs.readdirSync(dir).flatMap((d) => fs.readdirSync(path.join(dir, d)));
        expect(files).toHaveLength(1);
        expect(cache.get('big')).toBe('x'.repeat(500));
    });

    it('estimates objects through their JSON size', () => {
        const cache = new Cache(null, { memoryBytes: 1000 });
        const obj = (c: string) => ({ t: c.repeat(300) });
        cache.set('a', obj('a'));
        cache.set('b', obj('b'));
        expect([cache.get('a'), cache.get('b') === undefined]).toEqual([undefined, false]);
    });
});

describe('evictDisk', () => {
    const DAY = 24 * 3600 * 1000;
    const NOW = Date.parse('2026-06-01T00:00:00Z');
    const put = (dir: string, name: string, size: number, ageDays: number): string => {
        const sub = path.join(dir, name.slice(0, 2));
        fs.mkdirSync(sub, { recursive: true });
        const file = path.join(sub, `${name}.json`);
        fs.writeFileSync(file, 'x'.repeat(size));
        const t = new Date(NOW - ageDays * DAY);
        fs.utimesSync(file, t, t);
        return file;
    };

    it('removes files older than maxAgeDays', async () => {
        const dir = tempDir();
        const old = put(dir, 'aa01', 10, 40);
        const fresh = put(dir, 'bb02', 10, 1);
        expect(await new Cache(dir).evictDisk({ now: NOW })).toEqual({ removed: 1 });
        expect([fs.existsSync(old), fs.existsSync(fresh)]).toEqual([false, true]);
    });

    it('then removes the oldest until under maxBytes', async () => {
        const dir = tempDir();
        const a = put(dir, 'aa01', 100, 10);
        const b = put(dir, 'bb02', 100, 5);
        const c = put(dir, 'cc03', 100, 1);
        expect(await new Cache(dir).evictDisk({ now: NOW, maxBytes: 250 })).toEqual({ removed: 1 });
        expect([a, b, c].map((f) => fs.existsSync(f))).toEqual([false, true, true]);
    });

    it('skips when stamped less than 24 h ago, runs again after', async () => {
        const dir = tempDir();
        const cache = new Cache(dir);
        await cache.evictDisk({ now: NOW });
        const old = put(dir, 'aa01', 10, 40);
        expect(await cache.evictDisk({ now: NOW + DAY / 2 })).toEqual({ removed: 0 });
        expect(fs.existsSync(old)).toBe(true);
        expect(await cache.evictDisk({ now: NOW + DAY + 1 })).toEqual({ removed: 1 });
    });

    it('is a no-op without a disk directory', async () => {
        expect(await new Cache(null).evictDisk({ now: NOW })).toEqual({ removed: 0 });
    });
});
