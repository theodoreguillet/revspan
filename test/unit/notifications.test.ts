import { describe, expect, it } from 'vitest';
import type { Home, HomeGroupKey, PrCard, User } from '../../src/shared/api.ts';
import type { NotificationPrefs } from '../../src/shared/review-settings.ts';
import type { NotifiedState } from '../../src/server/infra/config.ts';
import { planNotifications } from '../../src/extension/lib/notifications.ts';

const ME: User = { uuid: '{me}', displayName: 'Robin Martin' };
const CAM: User = { uuid: '{cam}', displayName: 'Camille Durand' };
const REPO = 'acme/records-api';
const ALL_ON: NotificationPrefs = { newPullRequest: true, newVersion: true, buildFailed: true };
const ALL_OFF: NotificationPrefs = { newPullRequest: false, newVersion: false, buildFailed: false };
const EMPTY: NotifiedState = { initialized: false, seen: {} };

const headOf = (id: number, version = 1): string => `${id}v${version}`.padEnd(12, 'a');

const card = (id: number, over: Partial<PrCard> = {}): PrCard => ({
    workspace: 'acme', repo: 'records-api', id, title: `PR ${id}`, author: CAM, url: '', createdOn: '', updatedOn: '',
    versionsCount: null, lastPushAt: '', lastReviewed: null, newVersions: 0, newCodeVersions: null, approvals: 0,
    requiredApprovals: 2, myApproval: false, newComments: 0, needsReview: true, designatedReviewer: false, followed: false,
    approvalHolds: false, build: null, needsRebase: null, head: headOf(id), ...over,
});

const homeOf = (groups: Partial<Record<HomeGroupKey, PrCard[]>>, over: Partial<Home> = {}): Home => ({
    me: ME,
    repos: [REPO],
    errors: [],
    groups: (['to-do', 'mine', 'waiting', 'others'] as const).map((key) => ({ key, prs: groups[key] ?? [] })),
    ...over,
});

const failedBuild = { state: 'failed', failed: 1, running: 0, total: 1 } as const;

/** Runs the planner and returns its notifications as "kind #id", with the next state. */
function run(home: Home, state: NotifiedState, prefs: NotificationPrefs = ALL_ON): { sent: string[]; next: NotifiedState } {
    const plan = planNotifications(home, prefs, state);
    return { sent: plan.notifications.map((n) => `${n.kind} #${n.ref.id}`), next: plan.next };
}

/** State after a first (silent) run on `home`. */
const baselineOf = (home: Home): NotifiedState => run(home, EMPTY).next;

