// Navigation to a PR (parsing of Bitbucket URLs is in src/shared/pr-url.ts).
import type { PrRef } from '../../shared/api.ts';

/** Route location of the PR page (route named "pr" in router.ts). */
export function prRoute(ref: PrRef, query?: Record<string, string>): { name: 'pr'; params: Record<string, string>; query?: Record<string, string> } {
    return { name: 'pr', params: { ws: ref.workspace, repo: ref.repo, id: String(ref.id) }, ...(query ? { query } : {}) };
}
