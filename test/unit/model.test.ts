import { describe, expect, it } from 'vitest';
import type { BbActivity, BbComment, BbPullRequest, BbTask, BbUser } from '../../src/server/bitbucket/types.ts';
import {
    buildParticipants, buildThreads, buildVersions, computeReview, extractUpdates, previousAvailable, prInfo, taskOf, versionAt,
} from '../../src/server/core/model.ts';

const ME = '{me}';
const CAM = '{cam}';
const YAN = '{yan}';
const user = (uuid: string, name: string): BbUser => ({ uuid, display_name: name, nickname: name });
const update = (date: string, hash: string, dest: string): BbActivity => ({
    update: { date, source: { commit: { hash } }, destination: { commit: { hash: dest } }, author: user(CAM, 'Camille') },
});

const activity: BbActivity[] = [
    update('2026-11-05T12:17:09Z', '178703a1c7dc', '070b8d3e316b'),
    { approval: { date: '2026-11-05T13:14:44Z', user: user(YAN, 'Yann') } },
    update('2026-11-05T10:26:43Z', '2a2fc206db7e', '070b8d3e316b'),
    { approval: { date: '2026-11-03T15:03:05Z', user: user(ME, 'Moi') } },
    update('2026-11-03T14:43:20Z', 'a0a11ced5099', 'e69769e6706e'),
    update('2026-10-14T09:10:37.271Z', '8e1996bab906', '23a898a5824a'),
    update('2026-10-14T09:10:37.133Z', '8e1996bab906', '23a898a5824a'),
];
const pr: BbPullRequest = {
    id: 212,
    source: { commit: { hash: '178703a1c7dc' } },
    destination: { commit: { hash: '070b8d3e316b' } },
    participants: [
        { user: user(YAN, 'Yann'), role: 'PARTICIPANT', approved: true, state: 'approved' },
        { user: user(ME, 'Moi'), role: 'REVIEWER', approved: true, state: 'approved' },
        { user: user(CAM, 'Camille'), role: 'PARTICIPANT', approved: false, state: null },
    ],
};

function versionsFixture(): ReturnType<typeof buildVersions> {
    const updates = extractUpdates(activity, pr);
    const commits = updates.map((u, i) => ({ hash: `${u.hash}0000`, message: i === 2 ? 'msg v3' : 'msg', parents: [`parent${i}`] }));
    return buildVersions(updates, commits, ['e1d4f60', 'e69769e', '070b8d3', '070b8d3']);
}

describe('extractUpdates', () => {
    it('chronological order, duplicates removed', () => {
        expect(extractUpdates(activity, pr).map((u) => u.hash)).toEqual(['8e1996bab906', 'a0a11ced5099', '2a2fc206db7e', '178703a1c7dc']);
    });

    it('adds the current version missing from the activity', () => {
        const updates = extractUpdates(activity, { ...pr, source: { commit: { hash: '666600005555' } }, updated_on: '2026-11-06T00:00:00Z' });
        expect(updates).toHaveLength(5);
        expect(updates[4]!.hash).toBe('666600005555');
    });
});

describe('buildVersions / versionAt', () => {
    it('rebase, modified message, real base', () => {
        const versions = versionsFixture();
        expect(versions.map((v) => v.isRebase)).toEqual([false, true, true, false]);
        expect(versions.map((v) => v.messageChanged)).toEqual([false, false, true, true]);
        expect(versions[0]).toMatchObject({ shortHash: '8e1996b', base: 'e1d4f60' });
    });

    it('versionAt', () => {
        const versions = versionsFixture();
        expect(versionAt(versions, '2026-11-03T15:03:05Z')).toBe(2);
        expect(versionAt(versions, '2026-11-05T11:02:08Z')).toBe(3);
        expect(versionAt(versions, '2020-01-01T00:00:00Z')).toBe(1);
    });

    it('commit erased by Bitbucket: version unavailable, rebase and message compared with the last readable version', () => {
        const updates = extractUpdates(activity, pr);
        // v2 erased; v3 has the same base as v1 and the same message: neither rebase nor modified message.
        const commits = [
            { hash: '8e1996ba0000', message: 'msg', parents: ['p0'] },
            null,
            { hash: '2a2fc2060000', message: 'msg', parents: ['p2'] },
            { hash: '178703a10000', message: 'msg', parents: ['p3'] },
        ];
        const versions = buildVersions(updates, commits, ['e1d4f60', null, 'e1d4f60', '070b8d3']);
        expect(versions.map((v) => [v.available, v.isRebase, v.messageChanged])).toEqual([
            [true, false, false], [false, false, false], [true, false, false], [true, true, false],
        ]);
        expect(versions[1]).toMatchObject({ hash: 'a0a11ced5099', base: '', message: '' });
        expect([1, 2, 3, 4].map((index) => previousAvailable(versions, index))).toEqual([0, 1, 1, 3]);
    });
});