describe('notification planner', () => {
    const populated = homeOf({
        'to-do': [card(1, { followed: true }), card(2, { designatedReviewer: true }), card(3, { lastReviewed: 1, newCodeVersions: 1 })],
        mine: [card(4, { author: ME, build: failedBuild })],
        waiting: [card(5, { myApproval: true, lastReviewed: 2, newCodeVersions: 0 })],
        others: [card(6)],
    });

    it('first run: no notification, every PR head recorded as the baseline', () => {
        const { sent, next } = run(populated, EMPTY);
        expect(sent).toEqual([]);
        expect(next.initialized).toBe(true);
        for (const id of [1, 2, 3, 4, 5, 6]) {
            expect(next.seen[`${REPO}#${id}`], `#${id}`).toBe(headOf(id));
        }
        expect(next.seen[`${REPO}#4#build`]).toBe(headOf(4));
    });

    it('does not mutate the state it is given', () => {
        const state = baselineOf(populated);
        const copy = structuredClone(state);
        run(homeOf({ 'to-do': [card(9, { followed: true })] }), state);
        expect(state).toEqual(copy);
    });

    it('the same home twice: nothing the second time', () => {
        const first = run(homeOf({ 'to-do': [card(1, { followed: true })] }), baselineOf(homeOf({})));
        expect(first.sent).toEqual(['newPullRequest #1']);
        expect(run(homeOf({ 'to-do': [card(1, { followed: true })] }), first.next).sent).toEqual([]);
    });

    describe('new PR', () => {
        const baseline = baselineOf(populated);

        it('a new "to-do" PR from a followed contributor gives one notification, with its title and author', () => {
            const home = homeOf({ 'to-do': [card(10, { followed: true, title: 'Archive records' })] });
            const plan = planNotifications(home, ALL_ON, baseline);
            expect(plan.notifications).toEqual([{
                kind: 'newPullRequest', ref: { workspace: 'acme', repo: 'records-api', id: 10 }, title: 'Archive records', author: 'Camille Durand',
            }]);
            expect(plan.next.seen[`${REPO}#10`]).toBe(headOf(10));
        });

        it('a designated reviewer PR from a contributor who is not followed gives one', () => {
            expect(run(homeOf({ 'to-do': [card(11, { designatedReviewer: true, author: null })] }), baseline).sent).toEqual(['newPullRequest #11']);
        });

        it('neither followed nor designated, or outside "to-do": none, but the head is recorded', () => {
            const home = homeOf({ 'to-do': [card(12)], others: [card(13, { followed: true })], waiting: [card(14, { designatedReviewer: true })] });
            const { sent, next } = run(home, baseline);
            expect(sent).toEqual([]);
            expect(next.seen[`${REPO}#12`]).toBe(headOf(12));
            expect(next.seen[`${REPO}#13`]).toBe(headOf(13));
        });

        it('an already seen PR that enters "to-do" (new head, never reviewed): none', () => {
            const home = homeOf({ 'to-do': [card(6, { followed: true, head: headOf(6, 2) })] });
            expect(run(home, baseline).sent).toEqual([]);
        });
    });

    describe('new version', () => {
        const before = homeOf({
            'to-do': [card(20, { lastReviewed: 1, newCodeVersions: 0 }), card(21, { myApproval: true }), card(22), card(23, { lastReviewed: 1 })],
            mine: [card(24, { author: ME, lastReviewed: 1 })],
        });
        const baseline = baselineOf(before);

        it('a new head with code on a PR I reviewed, or only approved, gives newVersion', () => {
            const home = homeOf({
                'to-do': [
                    card(20, { lastReviewed: 1, newCodeVersions: 1, head: headOf(20, 2) }),
                    card(21, { myApproval: true, newCodeVersions: null, head: headOf(21, 2) }),
                ],
            });
            expect(run(home, baseline).sent).toEqual(['newVersion #20', 'newVersion #21']);
        });

        it('a new head with only a rebase (newCodeVersions === 0): none, the head is recorded', () => {
            const home = homeOf({ waiting: [card(23, { lastReviewed: 1, newCodeVersions: 0, head: headOf(23, 2) })] });
            const { sent, next } = run(home, baseline);
            expect(sent).toEqual([]);
            expect(next.seen[`${REPO}#23`]).toBe(headOf(23, 2));
        });

        it('a new head on a PR I never reviewed nor approved: none', () => {
            expect(run(homeOf({ 'to-do': [card(22, { newCodeVersions: 1, head: headOf(22, 2) })] }), baseline).sent).toEqual([]);
        });

        it('my own push on my PR: none, even when I commented on it', () => {
            expect(run(homeOf({ mine: [card(24, { author: ME, lastReviewed: 1, newCodeVersions: 1, head: headOf(24, 2) })] }), baseline).sent).toEqual([]);
        });

        it('a new version that also matches "new PR" (followed, designated) gives a single notification', () => {
            const state = baselineOf(homeOf({ 'to-do': [card(25, { lastReviewed: 1 })] }));
            const home = homeOf({ 'to-do': [card(25, { followed: true, designatedReviewer: true, lastReviewed: 1, newCodeVersions: 2, head: headOf(25, 2) })] });
            expect(run(home, state).sent).toEqual(['newVersion #25']);
        });
    });

    describe('failed build', () => {
        const mine = (version: number, build: PrCard['build']): Home => homeOf({ mine: [card(30, { author: ME, build, head: headOf(30, version) })] });
        const baseline = baselineOf(mine(1, null));

        it('fires once per head', () => {
            const first = run(mine(1, failedBuild), baseline);
            expect(first.sent).toEqual(['buildFailed #30']);
            expect(first.next.seen[`${REPO}#30#build`]).toBe(headOf(30, 1));
            const again = run(mine(1, failedBuild), first.next);
            expect(again.sent).toEqual([]);
            const running = run(mine(2, { state: 'running', failed: 0, running: 1, total: 1 }), again.next);
            expect(running.sent).toEqual([]);
            expect(run(mine(2, failedBuild), running.next).sent).toEqual(['buildFailed #30']);
        });

        it('only on my own PRs', () => {
            expect(run(homeOf({ 'to-do': [card(30, { build: failedBuild })] }), baseline).sent).toEqual([]);
        });
    });

    describe('disabled preferences', () => {
        it('nothing is notified, but the state is updated, so enabling them later notifies nothing old', () => {
            const baseline = baselineOf(homeOf({ 'to-do': [card(40, { lastReviewed: 1 })], mine: [card(41, { author: ME })] }));
            const changed = homeOf({
                'to-do': [card(40, { lastReviewed: 1, newCodeVersions: 1, head: headOf(40, 2) }), card(42, { followed: true })],
                mine: [card(41, { author: ME, build: failedBuild })],
            });
            const off = run(changed, baseline, ALL_OFF);
            expect(off.sent).toEqual([]);
            expect(off.next.seen[`${REPO}#40`]).toBe(headOf(40, 2));
            expect(off.next.seen[`${REPO}#42`]).toBe(headOf(42));
            expect(off.next.seen[`${REPO}#41#build`]).toBe(headOf(41));
            expect(run(changed, off.next, ALL_ON).sent).toEqual([]);
        });

        it('each preference only gates its own kind', () => {
            const baseline = baselineOf(homeOf({ 'to-do': [card(43, { lastReviewed: 1 })], mine: [card(44, { author: ME })] }));
            const changed = homeOf({
                'to-do': [card(43, { lastReviewed: 1, newCodeVersions: 1, head: headOf(43, 2) }), card(45, { followed: true })],
                mine: [card(44, { author: ME, build: failedBuild })],
            });
            expect(run(changed, baseline, { ...ALL_OFF, newPullRequest: true }).sent).toEqual(['newPullRequest #45']);
            expect(run(changed, baseline, { ...ALL_OFF, newVersion: true }).sent).toEqual(['newVersion #43']);
            expect(run(changed, baseline, { ...ALL_OFF, buildFailed: true }).sent).toEqual(['buildFailed #44']);
        });
    });

    describe('Review Focus 4: first poll and option switched on', () => {
        it('first poll after install on a populated home: zero, with every option on', () => {
            expect(run(populated, EMPTY, ALL_ON).sent).toEqual([]);
        });

        it('an option switched on over a populated home: zero', () => {
            const quiet = run(populated, EMPTY, ALL_OFF).next;
            expect(run(populated, quiet, ALL_OFF).sent).toEqual([]);
            expect(run(populated, quiet, ALL_ON).sent).toEqual([]);
        });

        it('a head that changed while VS Code was closed gives exactly one notification on the next poll', () => {
            const baseline = baselineOf(populated);
            const reopened = homeOf({
                ...Object.fromEntries(populated.groups.map((g) => [g.key, g.prs])),
                'to-do': [card(1, { followed: true }), card(2, { designatedReviewer: true }), card(3, { lastReviewed: 1, newCodeVersions: 2, head: headOf(3, 3) })],
            });
            const first = run(reopened, baseline);
            expect(first.sent).toEqual(['newVersion #3']);
            expect(run(reopened, first.next).sent).toEqual([]);
        });
    });

    describe('tracked repositories', () => {
        const OTHER = 'acme/records-web';
        const other = (id: number, over: Partial<PrCard> = {}): PrCard => card(id, { repo: 'records-web', ...over });

        it('a newly tracked repository is recorded silently, then notifies like the others', () => {
            const baseline = baselineOf(homeOf({ 'to-do': [card(50)] }));
            const added = homeOf({ 'to-do': [card(50), other(51, { followed: true })] }, { repos: [REPO, OTHER] });
            const first = run(added, baseline);
            expect(first.sent).toEqual([]);
            expect(first.next.seen[`${OTHER}#51`]).toBe(headOf(51));
            const later = homeOf({ 'to-do': [card(50), other(51, { followed: true }), other(52, { followed: true })] }, { repos: [REPO, OTHER] });
            expect(run(later, first.next).sent).toEqual(['newPullRequest #52']);
        });

        it('a repository that could not be read keeps its records and is not baselined', () => {
            const two = homeOf({ 'to-do': [card(53), other(54, { lastReviewed: 1 })] }, { repos: [REPO, OTHER] });
            const baseline = baselineOf(two);
            const failing = homeOf({ 'to-do': [card(53)] }, { repos: [REPO, OTHER], errors: [{ repo: OTHER, code: 'BB_UNREACHABLE', message: 'down' }] });
            const during = run(failing, baseline);
            expect(during.next.seen[`${OTHER}#54`]).toBe(headOf(54));
            const back = homeOf({ 'to-do': [card(53), other(54, { lastReviewed: 1, newCodeVersions: 1, head: headOf(54, 2) }), other(55, { followed: true })] }, { repos: [REPO, OTHER] });
            expect(run(back, during.next).sent).toEqual(['newVersion #54', 'newPullRequest #55']);
        });

        it('a repository failing on the first run does not notify its backlog later', () => {
            const failing = homeOf({ 'to-do': [card(56)] }, { repos: [REPO, OTHER], errors: [{ repo: OTHER, code: 'BB_UNREACHABLE', message: 'down' }] });
            const first = run(failing, EMPTY);
            const back = homeOf({ 'to-do': [card(56), other(57, { followed: true })] }, { repos: [REPO, OTHER] });
            expect(run(back, first.next).sent).toEqual([]);
        });

        it('closed PRs and untracked repositories are forgotten', () => {
            const baseline = baselineOf(homeOf({ 'to-do': [card(58), card(59), other(60)] }, { repos: [REPO, OTHER] }));
            const { next } = run(homeOf({ 'to-do': [card(58)] }), baseline);
            expect(Object.keys(next.seen).filter((key) => key.includes('#')).sort()).toEqual([`${REPO}#58`]);
        });
    });
});
