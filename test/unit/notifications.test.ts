import { describe, expect, it } from 'vitest';
import type { Home, HomeGroupKey, PrCard, User } from '../../src/shared/api.ts';
import type { NotificationPrefs } from '../../src/shared/review-settings.ts';
import type { NotifiedState } from '../../src/server/infra/config.ts';
import {
    capNotifications, codeChangedSince, forgetRepositories, planNotifications, versionCandidates, type CodeChanges, type PendingNotification,
} from '../../src/extension/lib/notifications.ts';

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
function run(home: Home, state: NotifiedState, prefs: NotificationPrefs = ALL_ON, codeChanged: CodeChanges = {}): { sent: string[]; next: NotifiedState } {
    const plan = planNotifications(home, prefs, state, codeChanged);
    return { sent: plan.notifications.map((n) => `${n.kind} #${n.ref.id}`), next: plan.next };
}

/** Heads recorded for a key, most recent first. */
const headsIn = (state: NotifiedState, key: string): string[] => (state.seen[key] ?? '').split(' ').filter(Boolean);

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

        it('only neutral versions since the previous head (codeChanged false): none, the head is recorded', () => {
            const home = homeOf({ waiting: [card(23, { lastReviewed: 1, newCodeVersions: 1, head: headOf(23, 2) })] });
            const { sent, next } = run(home, baseline, ALL_ON, { [`${REPO}#23`]: false });
            expect(sent).toEqual([]);
            expect(headsIn(next, `${REPO}#23`)).toEqual([headOf(23, 2), headOf(23, 1)]);
        });

        it('code since the previous head notifies, whatever newCodeVersions says; a failed check (null) counts as code', () => {
            const home = homeOf({ 'to-do': [card(20, { lastReviewed: 1, newCodeVersions: 0, head: headOf(20, 2) }), card(23, { lastReviewed: 1, head: headOf(23, 2) })] });
            expect(run(home, baseline, ALL_ON, { [`${REPO}#20`]: true, [`${REPO}#23`]: null }).sent).toEqual(['newVersion #20', 'newVersion #23']);
        });

        it('approval only, then a rebase: none', () => {
            const home = homeOf({ waiting: [card(21, { myApproval: true, head: headOf(21, 2) })] });
            expect(run(home, baseline, ALL_ON, { [`${REPO}#21`]: false }).sent).toEqual([]);
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
            expect(headsIn(off.next, `${REPO}#40`)[0]).toBe(headOf(40, 2));
            expect(off.next.seen[`${REPO}#42`]).toBe(headOf(42));
            expect(off.next.seen[`${REPO}#41#build`]).toBe(headOf(41));
            expect(run(changed, off.next, ALL_ON).sent).toEqual([]);
        });

        it('a preference off does not hide another kind due for the same PR', () => {
            const baseline = baselineOf(homeOf({ 'to-do': [card(46, { lastReviewed: 1 })] }));
            const home = homeOf({ 'to-do': [card(46, { lastReviewed: 1, designatedReviewer: true, head: headOf(46, 2) })] });
            expect(run(home, baseline, { ...ALL_ON, newVersion: false }).sent).toEqual(['newPullRequest #46']);
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

        it('closed PRs of a repository read without error are forgotten; repositories this home does not track are kept', () => {
            const baseline = baselineOf(homeOf({ 'to-do': [card(58), card(59), other(60)] }, { repos: [REPO, OTHER] }));
            const { next } = run(homeOf({ 'to-do': [card(58)] }), baseline);
            expect(Object.keys(next.seen).filter((key) => key.includes('#')).sort()).toEqual([`${REPO}#58`, `${OTHER}#60`]);
            expect(next.seen[OTHER]).toBe(baseline.seen[OTHER]);
        });

        it('I1: two windows tracking different repositories, polling in turn: each new followed "to-do" PR notifies once', () => {
            // Window A tracks records-api, window B records-web (workspace-level settings), one shared state.json.
            const windowA = (...ids: number[]): Home => homeOf({ 'to-do': ids.map((id) => card(id, { followed: true })) });
            const windowB = (...ids: number[]): Home => homeOf({ 'to-do': ids.map((id) => other(id, { followed: true })) }, { repos: [OTHER] });
            let state = EMPTY;
            const poll = (home: Home): string[] => {
                const result = run(home, state);
                state = result.next;
                return result.sent;
            };
            expect(poll(windowA(1))).toEqual([]);
            expect(poll(windowB(101))).toEqual([]);
            expect(poll(windowA(1, 2))).toEqual(['newPullRequest #2']);
            expect(poll(windowB(101, 102))).toEqual(['newPullRequest #102']);
            expect(poll(windowA(1, 2, 3))).toEqual(['newPullRequest #3']);
            expect(poll(windowB(101, 102))).toEqual([]);
            expect(poll(windowA(1, 2, 3))).toEqual([]);
        });

        it('forgetRepositories drops every entry of the given repositories and keeps the others', () => {
            const baseline = baselineOf(homeOf({ 'to-do': [card(61, { designatedReviewer: true })], mine: [other(62, { author: ME, build: failedBuild })] }, { repos: [REPO, OTHER] }));
            const next = forgetRepositories(baseline, [OTHER]);
            expect(Object.keys(next.seen).sort()).toEqual([REPO, `${REPO}#61`, `${REPO}#61#reviewer`]);
            expect(next.initialized).toBe(true);
            expect(forgetRepositories(baseline, [])).toEqual(baseline);
        });
    });

    describe('Review Focus 5: a stale home in another window', () => {
        it('a head among the last three recorded is not new: no notification, the list is unchanged', () => {
            let state = baselineOf(homeOf({ 'to-do': [card(70, { lastReviewed: 1 })] }));
            const at = (version: number): Home => homeOf({ 'to-do': [card(70, { lastReviewed: 1, head: headOf(70, version) })] });
            const second = run(at(2), state);
            expect(second.sent).toEqual(['newVersion #70']);
            state = second.next;
            const stale = run(at(1), state);
            expect(stale.sent).toEqual([]);
            expect(headsIn(stale.next, `${REPO}#70`)).toEqual([headOf(70, 2), headOf(70, 1)]);
            expect(run(at(2), stale.next).sent).toEqual([]);
        });

        it('keeps at most three heads, most recent first', () => {
            let state = baselineOf(homeOf({ 'to-do': [card(71, { lastReviewed: 1 })] }));
            for (const version of [2, 3, 4]) {
                state = run(homeOf({ 'to-do': [card(71, { lastReviewed: 1, head: headOf(71, version) })] }), state).next;
            }
            expect(headsIn(state, `${REPO}#71`)).toEqual([headOf(71, 4), headOf(71, 3), headOf(71, 2)]);
        });

        it('a failed build head among the recorded ones is not notified again', () => {
            const mine = (version: number): Home => homeOf({ mine: [card(72, { author: ME, build: failedBuild, head: headOf(72, version) })] });
            const first = run(mine(2), baselineOf(mine(1)));
            expect(first.sent).toEqual(['buildFailed #72']);
            expect(run(mine(1), first.next).sent).toEqual([]);
        });
    });

    describe('designated reviewer later', () => {
        const before = homeOf({ 'to-do': [card(80)], waiting: [card(81, { myApproval: true })] });
        const baseline = baselineOf(before);

        it('designated on a PR already seen: one newPullRequest, once', () => {
            const home = homeOf({ 'to-do': [card(80, { designatedReviewer: true })], waiting: [card(81, { myApproval: true })] });
            const first = run(home, baseline);
            expect(first.sent).toEqual(['newPullRequest #80']);
            expect(first.next.seen[`${REPO}#80#reviewer`]).toBeDefined();
            expect(run(home, first.next).sent).toEqual([]);
        });

        it('designated while nothing is to do (already approved): recorded, no notification, nor later', () => {
            const waiting = homeOf({ 'to-do': [card(80)], waiting: [card(81, { myApproval: true, designatedReviewer: true })] });
            const first = run(waiting, baseline);
            expect(first.sent).toEqual([]);
            const later = homeOf({ 'to-do': [card(80), card(81, { designatedReviewer: true })] });
            expect(run(later, first.next).sent).toEqual([]);
        });

        it('designated from the start (new PR, or at baseline): no second notification', () => {
            const fresh = run(homeOf({ 'to-do': [card(80), card(82, { designatedReviewer: true })] }), baseline);
            expect(fresh.sent).toEqual(['newPullRequest #82']);
            expect(run(homeOf({ 'to-do': [card(80), card(82, { designatedReviewer: true })] }), fresh.next).sent).toEqual([]);
            const atBaseline = baselineOf(homeOf({ 'to-do': [card(83, { designatedReviewer: true })] }));
            expect(run(homeOf({ 'to-do': [card(83, { designatedReviewer: true })] }), atBaseline).sent).toEqual([]);
        });
    });

    it('I4: a head whose versions are not readable yet (pending) is neither notified nor recorded, then notified once', () => {
        const baseline = baselineOf(homeOf({ 'to-do': [card(92, { lastReviewed: 1 })], mine: [card(93, { author: ME })] }));
        const pushed = homeOf({ 'to-do': [card(92, { lastReviewed: 1, designatedReviewer: true, head: headOf(92, 2) })], mine: [card(93, { author: ME })] });
        const lagging = run(pushed, baseline, ALL_ON, { [`${REPO}#92`]: 'pending' });
        expect(lagging.sent).toEqual([]);
        expect(lagging.next.seen[`${REPO}#92`]).toBe(baseline.seen[`${REPO}#92`]);
        expect(lagging.next.seen[`${REPO}#92#reviewer`]).toBeUndefined();
        expect(versionCandidates(pushed, lagging.next).map((c) => c.ref.id)).toEqual([92]);
        const caughtUp = run(pushed, lagging.next, ALL_ON, { [`${REPO}#92`]: true });
        expect(caughtUp.sent).toEqual(['newVersion #92']);
        expect(run(pushed, caughtUp.next).sent).toEqual([]);
    });

    it('a card without a head keeps what was recorded for it', () => {
        const home = homeOf({ 'to-do': [card(90, { designatedReviewer: true })], mine: [card(91, { author: ME, build: failedBuild })] });
        const baseline = baselineOf(home);
        const { next } = run(homeOf({ 'to-do': [card(90, { designatedReviewer: true, head: '' })], mine: [card(91, { author: ME, build: failedBuild, head: '' })] }), baseline);
        for (const key of [`${REPO}#90`, `${REPO}#90#reviewer`, `${REPO}#91`, `${REPO}#91#build`]) {
            expect(next.seen[key], key).toBe(baseline.seen[key]);
        }
    });
});