describe('computeReview', () => {
    const myComment = (raw: string, extra: Partial<BbComment> = {}): BbComment => ({
        id: 1, user: user(ME, 'Moi'), created_on: '2026-11-05T11:00:00Z', deleted: false, content: { raw }, ...extra,
    });

    it('the most recent of approval and local mark', () => {
        const versions = versionsFixture();
        expect(computeReview({ versions, activity, meUuid: ME, local: null }))
            .toEqual({ lastReviewed: 2, lastReviewedSource: 'approval', lastReviewedAt: '2026-11-03T15:03:05Z', viewed: {} });
        const local = { reviewedHash: '178703a1c7dc0000', reviewedAt: '2026-11-05T14:00:00Z', viewed: { 'a.ts': 'h' } };
        expect(computeReview({ versions, activity, meUuid: ME, local }))
            .toMatchObject({ lastReviewed: 4, lastReviewedSource: 'local', viewed: { 'a.ts': 'h' } });
        expect(computeReview({ versions, activity, meUuid: null, local: null }).lastReviewed).toBeNull();
    });

    it('a comment of mine does not count as a review', () => {
        const versions = versionsFixture();
        expect(computeReview({ versions, activity: [{ comment: myComment('Nit') }], meUuid: ME, local: null }))
            .toMatchObject({ lastReviewed: null, lastReviewedSource: null });
        expect(computeReview({ versions, activity, meUuid: ME, local: null }).lastReviewed).toBe(2);
    });

    it('a request for changes does not count as a review', () => {
        const versions = versionsFixture();
        const changes = [{ changes_requested: { user: user(ME, 'Moi'), date: '2026-11-05T11:00:00Z' } }];
        expect(computeReview({ versions, activity: changes, meUuid: ME, local: null }))
            .toMatchObject({ lastReviewed: null, lastReviewedSource: null, lastReviewedAt: null });
        // An earlier approval stays my last review, whatever change request follows it.
        expect(computeReview({ versions, activity: [...activity, ...changes], meUuid: ME, local: null }).lastReviewed).toBe(2);
    });
});

describe('buildParticipants', () => {
    it('approval version', () => {
        const participants = buildParticipants(pr, activity, versionsFixture());
        expect(participants.map((p) => [p.user?.displayName, p.state, p.approvedVersion]))
            .toEqual([['Yann', 'approved', 4], ['Moi', 'approved', 2], ['Camille', null, null]]);
    });
});

