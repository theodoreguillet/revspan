// Bitbucket PR URL -> PR reference (rule shared by the server and the page).
import type { PrRef } from './api.ts';
import { isSlug } from './pr-ref.ts';

const PR_URL = /^\s*(?:https?:\/\/)?(?:www\.)?bitbucket\.org\/([^/\s?#]+)\/([^/\s?#]+)\/pull-requests\/(\d+)(?:[/?#]\S*)?\s*$/i;

/** "https://bitbucket.org/<ws>/<repo>/pull-requests/<id>[/...]" -> { workspace, repo, id } or null. */
export function parsePrUrl(input: string | null | undefined): PrRef | null {
    const match = PR_URL.exec(input ?? '');
    if (!match) {
        return null;
    }
    try {
        const ref = { workspace: decodeURIComponent(match[1] ?? ''), repo: decodeURIComponent(match[2] ?? ''), id: Number(match[3]) };
        return isSlug(ref.workspace) && isSlug(ref.repo) && Number.isSafeInteger(ref.id) && ref.id > 0 ? ref : null;
    } catch {
        return null;
    }
}
