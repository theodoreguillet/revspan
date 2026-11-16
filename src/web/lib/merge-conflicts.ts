// Rebase and merge-conflict chips of the PR header, and the conflicting files of the shown comparison.
import type { FileDiff, PrInfo } from '../../shared/api.ts';
import type { Translator } from '../i18n/index.ts';

/** Paths listed in the conflicts tooltip; past it, how many more. */
const TOOLTIP_PATHS = 10;

export interface HeaderChip {
    label: string;
    title: string;
}

type ChipPr = Pick<PrInfo, 'state' | 'destBranch'>;

/** « À rebaser sur {branch} » for an open PR behind its destination; nothing when up to date or unknown (no noise). */
export function rebaseChip(tr: Translator, pr: ChipPr, needsRebase: boolean | null): HeaderChip | null {
    if (pr.state !== 'OPEN' || needsRebase !== true) {
        return null;
    }
    return { label: tr.t('pr.needsRebase', { branch: pr.destBranch }), title: tr.t('pr.needsRebaseTitle', { branch: pr.destBranch }) };
}

/**
 * « ⚠ Conflits avec {branch} · N fichiers », the tooltip listing the paths (at most 10). target: index of the first
 * conflicting file in the shown comparison (-1: none shown, the chip then has nothing to open).
 */
export function conflictChip(tr: Translator, pr: ChipPr, paths: readonly string[] | null, target: number): HeaderChip | null {
    if (pr.state !== 'OPEN' || !paths?.length) {
        return null;
    }
    const branch = pr.destBranch;
    const lines = [tr.t('pr.mergeConflictsTitle', { branch }), ...paths.slice(0, TOOLTIP_PATHS)];
    if (paths.length > TOOLTIP_PATHS) {
        lines.push(tr.t('pr.mergeConflictsMore', { count: paths.length - TOOLTIP_PATHS }));
    }
    if (target >= 0) {
        lines.push(tr.t('pr.mergeConflictsGo'));
    }
    return { label: tr.t('pr.mergeConflicts', { branch, count: paths.length }), title: lines.join('\n') };
}

/** A file of the comparison in conflict: by its path or, when renamed, its old path. */
export function isMergeConflict(file: Pick<FileDiff, 'path' | 'oldPath'>, conflicts: ReadonlySet<string>): boolean {
    return conflicts.has(file.path) || (file.oldPath !== null && conflicts.has(file.oldPath));
}

/** Index of the first conflicting file of the comparison, -1 when none is shown. */
export function firstConflictIndex(files: readonly Pick<FileDiff, 'path' | 'oldPath'>[], conflicts: ReadonlySet<string>): number {
    return conflicts.size ? files.findIndex((file) => isMergeConflict(file, conflicts)) : -1;
}
