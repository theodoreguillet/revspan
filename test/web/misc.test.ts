import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrCard, User } from '../../src/shared/api.ts';
import { createTranslator } from '../../src/web/i18n/translator.ts';
import { ago, daysBetween, gapLabel, masterMasked, openedSince, relTime } from '../../src/web/lib/format.ts';
import { GROUP_TITLES, cardBadges, cardSubtitle, truncatedNotice } from '../../src/web/lib/home.ts';
import { prRoute } from '../../src/web/lib/prUrl.ts';
import { initials, newActivity, threadGroups } from '../../src/web/lib/threads.ts';
import { prLong } from './fixtures.ts';

// French, the language these expectations are written in; English variants are checked next to them.
const fr = createTranslator('fr');
const en = createTranslator('en');

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T14:00:00Z'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('prRoute', () => {
    it('named route of the PR page (URL parsing is tested with src/shared)', () => {
        expect(prRoute({ workspace: 'acme', repo: 'records-api', id: 212 }, { from: '7', to: '10' }))
            .toEqual({ name: 'pr', params: { ws: 'acme', repo: 'records-api', id: '212' }, query: { from: '7', to: '10' } });
    });
});

describe('format', () => {
    it('plurals and lists', () => {
        expect(masterMasked(fr, 1)).toBe('1 fichier de master masqué');
        expect(masterMasked(fr, 137)).toBe('137 fichiers de master masqués');
        expect(masterMasked(en, 137)).toBe('137 master files hidden');
    });

    it('timeline gaps', () => {
        expect(daysBetween('2026-10-14', '2026-10-29')).toBe(15);
        expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2); // changement d'heure
        expect(gapLabel(fr, 15)).toBe('15 j');
        expect(gapLabel(fr, 21)).toBe('3 sem.');
        expect(gapLabel(fr, 62)).toBe('2 mois');
        expect([15, 21, 62].map((days) => gapLabel(en, days))).toEqual(['15d', '3w', '2mo']);
    });

    it('relative dates', () => {
        expect(relTime(fr, '2026-11-05T13:59:30Z')).toBe('à l\'instant');
        expect(relTime(fr, '2026-11-05T13:15:00Z')).toBe('il y a 45 min');
        expect(relTime(fr, '2026-11-05T11:02:00Z')).toBe('il y a 2 h');
        expect(relTime(fr, '2026-11-03T10:00:00Z')).toBe('3 nov.');
        expect(ago(fr, '2026-11-01T14:00:00Z')).toBe('il y a 4 j');
        expect(ago(fr, '2026-10-01T14:00:00Z')).toBe('il y a 5 sem.');
        expect(openedSince(fr, '2026-10-14T09:10:00Z')).toBe('ouverte depuis 22 j');
        expect(openedSince(fr, '2026-11-05T09:00:00Z')).toBe('ouverte aujourd\'hui');
    });

    it('relative dates in English', () => {
        expect(relTime(en, '2026-11-05T13:59:30Z')).toBe('just now');
        expect(relTime(en, '2026-11-05T13:59:00Z')).toBe('1 minute ago');
        expect(relTime(en, '2026-11-05T11:02:00Z')).toBe('2 hours ago');
        expect(relTime(en, '2026-11-03T10:00:00Z')).toBe('Nov 3');
        expect(ago(en, '2026-11-04T14:00:00Z')).toBe('1 day ago');
        expect(ago(en, '2026-10-01T14:00:00Z')).toBe('5 weeks ago');
        expect(openedSince(en, '2026-10-14T09:10:00Z')).toBe('open for 22 days');
        expect(openedSince(en, '2026-11-05T09:00:00Z')).toBe('opened today');
    });
});

