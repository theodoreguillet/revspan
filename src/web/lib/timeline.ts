// Frise des versions : modèle d'affichage (jours, écarts, repli des longues PR, masquage), deltas et infobulles.
import type { Version, VersionSummary } from '../../shared/api.ts';
import { dayKey, daysBetween, fmtDateTime, fmtDay, fmtMonth, gapLabel, isToday, MINUS, plural } from './format.ts';
import { CODE_KINDS, isMuted, KIND_LABELS, type SummaryMap } from './kinds.ts';
import { filesText } from './describe.ts';

export const MAX_VISIBLE_NODES = 12;

export type TimelineNode = { type: 'node'; version: Version } | { type: 'hidden'; list: number[] };

/** `after` = index de la version juste avant l'élément (sert à colorer la plage). */
export type TimelineItem =
    | { type: 'base' }
    | { type: 'day'; key: string; label: string; nodes: TimelineNode[] }
    | { type: 'gap'; label: string; after: number; days: number }
    | { type: 'sp'; after: number }
    | { type: 'seen'; after: number }
    | { type: 'fold'; a: number; b: number; months: string; codeCount: number | null; rebases: number };

export interface TimelineInput {
    versions: Version[];
    sums: SummaryMap;
    lastReviewed: number | null;
    from: number;
    to: number;
    hideNoCode: boolean;
    foldDisabled: boolean;
    maxVisible?: number;
}

export type NodeState = 'shown' | 'hidden' | 'folded';

export interface VersionNode {
    version: Version;
    state: NodeState;
}

/** État de chaque version : affichée, masquée (sans code) ou repliée (longue PR). */
export function nodeStates({ versions, sums, lastReviewed, from, to, hideNoCode, foldDisabled, maxVisible = MAX_VISIBLE_NODES }: TimelineInput): VersionNode[] {
    const n = versions.length;
    const nodes: VersionNode[] = versions.map((version) => ({ version, state: 'shown' }));
    if (hideNoCode) {
        // jamais masqués : les bornes, l'intérieur de la plage, ma dernière relecture
        for (const node of nodes) {
            const i = node.version.index;
            const keep = i === from || i === to || (i > from && i <= to) || i === lastReviewed;
            if (isMuted(sums.get(i)) && !keep) {
                node.state = 'hidden';
            }
        }
    }
    if (foldDisabled) {
        return nodes;
    }
    // jamais repliés : après ma relecture, la relecture elle-même, les bornes, l'intérieur de la plage
    // (sauf « vN complète », dont l'intérieur n'est pas une sélection), la dernière version
    const isProtected = (i: number): boolean => i === n || i === from || i === to
        || (lastReviewed != null && i >= lastReviewed)
        || (from > 0 && i > from && i < to);
    let visible = nodes.filter((node) => node.state === 'shown').length;
    for (const node of nodes) {
        if (visible <= maxVisible) {
            break;
        }
        if (isProtected(node.version.index)) {
            continue;
        }
        if (node.state === 'shown') {
            visible--;
        }
        node.state = 'folded';
    }
    // un repli d'une seule version n'apporte rien
    nodes.forEach((node, k) => {
        if (node.state === 'folded' && nodes[k - 1]?.state !== 'folded' && nodes[k + 1]?.state !== 'folded') {
            node.state = 'shown';
        }
    });
    return nodes;
}

