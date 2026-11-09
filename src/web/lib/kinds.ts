// Version types (summary), index lookup table and consistency between the summary and the PR detail.
import type { Summary, Version, VersionKind, VersionSummary } from '../../shared/api.ts';
import type { MessageKey } from '../i18n/index.ts';

export type SummaryMap = Map<number, VersionSummary>;

export const MUTED_KINDS: ReadonlySet<VersionKind> = new Set(['deps', 'rebase-only', 'message-only', 'none', 'unavailable']);
export const CODE_KINDS: ReadonlySet<VersionKind> = new Set(['code', 'creation']);
/** Versions with no author change at all (quick re-approval possible). */
export const TRIVIAL_KINDS: ReadonlySet<VersionKind> = new Set(['rebase-only', 'none', 'message-only']);

/** Short label of each kind (timeline nodes and tooltips). */
export const KIND_LABELS = {
    creation: 'kind.creation',
    code: 'kind.code',
    deps: 'kind.deps',
    'rebase-only': 'kind.rebaseOnly',
    'message-only': 'kind.messageOnly',
    none: 'kind.none',
    unavailable: 'kind.unavailable',
} as const satisfies Record<VersionKind, MessageKey>;

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

/** The version list changed (version pushed while reading, version replaced): summary to reload. */
export function versionsChanged(before: readonly Pick<Version, 'hash'>[], after: readonly Pick<Version, 'hash'>[]): boolean {
    return before.length !== after.length || before.some((v, i) => v.hash !== after[i]?.hash);
}

/** The summary found a version erased by Bitbucket that the detail still thinks is readable: detail to reload. */
export function purgedSinceDetail(versions: readonly Pick<Version, 'index' | 'available'>[], summary: Summary): boolean {
    const readable = new Set(versions.filter((v) => v.available).map((v) => v.index));
    return summary.versions.some((s) => s.kind === 'unavailable' && readable.has(s.index));
}
