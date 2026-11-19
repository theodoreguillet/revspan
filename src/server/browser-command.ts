// Command that opens a URL in the default browser, per platform (no shell: the URL is never parsed by `cmd`).

export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
    if (platform === 'darwin') {
        return ['open', [url]];
    }
    return platform === 'win32' ? ['explorer.exe', [url]] : ['xdg-open', [url]];
}
