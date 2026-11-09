// Home repository list (rule shared by the server and the page).

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Normalized "workspace/repo", or null. Accepts a bitbucket.org URL (only the first two segments count). */
export function normalizeRepo(input: string): string | null {
    const segments = input.trim()
        .replace(/^https?:\/\/(www\.)?bitbucket\.org\//i, '')
        .split('/')
        .filter(Boolean)
        .slice(0, 2);
    const valid = segments.length === 2 && segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
    return valid ? segments.join('/') : null;
}

/** Splits valid entries (without duplicates) from invalid ones; empty lines are ignored. */
export function parseRepoList(entries: readonly string[]): { repos: string[]; bad: string[] } {
    const repos: string[] = [];
    const bad: string[] = [];
    for (const entry of entries) {
        if (!entry.trim()) {
            continue;
        }
        const repo = normalizeRepo(entry);
        if (repo === null) {
            bad.push(entry.trim());
        } else if (!repos.includes(repo)) {
            repos.push(repo);
        }
    }
    return { repos, bad };
}
