import { describe, expect, it } from 'vitest';
import type { Participant } from '../../src/shared/api.ts';
import { approvalHolds, approvalItems, myActions, staleness } from '../../src/web/lib/approvals.ts';
import { makeSums, makeVersions, prLong } from './fixtures.ts';
import { createTranslator } from '../../src/web/i18n/translator.ts';

// French, the language these expectations are written in (English is covered by test/web/i18n.test.ts and below).
const fr = createTranslator('fr');

describe('staleness', () => {
    const { sums } = prLong();

    it('up-to-date approval or no version: null', () => {
        expect(staleness(fr, 10, sums, 10)).toBeNull();
        expect(staleness(fr, null, sums, 10)).toBeNull();
    });

    it('code since the approval: stale, code versions cited', () => {
        expect(staleness(fr, 7, sums, 10)).toEqual({ code: [10], deps: [9], text: 'code modifié en v10' });
        expect(staleness(fr, 3, sums, 10)?.text).toBe('code modifié en v4, v10');
    });

    it('only dependencies: stale "dependencies changed"', () => {
        expect(staleness(fr, 1, makeSums(['creation', 'rebase-only', 'deps']), 3)?.text).toBe('dépendances modifiées en v3');
    });

    it('only rebases: not stale', () => {
        expect(staleness(fr, 1, makeSums(['creation', 'rebase-only', 'none']), 3)).toBeNull();
    });

    it('more than 3 versions: shortened list', () => {
        expect(staleness(fr, 1, makeSums(['creation', 'code', 'code', 'code', 'code']), 5)?.text).toBe('code modifié en v2, v3, v4…');
    });
});

describe('approvalHolds: does my approval hold for the latest version?', () => {
    const part = (approved: boolean, approvedVersion: number | null): Participant => ({
        user: { uuid: '{me}', displayName: 'Moi' }, role: 'REVIEWER', approved, state: approved ? 'approved' : null, approvedVersion,
    });
    const sums = makeSums(['creation', 'code', 'rebase-only', 'none']);

    it('active on Bitbucket and only rebases since: yes (nothing to re-approve)', () => {
        expect(approvalHolds(part(true, 2), sums, 4, true)).toBe(true);
        expect(approvalHolds(part(true, 4), sums, 4, true)).toBe(true);
    });

    it('removed by Bitbucket, or code / dependencies since: no', () => {
        expect(approvalHolds(part(false, 2), sums, 4, true)).toBe(false);
        expect(approvalHolds(part(true, 1), sums, 4, true)).toBe(false);
        expect(approvalHolds(part(true, 2), makeSums(['creation', 'code', 'deps', 'none']), 4, true)).toBe(false);
        expect(approvalHolds(null, sums, 4, true)).toBe(false);
    });

    it('summary not loaded yet: Bitbucket\'s state is authoritative', () => {
        expect(approvalHolds(part(true, 1), sums, 4, false)).toBe(true);
    });

    it('version erased by Bitbucket since (unavailable): neutral, like on the server', () => {
        expect(approvalHolds(part(true, 2), makeSums(['creation', 'code', 'unavailable', 'rebase-only']), 4, true)).toBe(true);
        expect(approvalHolds(part(true, 2), makeSums(['creation', 'code', 'unavailable', 'code']), 4, true)).toBe(false);
    });

    it('approved version unknown: Bitbucket\'s state is authoritative', () => {
        expect(approvalHolds(part(true, null), makeSums(['creation', 'code', 'code']), 3, true)).toBe(true);
    });

    it('version pushed since, absent from the loaded summary: no (unknown = not valid, like on the server)', () => {
        expect(approvalHolds(part(true, 2), makeSums(['creation', 'code', 'rebase-only']), 4, true)).toBe(false);
        expect(approvalHolds(part(true, 4), makeSums(['creation', 'code', 'rebase-only']), 5, true)).toBe(false);
    });
});

describe('approvalItems / myActions', () => {
    const { data, sums } = prLong();

    it('#212: Yann up to date, William stale, me pending', () => {
        const items = approvalItems(fr, data, sums, true);
        expect(items).toEqual([
            { kind: 'approved', name: 'Yann Bernard', version: 10, stale: null, title: 'Yann Bernard a approuvé v10' },
            {
                kind: 'approved', name: 'William Etienne', version: 7,
                stale: { code: [10], deps: [9], text: 'code modifié en v10' },
                title: 'William Etienne a approuvé v7 ; code modifié en v10 depuis',
            },
            { kind: 'pending', name: 'toi', title: 'Tu n\'as pas encore approuvé' },
        ]);
    });

    it('summary not loaded yet: no approval marked stale', () => {
        expect(approvalItems(fr, data, sums, false).filter((i) => i.kind === 'approved' && i.stale)).toEqual([]);
    });

    it('change request and my actions', () => {
        const meUuid = data.me?.uuid;
        const changed = {
            ...data,
            participants: data.participants.map((p) => (p.user?.uuid === meUuid ? { ...p, state: 'changes_requested' as const, approvedVersion: 10 } : p)),
        };
        expect(approvalItems(fr, changed, sums, true).at(-1)).toMatchObject({ kind: 'changes', name: 'toi', version: 10 });
        expect(myActions(changed, sums, true)).toEqual({ mine: false, closed: false, changesActive: true, approvalHolds: false, reapprove: false });
        const approved = {
            ...data,
            participants: data.participants.map((p) => (p.user?.uuid === meUuid ? { ...p, approved: true, state: 'approved' as const, approvedVersion: 8 } : p)),
        };
        // v9 deps and v10 code since v8: re-approve.
        expect(myActions(approved, sums, true)).toMatchObject({ approvalHolds: false, reapprove: true });
        const latest = { ...approved, participants: approved.participants.map((p) => (p.user?.uuid === meUuid ? { ...p, approvedVersion: 10 } : p)) };
        expect(myActions(latest, sums, true)).toMatchObject({ approvalHolds: true, reapprove: false });
    });

    it('new version not in the summary yet: "Re-approve", not "Remove approval"', () => {
        const meUuid = data.me?.uuid;
        const pushed = {
            ...data,
            versions: makeVersions(11),
            participants: data.participants.map((p) => (p.user?.uuid === meUuid ? { ...p, approved: true, state: 'approved' as const, approvedVersion: 10 } : p)),
        };
        expect(myActions(pushed, sums, true)).toMatchObject({ approvalHolds: false, reapprove: true });
    });

    it('my PR: no "you" entry and no button', () => {
        const mine = { ...data, pr: { ...data.pr, author: data.me } };
        expect(approvalItems(fr, mine, sums, true).some((i) => i.name === 'toi')).toBe(false);
        expect(myActions(mine, sums, true).mine).toBe(true);
    });
});

describe('approvals in English', () => {
    it('reviewers by name, me in the first person', () => {
        const { data, sums } = prLong();
        expect(approvalItems(createTranslator('en'), data, sums, true).map((item) => [item.name, item.title])).toEqual([
            ['Yann Bernard', 'Yann Bernard approved v10'],
            ['William Etienne', 'William Etienne approved v7; code changed in v10 since'],
            ['you', 'You haven’t approved yet'],
        ]);
    });
});
