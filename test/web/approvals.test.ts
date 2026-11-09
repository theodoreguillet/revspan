import { describe, expect, it } from 'vitest';
import type { Participant } from '../../src/shared/api.ts';
import { approvalHolds, approvalItems, myActions, staleness } from '../../src/web/lib/approvals.ts';
import { makeSums, prLong } from './fixtures.ts';

describe('staleness', () => {
    const { sums } = prLong();

    it('approbation à jour ou sans version : null', () => {
        expect(staleness(10, sums, 10)).toBeNull();
        expect(staleness(null, sums, 10)).toBeNull();
    });

    it('du code depuis l\'approbation : périmée, versions de code citées', () => {
        expect(staleness(7, sums, 10)).toEqual({ code: [10], deps: [9], text: 'code modifié en v10' });
        expect(staleness(3, sums, 10)?.text).toBe('code modifié en v4, v10');
    });

    it('seulement des dépendances : périmée « dépendances modifiées »', () => {
        expect(staleness(1, makeSums(['creation', 'rebase-only', 'deps']), 3)?.text).toBe('dépendances modifiées en v3');
    });

    it('seulement des rebases : pas périmée', () => {
        expect(staleness(1, makeSums(['creation', 'rebase-only', 'none']), 3)).toBeNull();
    });

    it('plus de 3 versions : liste abrégée', () => {
        expect(staleness(1, makeSums(['creation', 'code', 'code', 'code', 'code']), 5)?.text).toBe('code modifié en v2, v3, v4…');
    });
});

describe('approvalHolds : mon approbation vaut-elle pour la dernière version ?', () => {
    const part = (approved: boolean, approvedVersion: number | null): Participant => ({
        user: { uuid: '{me}', displayName: 'Moi' }, role: 'REVIEWER', approved, state: approved ? 'approved' : null, approvedVersion,
    });
    const sums = makeSums(['creation', 'code', 'rebase-only', 'none']);

    it('active sur Bitbucket et seulement des rebases depuis : oui (rien à réapprouver)', () => {
        expect(approvalHolds(part(true, 2), sums, 4, true)).toBe(true);
        expect(approvalHolds(part(true, 4), sums, 4, true)).toBe(true);
    });

    it('retirée par Bitbucket, ou du code / des dépendances depuis : non', () => {
        expect(approvalHolds(part(false, 2), sums, 4, true)).toBe(false);
        expect(approvalHolds(part(true, 1), sums, 4, true)).toBe(false);
        expect(approvalHolds(part(true, 2), makeSums(['creation', 'code', 'deps', 'none']), 4, true)).toBe(false);
        expect(approvalHolds(null, sums, 4, true)).toBe(false);
    });

    it('résumé pas encore chargé : l\'état de Bitbucket fait foi', () => {
        expect(approvalHolds(part(true, 1), sums, 4, false)).toBe(true);
    });
});

describe('approvalItems / myActions', () => {
    const { data, sums } = prLong();

    it('#212 : Yann à jour, William périmé, moi en attente', () => {
        const items = approvalItems(data, sums, true);
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

    it('résumé pas encore chargé : aucune approbation marquée périmée', () => {
        expect(approvalItems(data, sums, false).filter((i) => i.kind === 'approved' && i.stale)).toEqual([]);
    });

    it('demande de modifs et mes actions', () => {
        const meUuid = data.me?.uuid;
        const changed = {
            ...data,
            participants: data.participants.map((p) => (p.user?.uuid === meUuid ? { ...p, state: 'changes_requested' as const, approvedVersion: 10 } : p)),
        };
        expect(approvalItems(changed, sums, true).at(-1)).toMatchObject({ kind: 'changes', name: 'toi', version: 10 });
        expect(myActions(changed, sums, true)).toEqual({ mine: false, closed: false, changesActive: true, approvalHolds: false, reapprove: false });
        const approved = {
            ...data,
            participants: data.participants.map((p) => (p.user?.uuid === meUuid ? { ...p, approved: true, state: 'approved' as const, approvedVersion: 8 } : p)),
        };
        // v9 deps et v10 code depuis v8 : réapprouver.
        expect(myActions(approved, sums, true)).toMatchObject({ approvalHolds: false, reapprove: true });
        const latest = { ...approved, participants: approved.participants.map((p) => (p.user?.uuid === meUuid ? { ...p, approvedVersion: 10 } : p)) };
        expect(myActions(latest, sums, true)).toMatchObject({ approvalHolds: true, reapprove: false });
    });

    it('ma PR : pas d\'entrée « toi » ni de bouton', () => {
        const mine = { ...data, pr: { ...data.pr, author: data.me } };
        expect(approvalItems(mine, sums, true).some((i) => i.name === 'toi')).toBe(false);
        expect(myActions(mine, sums, true).mine).toBe(true);
    });
});
