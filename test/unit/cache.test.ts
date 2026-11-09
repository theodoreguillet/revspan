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
