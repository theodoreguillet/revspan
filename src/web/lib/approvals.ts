// Approbations : version approuvée, approbations périmées, état de mes boutons.
import type { Participant, PrDetail } from '../../shared/api.ts';
import { displayName, vname } from './format.ts';
import { CODE_KINDS, type SummaryMap } from './kinds.ts';

export interface Staleness {
    code: number[];
    deps: number[];
    text: string;
}

/** Versions avec du code (ou des dépendances) arrivées après la version approuvée ; null si l'approbation est à jour. */
export function staleness(approvedVersion: number | null, sums: SummaryMap, n: number): Staleness | null {
    if (approvedVersion == null || approvedVersion >= n) {
        return null;
    }
    const code: number[] = [];
    const deps: number[] = [];
    for (let i = approvedVersion + 1; i <= n; i++) {
        const kind = sums.get(i)?.kind;
        if (kind && CODE_KINDS.has(kind)) {
            code.push(i);
        } else if (kind === 'deps') {
            deps.push(i);
        }
    }
    if (!code.length && !deps.length) {
        return null;
    }
    const list = (arr: number[]): string => (arr.length > 3 ? `${arr.slice(0, 3).map(vname).join(', ')}…` : arr.map(vname).join(', '));
    return { code, deps, text: code.length ? `code modifié en ${list(code)}` : `dépendances modifiées en ${list(deps)}` };
}

/**
 * Mon approbation vaut pour la dernière version : toujours active sur Bitbucket (qui ne la retire pas forcément à chaque
 * push) et rien de l'auteur depuis (seulement des rebases ou le message). Tant que le résumé n'est pas chargé,
 * l'état de Bitbucket fait foi ; une fois chargé, une version arrivée depuis et absente du résumé (poussée pendant la
 * lecture) n'est pas neutre : inconnu = pas valable, comme approvalHoldsSince côté serveur.
 */
export function approvalHolds(part: Participant | null | undefined, sums: SummaryMap, n: number, summaryLoaded: boolean): boolean {
    if (!part?.approved) {
        return false;
    }
    if (part.approvedVersion == null || part.approvedVersion >= n || !summaryLoaded) {
        return true;
    }
    for (let i = part.approvedVersion + 1; i <= n; i++) {
        if (!sums.has(i)) {
            return false;
        }
    }
    return staleness(part.approvedVersion, sums, n) === null;
}

export type ApprovalItem =
    | { kind: 'approved'; name: string; version: number | null; stale: Staleness | null; title: string }
    | { kind: 'changes'; name: string; version: number | null; title: string }
    | { kind: 'pending'; name: string; title: string };

function approvedItem(name: string, part: Participant, sums: SummaryMap, n: number, summaryLoaded: boolean): ApprovalItem {
    const stale = summaryLoaded ? staleness(part.approvedVersion, sums, n) : null;
    const title = stale
        ? `${name} a approuvé v${part.approvedVersion} ; ${stale.text} depuis`
        : `${name} a approuvé${part.approvedVersion ? ` v${part.approvedVersion}` : ''}`;
    return { kind: 'approved', name, version: part.approvedVersion, stale, title };
}

function changesItem(name: string, part: Participant): ApprovalItem {
    return { kind: 'changes', name, version: part.approvedVersion, title: `${name} a demandé des modifications` };
}

/** Ligne des approbations : chaque relecteur ayant approuvé ou demandé des modifs, puis moi. */
export function approvalItems(data: PrDetail, sums: SummaryMap, summaryLoaded: boolean): ApprovalItem[] {
    const n = data.versions.length;
    const me = data.me;
    const mine = !!me && data.pr.author?.uuid === me.uuid;
    const items: ApprovalItem[] = [];
    let myPart: Participant | null = null;
    for (const part of data.participants) {
        if (me && part.user?.uuid === me.uuid) {
            myPart = part;
            continue;
        }
        if (part.state === 'approved' || part.approved) {
            items.push(approvedItem(displayName(part.user), part, sums, n, summaryLoaded));
        } else if (part.state === 'changes_requested') {
            items.push(changesItem(displayName(part.user), part));
        }
    }
    if (me && !mine) {
        if (myPart?.approved || myPart?.state === 'approved') {
            items.push(approvedItem('toi', myPart, sums, n, summaryLoaded));
        } else if (myPart?.state === 'changes_requested') {
            items.push(changesItem('toi', myPart));
        } else {
            items.push({ kind: 'pending', name: 'toi', title: 'Tu n\'as pas encore approuvé' });
        }
    }
    return items;
}

export interface MyActions {
    /** PR dont je suis l'auteur : pas d'approbation possible. */
    mine: boolean;
    /** PR fermée : boutons désactivés. */
    closed: boolean;
    changesActive: boolean;
    /** Mon approbation vaut pour la dernière version (voir approvalHolds) : bouton « Retirer l'approbation ». */
    approvalHolds: boolean;
    /** J'ai approuvé, mais l'auteur a changé du code ou des dépendances depuis : « Réapprouver ». */
    reapprove: boolean;
}

export function myActions(data: PrDetail, sums: SummaryMap, summaryLoaded: boolean): MyActions {
    const n = data.versions.length;
    const me = data.me;
    const part = me ? data.participants.find((p) => p.user?.uuid === me.uuid) ?? null : null;
    const holds = approvalHolds(part, sums, n, summaryLoaded);
    return {
        mine: !!me && data.pr.author?.uuid === me.uuid,
        closed: data.pr.state !== 'OPEN',
        changesActive: part?.state === 'changes_requested',
        approvalHolds: holds,
        reapprove: !!part?.approved && !holds,
    };
}
