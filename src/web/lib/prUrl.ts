// Navigation vers une PR (l'analyse des URL Bitbucket est dans src/shared/pr-url.ts).
import type { PrRef } from '../../shared/api.ts';

/** Emplacement de route de la page PR (route nommée « pr » de router.ts). */
export function prRoute(ref: PrRef, query?: Record<string, string>): { name: 'pr'; params: Record<string, string>; query?: Record<string, string> } {
    return { name: 'pr', params: { ws: ref.workspace, repo: ref.repo, id: String(ref.id) }, ...(query ? { query } : {}) };
}