describe('home cards', () => {
    const me: User = { uuid: '{me}', displayName: 'Moi' };
    const card = (over: Partial<PrCard>): PrCard => ({
        workspace: 'acme', repo: 'records-api', id: 1, title: 't', author: { uuid: '{a}', displayName: 'Auteur' }, url: 'u',
        createdOn: '2026-10-14T09:10:00Z', updatedOn: '2026-11-05T12:00:00Z', versionsCount: 10, lastPushAt: '2026-11-05T12:00:00Z',
        lastReviewed: 7, newVersions: 3, newCodeVersions: 1, approvals: 2, requiredApprovals: 2, myApproval: false, newComments: 2,
        needsReview: false, designatedReviewer: false, followed: false, approvalHolds: false, build: null, needsRebase: null, head: '', draft: false, ...over,
    });
    const badges = (c: PrCard): string[] => cardBadges(fr, c, me).map((b) => b.text);

    it('new versions, code, comments, approval', () => {
        expect(badges(card({}))).toEqual(['+3 versions', 'dont 1 avec du code', '💬 2 nouveaux']);
        expect(badges(card({ newCodeVersions: 0, newComments: 0, myApproval: true }))).toEqual(['+3 versions', 'rebase seul', '✓ approuvée']);
        expect(badges(card({ newCodeVersions: null, newComments: 0 }))).toEqual(['+3 versions']);
    });

    it('M7: a draft says so first', () => {
        expect(badges(card({ draft: true, newComments: 0 }))).toEqual(['brouillon', '+3 versions', 'dont 1 avec du code']);
        expect(cardBadges(en, card({ draft: true, newVersions: 0, newComments: 0 }), me).map((b) => b.text)).toEqual(['draft']);
    });

    it('never reviewed: with the version count, or without it if unknown (light card)', () => {
        expect(badges(card({ lastReviewed: null, newComments: 0 }))).toEqual(['pas encore relue · 10 versions']);
        expect(badges(card({ lastReviewed: null, versionsCount: null, newComments: 0 }))).toEqual(['pas encore relue']);
    });

    it('subtitle; my PR: "you", no versions badge', () => {
        expect(cardSubtitle(fr, card({}), me)).toBe('Auteur · ouverte depuis 22 j · push il y a 2 h · 2/2 approbations');
        expect(cardSubtitle(en, card({}), me)).toBe('Auteur · open for 22 days · pushed 2 hours ago · 2/2 approvals');
        // Approvals against the required minimum, shown even at 0.
        expect(cardSubtitle(en, card({ approvals: 0, requiredApprovals: 1 }), me)).toMatch(/ · 0\/1 approvals$/);
        expect(cardSubtitle(fr, card({ approvals: 1, requiredApprovals: 3 }), me)).toMatch(/ · 1\/3 approbation$/);
        const mine = card({ author: me, lastReviewed: null, newComments: 1, approvals: 1 });
        expect(cardSubtitle(fr, mine, me)).toMatch(/^toi · /);
        expect(badges(mine)).toEqual(['💬 1 nouveau']);
    });
});

describe('home notices', () => {
    it('I5: a repository whose open PR list was cut', () => {
        expect(truncatedNotice(en, { repo: 'acme/records-api', count: 200 })).toBe('acme/records-api: only the first 200 open PRs are listed.');
        expect(truncatedNotice(fr, { repo: 'acme/records-api', count: 200 })).toBe('acme/records-api : seules les 200 premières PR ouvertes sont listées.');
    });

    it('group titles: "To review" and "To rebase", in English and in French', () => {
        const titles = (tr: typeof fr): string[] => (['to-do', 'to-rebase', 'mine', 'waiting', 'others'] as const).map((key) => tr.t(GROUP_TITLES[key]));
        expect(titles(en)).toEqual(['To review', 'To rebase', 'My PRs', 'Waiting on the author', 'Other open PRs']);
        expect(titles(fr)).toEqual(['À relire', 'À rebaser', 'Mes PR', 'En attente de l\'auteur', 'Autres PR ouvertes']);
    });

    it('hidden PRs of unfollowed contributors: a discreet count', () => {
        expect(fr.t('home.hidden', { count: 12 })).toBe('12 PR masquées (contributeurs non suivis)');
        expect(fr.t('home.hidden', { count: 1 })).toBe('1 PR masquée (contributeur non suivi)');
        expect(en.t('home.hidden', { count: 12 })).toBe('12 PRs hidden (contributors you don’t follow)');
        expect(en.t('home.hidden', { count: 1 })).toBe('1 PR hidden (a contributor you don’t follow)');
    });
});

describe('threads', () => {
    const { data } = prLong();

    it('groups: new, open, resolved', () => {
        const g = threadGroups(data.threads);
        expect(g.fresh.map((t) => t.id)).toEqual([120]);
        expect(g.open.map((t) => t.id)).toEqual([110]);
        expect(g.resolved.map((t) => t.id).sort()).toEqual([101, 103, 105]);
    });

    it('new threads and replies since my review', () => {
        expect(newActivity(data.threads)).toEqual({ newThreads: 1, replies: 1, names: ['Yann', 'Camille'] });
    });

    it('avatar initials', () => {
        expect(initials('Yann Bernard')).toBe('YB');
        expect(initials('review-bot')).toBe('RE');
        expect(initials('')).toBe('?');
    });
});
