import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunFile, removeRunFile, writeRunFile } from '../../src/server/infra/run-file.ts';

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-run-'));
    dirs.push(dir);
    return dir;
};
const runFile = (dir: string): string => path.join(dir, 'run.json');

afterEach(() => {
    dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe('run file of the CLI (port + secret of the running instance)', () => {
    it('written with mode 0600, read back as written', () => {
        const dir = tempDir();
        writeRunFile(dir, { port: 7420, secret: 'abc_DEF-123', pid: 4242 });
        expect(fs.statSync(runFile(dir)).mode & 0o777).toBe(0o600);
        expect(readRunFile(dir)).toEqual({ port: 7420, secret: 'abc_DEF-123', pid: 4242 });
    });

    it('a rewrite replaces the file atomically and keeps mode 0600, even over a wider file', () => {
        const dir = tempDir();
        fs.writeFileSync(runFile(dir), '{}', { mode: 0o644 });
        writeRunFile(dir, { port: 7421, secret: 'second', pid: 1 });
        expect(fs.statSync(runFile(dir)).mode & 0o777).toBe(0o600);
        expect(readRunFile(dir)).toEqual({ port: 7421, secret: 'second', pid: 1 });
        expect(fs.readdirSync(dir)).toEqual(['run.json']);
    });

    it('creates the configuration folder if needed', () => {
        const dir = path.join(tempDir(), 'nested', 'revspan');
        writeRunFile(dir, { port: 7420, secret: 's', pid: 1 });
        expect(readRunFile(dir)).toEqual({ port: 7420, secret: 's', pid: 1 });
    });

    it('null on a missing file, garbage or a wrong shape', () => {
        const dir = tempDir();
        expect(readRunFile(dir)).toBeNull();
        const invalid = [
            'not json', 'null', '[]', '"x"', '{}',
            JSON.stringify({ port: '7420', secret: 's', pid: 1 }),
            JSON.stringify({ port: 0, secret: 's', pid: 1 }),
            JSON.stringify({ port: 70000, secret: 's', pid: 1 }),
            JSON.stringify({ port: 7420.5, secret: 's', pid: 1 }),
            JSON.stringify({ port: 7420, secret: '', pid: 1 }),
            JSON.stringify({ port: 7420, secret: 42, pid: 1 }),
            JSON.stringify({ port: 7420, secret: 's', pid: 0 }),
            JSON.stringify({ port: 7420, secret: 's', pid: -1 }),
            JSON.stringify({ port: 7420, secret: 's' }),
        ];
        for (const text of invalid) {
            fs.writeFileSync(runFile(dir), text);
            expect(readRunFile(dir), text).toBeNull();
        }
    });

    it('ignored when another user owns it or when group or others may write it (POSIX)', () => {
        const dir = tempDir();
        writeRunFile(dir, { port: 7420, secret: 's', pid: 1 });
        const owner = fs.statSync(runFile(dir)).uid;
        expect(readRunFile(dir, owner)).not.toBeNull();
        expect(readRunFile(dir, owner + 1)).toBeNull();
        for (const mode of [0o620, 0o602, 0o622, 0o666]) {
            fs.chmodSync(runFile(dir), mode);
            expect(readRunFile(dir, owner), mode.toString(8)).toBeNull();
        }
        // Readable by others is not a trust problem (the file is written 0600 anyway); only writes are.
        fs.chmodSync(runFile(dir), 0o644);
        expect(readRunFile(dir, owner)).not.toBeNull();
        // Without a uid (Windows), neither check applies.
        fs.chmodSync(runFile(dir), 0o666);
        expect(readRunFile(dir, null)).not.toBeNull();
    });

    it('a directory named run.json is not a run file', () => {
        const dir = tempDir();
        fs.mkdirSync(runFile(dir));
        expect(readRunFile(dir)).toBeNull();
    });

    it('removed only by the process it names: another instance\'s file stays', () => {
        const dir = tempDir();
        writeRunFile(dir, { port: 7420, secret: 's', pid: 1111 });
        removeRunFile(dir, 2222);
        expect(readRunFile(dir)).not.toBeNull();
        removeRunFile(dir, 1111);
        expect(fs.existsSync(runFile(dir))).toBe(false);
        // Missing file or garbage: nothing to do, no exception.
        expect(() => removeRunFile(dir, 1111)).not.toThrow();
        writeRunFile(dir, { port: 7420, secret: 's', pid: process.pid });
        removeRunFile(dir);
        expect(fs.existsSync(runFile(dir))).toBe(false);
    });
});
