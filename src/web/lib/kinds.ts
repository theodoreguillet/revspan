// Types de versions (résumé) et table d'accès par index.
import type { Summary, VersionKind, VersionSummary } from '../../shared/api.ts';

export type SummaryMap = Map<number, VersionSummary>;

export const MUTED_KINDS: ReadonlySet<VersionKind> = new Set(['deps', 'rebase-only', 'message-only', 'none', 'unavailable']);
export const CODE_KINDS: ReadonlySet<VersionKind> = new Set(['code', 'creation']);
/** Versions sans aucun changement de l'auteur (réapprobation rapide possible). */
export const TRIVIAL_KINDS: ReadonlySet<VersionKind> = new Set(['rebase-only', 'none', 'message-only']);

export const KIND_LABELS: Record<VersionKind, string> = {
    creation: 'création',
    code: 'code',
    deps: 'deps',
    'rebase-only': 'rebase seul',
    'message-only': 'message',
    none: 'rien',
    unavailable: 'indisponible',
};

export function summaryMap(summary: Summary | null | undefined): SummaryMap {
    const map: SummaryMap = new Map();
    for (const s of summary?.versions ?? []) {
        map.set(s.index, s);
    }
    return map;
}

export function isMuted(sum: VersionSummary | undefined): boolean {
    return !!sum && MUTED_KINDS.has(sum.kind);
}

export function isCode(sum: VersionSummary | undefined): boolean {
    return !!sum && CODE_KINDS.has(sum.kind);
}
