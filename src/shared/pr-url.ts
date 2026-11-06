// URL de PR Bitbucket → référence de PR (règle commune au serveur et à la page).
import type { PrRef } from './api.ts';

const PR_URL = /^\s*(?:https?:\/\/)?(?:www\.)?bitbucket\.org\/([^/\s?#]+)\/([^/\s?#]+)\/pull-requests\/(\d+)(?:[/?#]\S*)?\s*$/i;

/** « https://bitbucket.org/<ws>/<repo>/pull-requests/<id>[/…] » → { workspace, repo, id } ou null. */
export function parsePrUrl(input: string | null | undefined): PrRef | null {
    const match = PR_URL.exec(input ?? '');
    if (!match) {
        return null;
    }
    try {
        return { workspace: decodeURIComponent(match[1] ?? ''), repo: decodeURIComponent(match[2] ?? ''), id: Number(match[3]) };
    } catch {
        return null;
    }
}
