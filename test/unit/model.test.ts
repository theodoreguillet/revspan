import { describe, expect, it } from 'vitest';
import type { BbActivity, BbComment, BbPullRequest, BbUser } from '../../src/server/bitbucket/types.ts';
import {
    approvalHoldsSince, buildParticipants, buildThreads, buildVersions, computeReview, extractUpdates, previousAvailable, versionAt,
} from '../../src/server/core/model.ts';

describe('approvalHoldsSince', () => {
    it('holds for the latest version if everything after the approved version is known and neutral', () => {
        expect(approvalHoldsSince(3, ['creation', 'deps', 'deps', 'rebase-only', 'rebase-only'])).toBe(true);
        expect(approvalHoldsSince(5, ['creation', 'code', 'code', 'code', 'code'])).toBe(true);
        expect(approvalHoldsSince(3, ['creation', 'deps', 'deps', 'rebase-only', 'code'])).toBe(false);
        expect(approvalHoldsSince(3, ['creation', 'deps', 'deps', undefined])).toBe(false);
        expect(approvalHoldsSince(null, ['creation'])).toBe(false);
    });
});

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

    it('the most recent of approval, new comment and local mark', () => {
        const versions = versionsFixture();
        expect(computeReview({ versions, activity, comments: [], meUuid: ME, local: null }))
            .toEqual({ lastReviewed: 2, lastReviewedSource: 'approval', lastReviewedAt: '2026-11-03T15:03:05Z', viewed: {} });
        expect(computeReview({ versions, activity, comments: [myComment('Nit')], meUuid: ME, local: null }).lastReviewed).toBe(3);
        const local = { reviewedHash: '178703a1c7dc0000', reviewedAt: '2026-11-05T14:00:00Z', viewed: { 'a.ts': 'h' } };
        expect(computeReview({ versions, activity, comments: [], meUuid: ME, local }))
            .toMatchObject({ lastReviewed: 4, lastReviewedSource: 'local', viewed: { 'a.ts': 'h' } });
        expect(computeReview({ versions, activity, comments: [], meUuid: null, local: null }).lastReviewed).toBeNull();
    });

    it('a reply does not count as a review', () => {
        const versions = versionsFixture();
        const comments = [myComment('merci', { parent: { id: 9 } })];
        expect(computeReview({ versions, activity, comments, meUuid: ME, local: null }).lastReviewed).toBe(2);
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
    it('threads (nested replies included), new, resolved, deleted', () => {
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
        ];
        const threads = buildThreads(raw, versionsFixture(), { meUuid: ME, sinceDate: '2026-11-05T11:00:00Z' });
        expect(threads.map((t) => t.id)).toEqual([14, 10]);
        const [general, inline] = threads;
        expect(general).toMatchObject({ path: null, version: 1 });
        expect(inline).toMatchObject({ path: 'src/CreateRecord.ts', anchor: { to: 40, from: null }, version: 3, resolved: true });
        // A "thumbs up" reply is a reply like any other (the Bitbucket API exposes no reactions).
        expect(inline!.comments.map((c) => [c.id, c.isNew, c.mine])).toEqual([[10, true, false], [11, true, false], [12, false, true], [13, true, false]]);
    });
});
