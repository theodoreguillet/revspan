import { describe, expect, it } from 'vitest';
import { launchPlan } from '../../src/server/browser-command.ts';

describe('launchPlan: how the CLI opens its ?k= address, the secret never in a process argument (except Windows)', () => {
    const url = 'http://127.0.0.1:7420/open?k=abc_DEF-123&to=%23%2Fpr%2Fa%2Fb%2F1';
    const tempFile = '/home/me/.config/revspan/open-0123abcd.html';
    const argsOf = (platform: NodeJS.Platform): string[] => launchPlan(platform, url, tempFile)?.args ?? [];

    it('macOS: osascript reads `open location` on its stdin, its arguments hold no URL', () => {
        expect(launchPlan('darwin', url, tempFile)).toEqual({ command: 'osascript', args: ['-'], stdin: `open location "${url}"\n` });
        expect(argsOf('darwin').join(' ')).not.toContain('k=');
    });

    it('macOS: a URL that could break out of the AppleScript string is never run (print it instead)', () => {
        for (const bad of [`${url}"`, `${url}\\`, `${url}\n`, `${url}\r`, `${url}" & do shell script "id`]) {
            expect(launchPlan('darwin', bad, tempFile), JSON.stringify(bad)).toBeNull();
        }
    });

    it('Linux and others: xdg-open a 0600 redirect page given by its path, the URL only inside the file', () => {
        const plan = launchPlan('linux', url, tempFile);
        expect(plan).toMatchObject({ command: 'xdg-open', args: [tempFile], file: { path: tempFile } });
        expect(plan?.stdin).toBeUndefined();
        expect(argsOf('linux').join(' ')).not.toContain('k=');
        expect(launchPlan('freebsd', url, tempFile)).toMatchObject({ command: 'xdg-open', args: [tempFile] });
    });

    it('Linux redirect page: meta refresh and a visible link to the escaped URL, nothing else loaded', () => {
        const content = launchPlan('linux', url, tempFile)?.file?.content ?? '';
        const escaped = url.replace(/&/g, '&amp;');
        expect(content).toContain(`<meta http-equiv="refresh" content="0;url=${escaped}">`);
        expect(content).toContain(`<a href="${escaped}">`);
        expect(content).toContain('<meta name="referrer" content="no-referrer">');
        expect(content).not.toMatch(/<script|src=/);
        const hostile = launchPlan('linux', 'http://127.0.0.1:1/open?k="><script>x</script>', tempFile)?.file?.content ?? '';
        expect(hostile).not.toContain('<script>');
    });

    it('Windows: explorer.exe with the URL (other standard users cannot read another user\'s command line), never cmd', () => {
        expect(launchPlan('win32', url, tempFile)).toEqual({ command: 'explorer.exe', args: [url] });
    });
});
