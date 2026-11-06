// Liste des dépôts de l'accueil (règle commune au serveur et à la page).

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** « workspace/dépôt » normalisé, ou null. Accepte une URL bitbucket.org (seuls les deux premiers segments comptent). */
export function normalizeRepo(input: string): string | null {
    const segments = input.trim()
        .replace(/^https?:\/\/(www\.)?bitbucket\.org\//i, '')
        .split('/')
        .filter(Boolean)
        .slice(0, 2);
    const valid = segments.length === 2 && segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
    return valid ? segments.join('/') : null;
}

/** Sépare les entrées valides (sans doublon) des invalides ; les lignes vides sont ignorées. */
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