describe('buildThreads', () => {
    it('threads (nested replies included), emoji reactions, new, resolved, deleted', () => {
        const raw: BbComment[] = [
            {
                id: 10, created_on: '2026-11-05T11:02:08Z', user: user(YAN, 'Yann'),
                content: { raw: 'can we use the repository ?', html: '<p>can we use the repository ?</p>' },
                inline: { path: 'src/CreateRecord.ts', to: 40, from: null }, resolution: { user: user(YAN, 'Yann') },
            },
            { id: 11, created_on: '2026-11-05T12:20:00Z', user: user(CAM, 'Camille'), content: { raw: 'Done', html: '<p>Done</p>' }, parent: { id: 10 } },
            { id: 12, created_on: '2026-11-05T12:30:00Z', user: user(ME, 'Moi'), content: { raw: '👍' }, parent: { id: 11 } },
            { id: 13, created_on: '2026-11-05T12:31:00Z', user: user(YAN, 'Yann'), content: { raw: ':+1:' }, parent: { id: 11 } },
            { id: 14, created_on: '2026-10-14T09:19:00Z', user: user('{ai}', 'AI'), content: { raw: '## QA', html: '<h2>QA</h2>' } },
            { id: 15, created_on: '2026-10-29T00:00:00Z', user: user(CAM, 'Camille'), content: { raw: '' }, deleted: true },
            // a like taken back (Bitbucket blanks a deleted comment): neither a reaction nor a deleted comment
            { id: 16, created_on: '2026-11-05T12:40:00Z', user: user(CAM, 'Camille'), content: { raw: '', html: '' }, parent: { id: 10 }, deleted: true },
        ];
        const threads = buildThreads(raw, versionsFixture(), { meUuid: ME, sinceDate: '2026-11-05T11:00:00Z' });
        expect(threads.map((t) => t.id)).toEqual([14, 10]);
        const [general, inline] = threads;
        expect(general).toMatchObject({ path: null, version: 1 });
        expect(inline).toMatchObject({ path: 'src/CreateRecord.ts', anchor: { to: 40, from: null }, version: 3, resolved: true });
        // Replies made of a single emoji are reactions on the comment they answer, not comments (nor new ones).
        expect(inline!.comments.map((c) => [c.id, c.isNew, c.mine, c.parentId])).toEqual([[10, true, false, null], [11, true, false, 10]]);
        expect(inline!.comments[0]!.reactions).toEqual([]);
        expect(inline!.comments[1]!.reactions).toEqual([{
            emoji: '👍',
            users: [{ uuid: ME, displayName: 'Moi', nickname: 'Moi' }, { uuid: YAN, displayName: 'Yann', nickname: 'Yann' }],
            myCommentIds: [12],
        }]);
        expect(general!.comments[0]!.reactions).toEqual([]);
    });

    it('a deleted comment shows (as deleted) only while a shown reply is under it; a reaction alone does not keep it', () => {
        const at = (minute: number): string => `2026-11-05T12:${String(minute).padStart(2, '0')}:00Z`;
        const raw: BbComment[] = [
            { id: 30, created_on: at(0), user: user(YAN, 'Yann'), content: { raw: 'Why?', html: '<p>Why?</p>' } },
            { id: 31, created_on: at(1), user: user(CAM, 'Camille'), content: { raw: '', html: '' }, parent: { id: 30 }, deleted: true },
            { id: 32, created_on: at(2), user: user(YAN, 'Yann'), content: { raw: 'Answered above', html: '<p>Answered above</p>' }, parent: { id: 31 } },
            // my reply, deleted, nothing under it
            { id: 33, created_on: at(3), user: user(ME, 'Moi'), content: { raw: '', html: '' }, parent: { id: 30 }, deleted: true },
            // Camille's ✅ whose only reply (my 👍) was taken back: a reaction again
            { id: 34, created_on: at(4), user: user(CAM, 'Camille'), content: { raw: '✅' }, parent: { id: 30 } },
            { id: 35, created_on: at(5), user: user(ME, 'Moi'), content: { raw: '', html: '' }, parent: { id: 34 }, deleted: true },
            // a deleted root with only a like under it: the whole thread goes
            { id: 40, created_on: at(6), user: user(CAM, 'Camille'), content: { raw: '', html: '' }, deleted: true },
            { id: 41, created_on: at(7), user: user(YAN, 'Yann'), content: { raw: '👍' }, parent: { id: 40 } },
            // a like on the deleted comment kept by its reply: no reaction under a "Comment deleted" placeholder
            { id: 42, created_on: at(8), user: user(YAN, 'Yann'), content: { raw: '👍' }, parent: { id: 31 } },
        ];
        const threads = buildThreads(raw, versionsFixture(), { meUuid: ME, sinceDate: null });
        expect(threads.map((t) => t.id)).toEqual([30]);
        expect(threads[0]!.comments.map((c) => [c.id, c.parentId, c.deleted])).toEqual([[30, null, false], [31, 30, true], [32, 31, false]]);
        expect(threads[0]!.comments[0]!.reactions.map((r) => [r.emoji, r.users.map((u) => u.uuid)])).toEqual([['✅', [CAM]]]);
        expect(threads[0]!.comments[1]!.reactions).toEqual([]);
    });

    it('reactions: one per emoji, each user once in date order, all my replies kept; none of mine without my profile', () => {
        const raw: BbComment[] = [
            { id: 20, created_on: '2026-11-05T11:00:00Z', user: user(YAN, 'Yann'), content: { raw: 'Ready?' } },
            { id: 21, created_on: '2026-11-05T12:10:00Z', user: user(ME, 'Moi'), content: { raw: '👍' }, parent: { id: 20 } },
            { id: 22, created_on: '2026-11-05T12:00:00Z', user: user(CAM, 'Camille'), content: { raw: '🎉' }, parent: { id: 20 } },
            { id: 23, created_on: '2026-11-05T12:20:00Z', user: user(ME, 'Moi'), content: { raw: ':thumbsup:' }, parent: { id: 20 } },
            { id: 24, created_on: '2026-11-05T11:30:00Z', user: user(CAM, 'Camille'), content: { raw: '👍' }, parent: { id: 20 } },
        ];
        const [thread] = buildThreads(raw, versionsFixture(), { meUuid: ME, sinceDate: null });
        expect(thread!.comments.map((c) => c.id)).toEqual([20]);
        expect(thread!.comments[0]!.reactions.map((r) => [r.emoji, r.users.map((u) => u.uuid), r.myCommentIds])).toEqual([
            ['👍', [CAM, ME], [21, 23]],
            ['🎉', [CAM], []],
        ]);
        const [anonymous] = buildThreads(raw, versionsFixture(), { meUuid: null, sinceDate: null });
        expect(anonymous!.comments[0]!.reactions.map((r) => r.myCommentIds)).toEqual([[], []]);
    });
});

