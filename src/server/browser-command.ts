// How the CLI opens its /open?k=<secret> address in the default browser, per platform. Process arguments can be read
// by other local users (`ps`, /proc/<pid>/cmdline), so the secret never goes into one, except on Windows, where other
// standard users cannot read another user's command line. No shell anywhere: the URL is never parsed by `cmd` or `sh`.

export interface LaunchPlan {
    command: string;
    args: string[];
    /** Written to the command's standard input (macOS: the AppleScript that opens the URL). */
    stdin?: string;
    /** File to write with mode 0600 before the launch and to delete soon after (Linux: a redirect page). */
    file?: { path: string; content: string };
}

const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);

/**
 * Printed right after the address when the browser is sent through the redirect page: a sandboxed browser (snap or
 * Flatpak, Ubuntu's default) cannot read a hidden folder of $HOME and shows a file error, while xdg-open still succeeds.
 */
export const REDIRECT_PAGE_HINT = 'If the browser shows a file error, open the address above.';

/** Local page that sends the browser to `url` at once, with a visible link if the refresh is blocked. */
function redirectPage(url: string): string {
    const href = escapeHtml(url);
    return [
        '<!doctype html>',
        '<html><head><meta charset="utf-8">',
        '<meta name="referrer" content="no-referrer">',
        `<meta http-equiv="refresh" content="0;url=${href}">`,
        '<title>Revspan</title></head>',
        `<body><p><a href="${href}">Open Revspan</a></p></body></html>`,
        '',
    ].join('\n');
}

/**
 * Plan to open `url`: macOS runs `open location` from osascript's stdin, Linux and the others xdg-open a redirect page
 * (`tempFile`, inside the private configuration folder), Windows passes the URL to explorer.exe. null: the URL cannot be
 * opened safely (it could break out of the AppleScript string, or there is no private folder for the redirect page:
 * `tempFile` null); the caller only prints it.
 */
export function launchPlan(platform: NodeJS.Platform, url: string, tempFile: string | null): LaunchPlan | null {
    if (platform === 'darwin') {
        return /["\\\r\n]/.test(url) ? null : { command: 'osascript', args: ['-'], stdin: `open location "${url}"\n` };
    }
    if (platform === 'win32') {
        return { command: 'explorer.exe', args: [url] };
    }
    return tempFile === null ? null : { command: 'xdg-open', args: [tempFile], file: { path: tempFile, content: redirectPage(url) } };
}