/** Suite d'éléments à rendre de gauche à droite. */
export function timelineModel(input: TimelineInput): TimelineItem[] {
    const { sums, lastReviewed } = input;
    const items: TimelineItem[] = [{ type: 'base' }];
    let prevDay: string | null = null;
    let lastIdx = 0;
    let column: Extract<TimelineItem, { type: 'day' }> | null = null;
    let afterSeen = false;
    let foldRun: Version[] = [];

    const separate = (nextDay: string): void => {
        const days = prevDay ? daysBetween(prevDay, nextDay) : 0;
        items.push(days >= 2 ? { type: 'gap', label: gapLabel(days), after: lastIdx, days } : { type: 'sp', after: lastIdx });
    };
    const flushFold = (): void => {
        const first = foldRun[0];
        const last = foldRun[foldRun.length - 1];
        if (!first || !last) {
            return;
        }
        separate(dayKey(first.pushedAt));
        const folded = foldRun.map((v) => sums.get(v.index));
        const codeCount = folded.every(Boolean) ? folded.filter((s) => s && CODE_KINDS.has(s.kind)).length : null;
        const m1 = fmtMonth(first.pushedAt);
        const m2 = fmtMonth(last.pushedAt);
        const rebases = foldRun.filter((v) => v.isRebase).length;
        items.push({ type: 'fold', a: first.index, b: last.index, months: m1 === m2 ? m1 : `${m1} → ${m2}`, codeCount, rebases });
        prevDay = dayKey(last.pushedAt);
        lastIdx = last.index;
        column = null;
        afterSeen = false;
        foldRun = [];
    };

    for (const { version, state } of nodeStates(input)) {
        if (state === 'folded') {
            foldRun.push(version);
            continue;
        }
        flushFold();
        const dk = dayKey(version.pushedAt);
        if (!column || column.key !== dk) {
            separate(dk);
            const label: string = afterSeen && prevDay === dk ? '' : `${fmtDay(version.pushedAt)}${isToday(version.pushedAt) ? ' · aujourd\'hui' : ''}`;
            afterSeen = false;
            column = { type: 'day', key: dk, label, nodes: [] };
            items.push(column);
        }
        const last = column.nodes[column.nodes.length - 1];
        if (state === 'hidden' && last?.type === 'hidden') {
            last.list.push(version.index);
        } else {
            column.nodes.push(state === 'hidden' ? { type: 'hidden', list: [version.index] } : { type: 'node', version });
        }
        prevDay = dk;
        lastIdx = version.index;
        if (version.index === lastReviewed) {
            items.push({ type: 'seen', after: version.index });
            column = null;
            afterSeen = true;
        }
    }
    flushFold();
    return items;
}

/** Un élément intermédiaire (écart, espace, relu) est dans la bande de la plage. */
export const inBand = (after: number, from: number, to: number): boolean => after >= from && after < to;

export type NodeDelta = { code: true; added: number; removed: number } | { code: false; text: string };

/** Delta affiché sous un nœud : « +35 −14 » pour du code, sinon le type (« deps », « rebase seul »…). */
export function nodeDelta(sum: VersionSummary | undefined): NodeDelta {
    if (!sum) {
        return { code: false, text: '…' };
    }
    if (sum.kind === 'code') {
        return { code: true, added: sum.added, removed: sum.removed };
    }
    return { code: false, text: KIND_LABELS[sum.kind] };
}

/** Infobulle d'un nœud : version, date, hash, base, type, fichiers. */
export function nodeTooltip(v: Version, sum: VersionSummary | undefined, opts: { lastReviewed: number | null; n: number }): string {
    const parts = [`v${v.index}`, fmtDateTime(v.pushedAt), v.shortHash];
    if (!v.available) {
        parts.push('indisponible : Bitbucket a effacé ce commit (version écrasée par un force-push), elle ne peut pas être comparée');
        if (v.index === opts.lastReviewed) {
            parts.push('relue par toi');
        }
        return parts.join(' · ');
    }
    parts.push(v.isRebase
        ? `rebase sur ${v.baseShort}${sum?.masterFiles ? ` (${plural(sum.masterFiles, 'fichier')} de master)` : ''}`
        : `base ${v.baseShort}`);
    if (sum?.since !== undefined) {
        parts.push(sum.since === 0
            ? 'changements comptés depuis la base (versions précédentes indisponibles)'
            : `changements comptés depuis v${sum.since} (versions intermédiaires indisponibles)`);
    }
    if (sum) {
        parts.push(KIND_LABELS[sum.kind]);
        if (sum.files.length) {
            parts.push(filesText(sum.files, 6));
        }
        if (CODE_KINDS.has(sum.kind) || sum.kind === 'deps') {
            parts.push(`+${sum.added} ${MINUS}${sum.removed}`);
        }
        if (sum.conflicts) {
            parts.push(`${plural(sum.conflicts, 'fichier')} touché(s) par master et l'auteur`);
        }
    }
    if (v.messageChanged) {
        parts.push('message du commit modifié');
    }
    if (v.index === opts.lastReviewed) {
        parts.push('relue par toi');
    }
    if (v.index === opts.n) {
        parts.push('dernière version');
    }
    return parts.join(' · ');
}
