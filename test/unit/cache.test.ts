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

describe('Cache disque', () => {
    it('relit une valeur écrite depuis le disque', () => {
        const dir = tempDir();
        new Cache(dir).set('k', { a: 1 });
        expect(new Cache(dir).get('k')).toEqual({ a: 1 });
    });

    it('delete oublie une entrée en mémoire et sur disque', () => {
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

    it('delete ne lève jamais : suppression impossible = simple avertissement', () => {
        const dir = tempDir();
        const cache = new Cache(dir);
        cache.set('k', 1);
        // Un dossier à la place du fichier de l'entrée : rmSync échoue.
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

    it('ignore un fichier de cache corrompu', () => {
        const dir = tempDir();
        new Cache(dir).set('k', 1);
        const file = fs.readdirSync(dir).flatMap((sub) => fs.readdirSync(path.join(dir, sub)).map((f) => path.join(dir, sub, f)))[0] as string;
        fs.writeFileSync(file, '{pas du json');
        expect(new Cache(dir).get('k')).toBeUndefined();
    });
});

describe('Cache.getOrCompute', () => {
    it('ne mémorise pas quand keep renvoie false', async () => {
        const cache = new Cache(null);
        const compute = vi.fn(async () => null);
        await cache.getOrCompute('k', compute, (value) => value !== null);
        await cache.getOrCompute('k', compute, (value) => value !== null);
        expect(compute).toHaveBeenCalledTimes(2);
    });

    it('déduplique les appels concurrents', async () => {
        const cache = new Cache(null);
        const compute = vi.fn(async () => 5);
        await Promise.all([cache.getOrCompute('k', compute), cache.getOrCompute('k', compute)]);
        expect(compute).toHaveBeenCalledTimes(1);
    });
});

describe('Cache.getLive', () => {
    it('partage le calcul de deux appels concurrents', async () => {
        const cache = new Cache(null);
        const compute = vi.fn(async () => 'v');
        const [a, b] = await Promise.all([cache.getLive('k', 1000, compute), cache.getLive('k', 1000, compute)]);
        expect([a, b]).toEqual(['v', 'v']);
        expect(compute).toHaveBeenCalledTimes(1);
    });

    it('ne met pas une erreur en cache', async () => {
        const cache = new Cache(null);
        const compute = vi.fn<() => Promise<string>>()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce('ok');
        await expect(cache.getLive('k', 1000, compute)).rejects.toThrow('boom');
        await expect(cache.getLive('k', 1000, compute)).resolves.toBe('ok');
        expect(compute).toHaveBeenCalledTimes(2);
    });

    it('respecte le TTL', async () => {
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

    it('invalidateLive efface les clés au préfixe', async () => {
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
