import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIRECT_PAGE_HINT } from '../../src/server/browser-command.ts';
import { isPrivateFolder } from '../../src/server/infra/ownership.ts';
import { showAndOpen, type OpenDeps } from '../../src/server/open-browser.ts';

const URL_K = 'http://127.0.0.1:7420/open?k=abc_DEF-123&to=%23%2F';
const FALLBACK = `Open ${URL_K} in your browser.`;
const uid = process.getuid?.() ?? null;

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revspan-open-'));
    dirs.push(dir);
    return dir;
};
const pages = (dir: string): string[] => fs.readdirSync(dir).filter((name) => name.endsWith('.html'));

/** Child process stand-in: records stdin, emits error/exit on demand. */
class FakeChild extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly written: string[] = [];
    constructor() {
        super();
        this.stdin.on('data', (chunk: Buffer) => this.written.push(chunk.toString()));
    }
    unref(): void {
        // nothing to do
    }
}

interface Harness {
    deps: Partial<OpenDeps>;
    logs: string[];
    spawned: { command: string; args: readonly string[] }[];
    children: FakeChild[];
    exitHooks: (() => void)[];
}

function harness(platform: NodeJS.Platform, { spawnThrows = false } = {}): Harness {
    const h: Harness = { deps: {}, logs: [], spawned: [], children: [], exitHooks: [] };
    h.deps = {
        platform,
        uid,
        fileMs: 10_000,
        log: (line) => h.logs.push(line),
        onExit: (cleanup) => h.exitHooks.push(cleanup),
        spawn: (command, args) => {
            if (spawnThrows) {
                throw new Error('spawn failed');
            }
            h.spawned.push({ command, args });
            const child = new FakeChild();
            h.children.push(child);
            return child as unknown as ChildProcess;
        },
    };
    return h;
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) {
        fs.chmodSync(dir, 0o700);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('private folder (where the Linux redirect page may be written)', () => {
    it('owned by this user and writable by nobody else: yes; otherwise, missing or a file: no', () => {
        const dir = tempDir();
        expect(isPrivateFolder(dir, uid)).toBe(true);
        fs.chmodSync(dir, 0o755);
        expect(isPrivateFolder(dir, uid)).toBe(true);
        for (const mode of [0o770, 0o707, 0o777, 0o730]) {
            fs.chmodSync(dir, mode);
            expect(isPrivateFolder(dir, uid), mode.toString(8)).toBe(false);
        }
        fs.chmodSync(dir, 0o700);
        if (uid !== null) {
            expect(isPrivateFolder(dir, uid + 1)).toBe(false);
        }
        expect(isPrivateFolder(path.join(dir, 'missing'), uid)).toBe(false);
        fs.writeFileSync(path.join(dir, 'file'), '');
        expect(isPrivateFolder(path.join(dir, 'file'), uid)).toBe(false);
        // Without a uid (Windows), only "is a folder" applies.
        fs.chmodSync(dir, 0o777);
        expect(isPrivateFolder(dir, null)).toBe(true);
    });
});

describe('showAndOpen: prints the address, opens the browser without the secret in any argument', () => {
    it('Linux: a 0600 redirect page in the private folder, xdg-open given its path, the hint right after the address', () => {
        const dir = tempDir();
        const h = harness('linux');
        showAndOpen('Revspan: ', URL_K, dir, true, h.deps);
        const [page] = pages(dir);
        expect(page).toMatch(/^open-[0-9a-f]{16}\.html$/);
        const file = path.join(dir, page ?? '');
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(file, 'utf8')).toContain(URL_K.replace(/&/g, '&amp;'));
        expect(h.spawned).toEqual([{ command: 'xdg-open', args: [file] }]);
        expect(h.logs).toEqual([`Revspan: ${URL_K}`, REDIRECT_PAGE_HINT]);
        expect(REDIRECT_PAGE_HINT).toBe('If the browser shows a file error, open the address above.');

        vi.advanceTimersByTime(9_999);
        expect(pages(dir)).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(pages(dir)).toHaveLength(0);
        expect(h.exitHooks).toHaveLength(1);
        expect(() => h.exitHooks[0]?.()).not.toThrow();
    });

    it('Linux: a folder that is not private gets no page; the address is printed, the browser is not launched', () => {
        const dir = tempDir();
        fs.chmodSync(dir, 0o770);
        const h = harness('linux');
        showAndOpen('Revspan: ', URL_K, dir, true, h.deps);
        expect(pages(dir)).toHaveLength(0);
        expect(h.spawned).toEqual([]);
        expect(h.logs).toEqual([`Revspan: ${URL_K}`, FALLBACK]);
    });

    it('Linux: a page that cannot be removed (EACCES) never throws, from the timer or at exit', () => {
        const dir = tempDir();
        const h = harness('linux');
        showAndOpen('Revspan: ', URL_K, dir, true, h.deps);
        fs.chmodSync(dir, 0o500);
        expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
        expect(() => h.exitHooks[0]?.()).not.toThrow();
        fs.chmodSync(dir, 0o700);
    });

    it('--no-open: only the address line, nothing written or launched', () => {
        const dir = tempDir();
        const h = harness('linux');
        showAndOpen('Revspan is already running: ', URL_K, dir, false, h.deps);
        expect(h.logs).toEqual([`Revspan is already running: ${URL_K}`]);
        expect(h.spawned).toEqual([]);
        expect(pages(dir)).toHaveLength(0);
    });

    it('macOS: osascript - with `open location` on stdin, no page, no hint', () => {
        const dir = tempDir();
        const h = harness('darwin');
        showAndOpen('Revspan: ', URL_K, dir, true, h.deps);
        expect(h.spawned).toEqual([{ command: 'osascript', args: ['-'] }]);
        expect(h.children[0]?.written.join('')).toBe(`open location "${URL_K}"\n`);
        expect(h.logs).toEqual([`Revspan: ${URL_K}`]);
        expect(pages(dir)).toHaveLength(0);
    });

    it('the "Open … in your browser" fallback is printed once, whatever fails (stdin error, then exit code)', () => {
        const h = harness('darwin');
        showAndOpen('Revspan: ', URL_K, tempDir(), true, h.deps);
        const child = h.children[0];
        child?.stdin.emit('error', new Error('EPIPE'));
        child?.emit('exit', 1);
        child?.emit('error', new Error('again'));
        expect(h.logs).toEqual([`Revspan: ${URL_K}`, FALLBACK]);
    });

    it('a spawn that throws prints the fallback once', () => {
        const h = harness('darwin', { spawnThrows: true });
        showAndOpen('Revspan: ', URL_K, tempDir(), true, h.deps);
        expect(h.logs).toEqual([`Revspan: ${URL_K}`, FALLBACK]);
    });

    it('Windows: explorer.exe exits with 1 even when it worked: no fallback for that', () => {
        const h = harness('win32');
        showAndOpen('Revspan: ', URL_K, tempDir(), true, h.deps);
        expect(h.spawned).toEqual([{ command: 'explorer.exe', args: [URL_K] }]);
        h.children[0]?.emit('exit', 1);
        expect(h.logs).toEqual([`Revspan: ${URL_K}`]);
    });
});
