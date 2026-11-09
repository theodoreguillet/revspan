// Approvals: approved version, stale approvals, state of my buttons.
import type { Participant, PrDetail } from '../../shared/api.ts';
import type { Translator } from '../i18n/index.ts';
import { displayName, vname } from './format.ts';
import { CODE_KINDS, type SummaryMap } from './kinds.ts';

/** Versions with code (or dependency) changes after the approved one. */
export interface StaleVersions {
    code: number[];
    deps: number[];
}

export interface Staleness extends StaleVersions {
    text: string;
}

/** Versions with code (or dependency) changes after the approved version; null if the approval is up to date. */
export function staleVersions(approvedVersion: number | null, sums: SummaryMap, n: number): StaleVersions | null {
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
    return code.length || deps.length ? { code, deps } : null;
}

/** Same, with its description: "code changed in v4, v10". */
export function staleness(tr: Translator, approvedVersion: number | null, sums: SummaryMap, n: number): Staleness | null {
    const stale = staleVersions(approvedVersion, sums, n);
    if (!stale) {
        return null;
    }
    const list = (arr: number[]): string => (arr.length > 3 ? `${arr.slice(0, 3).map(vname).join(', ')}…` : arr.map(vname).join(', '));
    const text = stale.code.length
        ? tr.t('approval.codeChanged', { versions: list(stale.code) })
        : tr.t('approval.depsChanged', { versions: list(stale.deps) });
    return { ...stale, text };
}

/**
 * My approval holds for the latest version: still active on Bitbucket (which does not necessarily remove it on every
 * push) and nothing from the author since (only rebases or the message). Until the summary is loaded,
 * Bitbucket's state is authoritative; once loaded, a version that arrived since and is absent from the summary (pushed
 * while reading) is not neutral: unknown = not valid, like approvalHoldsSince on the server side.
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
    return staleVersions(part.approvedVersion, sums, n) === null;
}

export type ApprovalItem =
    | { kind: 'approved'; name: string; version: number | null; stale: Staleness | null; title: string }
    | { kind: 'changes'; name: string; version: number | null; title: string }
    | { kind: 'pending'; name: string; title: string };

/** Whose item: another reviewer (by name) or me ("you", with first-person titles). */
type Who = { me: false; name: string } | { me: true };

function approvedItem(tr: Translator, who: Who, part: Participant, sums: SummaryMap, n: number, summaryLoaded: boolean): ApprovalItem {
    const stale = summaryLoaded ? staleness(tr, part.approvedVersion, sums, n) : null;
    const version = part.approvedVersion;
    return { kind: 'approved', name: who.me ? tr.t('common.you') : who.name, version, stale, title: approvedTitle(tr, who, version, stale) };
}

function approvedTitle(tr: Translator, who: Who, version: number | null, stale: Staleness | null): string {
    if (who.me) {
        if (stale && version != null) {
            return tr.t('approval.meApprovedStale', { version, stale: stale.text });
        }
        return version ? tr.t('approval.meApprovedVersion', { version }) : tr.t('approval.meApproved');
    }
    if (stale && version != null) {
        return tr.t('approval.approvedStale', { name: who.name, version, stale: stale.text });
    }
    return version ? tr.t('approval.approvedVersion', { name: who.name, version }) : tr.t('approval.approved', { name: who.name });
}

function changesItem(tr: Translator, who: Who, part: Participant): ApprovalItem {
    return who.me
        ? { kind: 'changes', name: tr.t('common.you'), version: part.approvedVersion, title: tr.t('approval.meChanges') }
        : { kind: 'changes', name: who.name, version: part.approvedVersion, title: tr.t('approval.changes', { name: who.name }) };
}

/** Approvals row: each reviewer who approved or requested changes, then me. */
export function approvalItems(tr: Translator, data: PrDetail, sums: SummaryMap, summaryLoaded: boolean): ApprovalItem[] {
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
        const who: Who = { me: false, name: displayName(part.user) };
        if (part.state === 'approved' || part.approved) {
            items.push(approvedItem(tr, who, part, sums, n, summaryLoaded));
        } else if (part.state === 'changes_requested') {
            items.push(changesItem(tr, who, part));
        }
    }
    if (me && !mine) {
        if (myPart?.approved || myPart?.state === 'approved') {
            items.push(approvedItem(tr, { me: true }, myPart, sums, n, summaryLoaded));
        } else if (myPart?.state === 'changes_requested') {
            items.push(changesItem(tr, { me: true }, myPart));
        } else {
            items.push({ kind: 'pending', name: tr.t('common.you'), title: tr.t('approval.mePending') });
        }
    }
    return items;
}

export interface MyActions {
    /** PR I authored: no approval possible. */
    mine: boolean;
    /** Closed PR: buttons disabled. */
    closed: boolean;
    changesActive: boolean;
    /** My approval holds for the latest version (see approvalHolds): "Remove approval" button. */
    approvalHolds: boolean;
    /** I approved, but the author changed code or dependencies since: "Re-approve". */
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
