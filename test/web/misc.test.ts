import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comment, HomeGroupKey, PrCard, User } from '../../src/shared/api.ts';
import { ago, daysBetween, frList, gapLabel, masterMasked, openedSince, plural, relTime } from '../../src/web/lib/format.ts';
import { cardBadges, cardSubtitle } from '../../src/web/lib/home.ts';
import { prRoute } from '../../src/web/lib/prUrl.ts';
import { initials, newActivity, reactionView, threadGroups } from '../../src/web/lib/threads.ts';
import { commentById, prLong } from './fixtures.ts';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T14:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('prRoute', () => {
    it('route nommée de la page PR (l\'analyse des URL est testée avec src/shared)', () => {
        expect(prRoute({ workspace: 'acme', repo: 'records-api', id: 212 }, { from: '7', to: '10' }))
            .toEqual({ name: 'pr', params: { ws: 'acme', repo: 'records-api', id: '212' }, query: { from: '7', to: '10' } });
    });
});

describe('format', () => {
    it('pluriels et listes', () => {
        expect(plural(0, 'version')).toBe('0 version');
        expect(plural(1, 'version')).toBe('1 version');
        expect(plural(3, 'nouveau fil', 'nouveaux fils')).toBe('3 nouveaux fils');
        expect(masterMasked(1)).toBe('1 fichier de master masqué');
        expect(masterMasked(137)).toBe('137 fichiers de master masqués');
        expect(frList(['a'])).toBe('a');
        expect(frList(['a', 'b', 'c'])).toBe('a, b et c');
    });

    it('écarts de la frise', () => {
        expect(daysBetween('2026-10-14', '2026-10-29')).toBe(15);
        expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2); // changement d'heure
        expect(gapLabel(15)).toBe('15 j');
        expect(gapLabel(21)).toBe('3 sem.');
        expect(gapLabel(62)).toBe('2 mois');
    });

    it('dates relatives', () => {
        expect(relTime('2026-11-05T13:59:30Z')).toBe('à l\'instant');
        expect(relTime('2026-11-05T13:15:00Z')).toBe('il y a 45 min');
        expect(relTime('2026-11-05T11:02:00Z')).toBe('il y a 2 h');
        expect(relTime('2026-11-03T10:00:00Z')).toBe('3 nov.');
        expect(ago('2026-11-01T14:00:00Z')).toBe('il y a 4 j');
        expect(ago('2026-10-01T14:00:00Z')).toBe('il y a 5 sem.');
        expect(openedSince('2026-10-14T09:10:00Z')).toBe('ouverte depuis 22 j');
        expect(openedSince('2026-11-05T09:00:00Z')).toBe('ouverte aujourd\'hui');
    });
});

describe('cartes de l\'accueil', () => {
    const me: User = { uuid: '{me}', displayName: 'Moi' };
    const card = (over: Partial<PrCard>): PrCard => ({
        workspace: 'acme', repo: 'records-api', id: 1, title: 't', author: { uuid: '{a}', displayName: 'Auteur' }, url: 'u',
        createdOn: '2026-10-14T09:10:00Z', updatedOn: '2026-11-05T12:00:00Z', versionsCount: 10, lastPushAt: '2026-11-05T12:00:00Z',
        lastReviewed: 7, newVersions: 3, newCodeVersions: 1, approvals: 2, myApproval: false, newComments: 2, ...over,
    });
    const badges = (c: PrCard, key: HomeGroupKey = 'to-review'): string[] => cardBadges(c, key, me).map((b) => b.text);

    it('nouvelles versions, code, commentaires, approbation', () => {
        expect(badges(card({}))).toEqual(['+3 versions', 'dont 1 avec du code', '💬 2 nouveaux']);
        expect(badges(card({ newCodeVersions: 0, newComments: 0, myApproval: true }))).toEqual(['+3 versions', 'rebase seul', '✓ approuvée']);
        expect(badges(card({ newCodeVersions: null, newComments: 0 }), 'rebase-only')).toEqual(['+3 versions', 'rebase seul']);
    });

    it('jamais relue : avec le nombre de versions, ou sans s\'il est inconnu (carte légère)', () => {
        expect(badges(card({ lastReviewed: null, newComments: 0 }))).toEqual(['pas encore relue · 10 versions']);
        expect(badges(card({ lastReviewed: null, versionsCount: null, newComments: 0 }), 'others')).toEqual(['pas encore relue']);
    });

    it('sous-titre ; ma PR : « toi », pas de badge de versions', () => {
        expect(cardSubtitle(card({}), me)).toBe('records-api #1 · Auteur · ouverte depuis 22 j · push il y a 2 h · 2 approbations');
        const mine = card({ author: me, lastReviewed: null, newComments: 1, approvals: 1 });
        expect(cardSubtitle(mine, me)).toContain(' · toi · ');
        expect(badges(mine, 'mine')).toEqual(['💬 1 nouveau']);
    });
});

describe('fils', () => {
    const { data } = prLong();

    it('groupes : nouveaux, ouverts, résolus', () => {
        const g = threadGroups(data.threads);
        expect(g.fresh.map((t) => t.id)).toEqual([120]);
        expect(g.open.map((t) => t.id)).toEqual([110]);
        expect(g.resolved.map((t) => t.id).sort()).toEqual([101, 103, 105]);
    });

    it('nouveaux fils et réponses depuis ma relecture', () => {
        expect(newActivity(data.threads)).toEqual({ newThreads: 1, replies: 1, names: ['Yann', 'Camille'] });
    });

    it('réaction 👍 : comptée, marquée « liked » via myCommentIds, noms en infobulle', () => {
        const reply = commentById(data, 121);
        expect(reactionView(reply, data.me)).toEqual({ liked: true, count: 1, title: 'Thomas Girard (toi)', others: [] });
        const other: Comment = { ...reply, reactions: [{ emoji: '👍', users: [{ uuid: '{x}', displayName: 'X' }], myCommentIds: [] }, { emoji: '🎉', users: [{ uuid: '{x}', displayName: 'X' }], myCommentIds: [] }] };
        expect(reactionView(other, data.me)).toEqual({ liked: false, count: 1, title: 'X', others: [{ emoji: '🎉', count: 1, title: 'X' }] });
    });

    it('initiales d\'avatar', () => {
        expect(initials('Yann Bernard')).toBe('YB');
        expect(initials('review-bot')).toBe('RE');
        expect(initials('')).toBe('?');
    });
});