describe('tasks', () => {
    const ref = { workspace: 'acme', repo: 'records-api', id: 212 };

    it('prInfo maps summary.html to descriptionHtml (empty when absent) and draft only when true', () => {
        expect(prInfo(ref, { ...pr, summary: { html: '<p>Why</p>' } }).descriptionHtml).toBe('<p>Why</p>');
        expect(prInfo(ref, pr).descriptionHtml).toBe('');
        expect(prInfo(ref, { ...pr, draft: true }).draft).toBe(true);
        expect(prInfo(ref, { ...pr, draft: false }).draft).toBe(false);
        expect(prInfo(ref, pr).draft).toBe(false);
    });

    it('prInfo carries the open task count of the PR object (0 when absent)', () => {
        expect(prInfo(ref, { ...pr, task_count: 2 }).taskCount).toBe(2);
        expect(prInfo(ref, pr).taskCount).toBe(0);
    });

    it('taskOf maps a Bitbucket task: text, state, creator, resolver, comment, mine', () => {
        const raw: BbTask = {
            id: 31, state: 'RESOLVED', content: { raw: 'Add a test', html: '<p>Add a test</p>' }, creator: user(ME, 'Moi'),
            created_on: '2026-11-10T09:00:00Z', updated_on: '2026-11-11T09:00:00Z', resolved_by: user(CAM, 'Camille'), comment: { id: 120 },
        };
        expect(taskOf(raw, ME)).toEqual({
            id: 31, raw: 'Add a test', html: '<p>Add a test</p>', resolved: true, creator: { uuid: ME, displayName: 'Moi', nickname: 'Moi' },
            createdOn: '2026-11-10T09:00:00Z', resolvedBy: { uuid: CAM, displayName: 'Camille', nickname: 'Camille' }, commentId: 120, mine: true,
        });
        const open = taskOf({ id: 32, state: 'UNRESOLVED', content: { raw: 'x' }, creator: user(YAN, 'Yann'), created_on: '2026-11-10T09:00:00Z' }, ME);
        expect(open).toMatchObject({ resolved: false, resolvedBy: null, commentId: null, mine: false, html: '' });
        expect(taskOf({ id: 33, state: 'UNRESOLVED', content: { raw: 'x' }, creator: user(ME, 'Moi') }, null).mine).toBe(false);
    });
});
