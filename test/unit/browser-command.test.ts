import { describe, expect, it } from 'vitest';
import { browserCommand } from '../../src/server/browser-command.ts';

describe('browserCommand', () => {
    const url = 'http://127.0.0.1:1/#/pr/a/b/1';

    it('opens with explorer.exe on Windows, never through cmd', () => {
        expect(browserCommand('win32', url)).toEqual(['explorer.exe', [url]]);
    });

    it('opens with open on macOS', () => {
        expect(browserCommand('darwin', url)).toEqual(['open', [url]]);
    });

    it('opens with xdg-open elsewhere', () => {
        expect(browserCommand('linux', url)).toEqual(['xdg-open', [url]]);
    });
});
