// Types de versions (résumé), table d'accès par index et cohérence entre le résumé et le détail de la PR.
import type { Summary, Version, VersionKind, VersionSummary } from '../../shared/api.ts';

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

/** La liste des versions a changé (version poussée pendant la lecture, version remplacée) : résumé à recharger. */
export function versionsChanged(before: readonly Pick<Version, 'hash'>[], after: readonly Pick<Version, 'hash'>[]): boolean {
    return before.length !== after.length || before.some((v, i) => v.hash !== after[i]?.hash);
}

/** Le résumé a trouvé effacée par Bitbucket une version que le détail croit encore lisible : détail à recharger. */
export function purgedSinceDetail(versions: readonly Pick<Version, 'index' | 'available'>[], summary: Summary): boolean {
    const readable = new Set(versions.filter((v) => v.available).map((v) => v.index));
    return summary.versions.some((s) => s.kind === 'unavailable' && readable.has(s.index));
}