describe('new version candidates and code check', () => {
    const before = homeOf({
        'to-do': [card(1, { lastReviewed: 1 }), card(2, { myApproval: true }), card(3), card(4, { lastReviewed: 1 })],
        mine: [card(5, { author: ME, lastReviewed: 1 })],
    });
    const state = baselineOf(before);

    it('candidates: someone else\'s PR I reviewed or approved, with a head not recorded yet, in a baselined repository', () => {
        const home = homeOf({
            'to-do': [
                card(1, { lastReviewed: 1, head: headOf(1, 2) }), card(2, { myApproval: true, head: headOf(2, 2) }),
                card(3, { head: headOf(3, 2) }), card(4, { lastReviewed: 1 }), card(6, { lastReviewed: 1 }),
                card(7, { repo: 'records-web', lastReviewed: 1, head: headOf(7, 2) }),
            ],
            mine: [card(5, { author: ME, lastReviewed: 1, head: headOf(5, 2) })],
        }, { repos: [REPO, 'acme/records-web'] });
        expect(versionCandidates(home, state)).toEqual([
            { ref: { workspace: 'acme', repo: 'records-api', id: 1 }, previousHead: headOf(1, 1), head: headOf(1, 2) },
            { ref: { workspace: 'acme', repo: 'records-api', id: 2 }, previousHead: headOf(2, 1), head: headOf(2, 2) },
        ]);
        expect(versionCandidates(home, EMPTY)).toEqual([]);
    });

    const v = (name: string, kind: Parameters<typeof codeChangedSince>[0][number]['kind']): { hash: string; kind: typeof kind } => ({ hash: `${name}`.padEnd(40, '0'), kind });

    it('code check since the previous head, up to the current head', () => {
        const head = (name: string): string => name.padEnd(12, '0');
        // Rebase only after the previous head.
        expect(codeChangedSince([v('aaa', 'creation'), v('bbb', 'rebase-only')], head('aaa'), head('bbb'))).toBe(false);
        // Code after the previous head.
        expect(codeChangedSince([v('aaa', 'creation'), v('bbb', 'rebase-only'), v('ccc', 'code')], head('aaa'), head('ccc'))).toBe(true);
        expect(codeChangedSince([v('aaa', 'creation'), v('bbb', 'deps')], head('aaa'), head('bbb'))).toBe(true);
        // An earlier code version (seen, never reviewed) then a rebase-only push: only what follows the previous head counts.
        expect(codeChangedSince([v('aaa', 'creation'), v('bbb', 'code'), v('ccc', 'rebase-only')], head('bbb'), head('ccc'))).toBe(false);
        expect(codeChangedSince([v('aaa', 'creation'), v('bbb', 'message-only'), v('ccc', 'none')], head('aaa'), head('ccc'))).toBe(false);
        // Previous head no longer among the versions (force-push): only the last version is judged.
        expect(codeChangedSince([v('aaa', 'code'), v('ddd', 'rebase-only')], head('eee'), head('ddd'))).toBe(false);
        expect(codeChangedSince([v('aaa', 'rebase-only'), v('ddd', 'code')], head('eee'), head('ddd'))).toBe(true);
    });

    it('I4: versions that do not reach the current head yet (PR or activity lagging behind the list): null, not neutral', () => {
        const head = (name: string): string => name.padEnd(12, '0');
        expect(codeChangedSince([v('aaa', 'creation')], head('aaa'), head('bbb'))).toBeNull();
        expect(codeChangedSince([v('aaa', 'creation'), v('bbb', 'rebase-only')], head('aaa'), head('ccc'))).toBeNull();
    });
});

describe('burst cap', () => {
    const pending = (kind: PendingNotification['kind'], id: number): PendingNotification => ({ kind, ref: { workspace: 'acme', repo: 'records-api', id }, title: `PR ${id}`, author: null });

    it('5 pending: 3 shown (failed builds, then new PRs, then new versions), 2 in the summary', () => {
        const list = [pending('newVersion', 1), pending('newPullRequest', 2), pending('newVersion', 3), pending('buildFailed', 4), pending('newPullRequest', 5)];
        const { shown, overflow } = capNotifications(list);
        expect(shown.map((n) => `${n.kind} #${n.ref.id}`)).toEqual(['buildFailed #4', 'newPullRequest #2', 'newPullRequest #5']);
        expect(overflow.map((n) => n.ref.id)).toEqual([1, 3]);
    });

    it('3 or fewer: all shown, nothing in the summary', () => {
        expect(capNotifications([pending('newVersion', 1)])).toEqual({ shown: [pending('newVersion', 1)], overflow: [] });
    });
});
