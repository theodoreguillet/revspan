// In-memory fake Bitbucket Cloud (API 2.0) for integration tests, the UI and development.
// Repository acme/demo-repo, several PRs covering the page's cases (see FAKE_PRS). Writes are
// recorded (GET /__calls), so are all requests (GET /__requests). GET /__delay?route=diffstat&ms=1500 slows down every
// request whose path has that segment (ms=0 removes it). POST /__comment {"raw", "pr"?, "parent"?, "inline"?: {path, to}}
// adds a comment by Yann Bernard (somebody else commenting meanwhile). Manual launch: node test/support/fake-bitbucket.ts [port]
import { createHash } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { BbActivity, BbComment, BbParticipant, BbPullRequest, BbStatus, BbTask, BbUser } from '../../src/server/bitbucket/types.ts';
import { FakeRepo, scenario } from './fake-repo.ts';

export const FAKE_EMAIL = 'me@example.test';
export const FAKE_TOKEN = 'fake-token-123';
export const WS = 'acme';
export const REPO = 'demo-repo';

/** PRs served by the fake Bitbucket (me = Thomas Girard, uuid {me}). */
export const FAKE_PRS = {
    /** 6 versions, rebases at v3 and v5; my comment on v2 and my approval of v2 (withdrawn since: only the event remains); Yann approved; several threads. */
    main: 42,
    /** 34 versions from June to October, 5 rebases, each modifies src/Long.ts; I approved v30. */
    long: 43,
    /** v1 with code, my approval (removed by Bitbucket on the next push), then v2 = pure rebase. */
    rebaseOnly: 44,
    /** My PR (2 versions), approved by Yann. */
    mine: 45,
    /** I am a reviewer but did nothing (2 versions). */
    neverReviewed: 46,
    /**
     * Does not concern me (author Yann, 1 version), already approved by Camille and the bot: minimum reached. Behind
     * master, with a merge conflict on src/others.ts.
     */
    others: 47,
    /** v1 erased by Bitbucket (commit not found), v2 and v3 readable; my comment dates from v1. */
    purged: 48,
    /** I approved its only version (author Yann, not a designated reviewer): "waiting" on the author. */
    waiting: 49,
    /** Draft (author Yann, 1 version, nobody concerned): shows "Draft" in the header; asks no review. */
    draft: 51,
} as const;

/**
 * Large PR served only with `startFakeBitbucket({ bigPr: true })` (performance run): 45 files, among which
 * src/big/Fixtures.ts (new, 5 000 lines: one hunk) and src/big/Generated.ts (2 750 changed lines in 125 hunks).
 * Kept out of FAKE_PRS: the other tests do not see it.
 */
export const FAKE_BIG_PR = 50;

/** PR of the main scenario (backward compatibility of the tests). */
export const PR_ID = FAKE_PRS.main;

const ME: BbUser = { uuid: '{me}', display_name: 'Thomas Girard', nickname: 'tgirard' };
const CAM: BbUser = { uuid: '{cam}', display_name: 'Camille Durand', nickname: 'cdurand' };
const YAN: BbUser = { uuid: '{yan}', display_name: 'Yann Bernard', nickname: 'ybernard' };
const AI: BbUser = { uuid: '{ai}', display_name: 'review-bot', nickname: 'ai' };

export interface RecordedCall {
    method: string;
    path: string;
    body: unknown;
}

type FakePullRequest = BbPullRequest & { participants: BbParticipant[] };

export interface FakePr {
    pr: FakePullRequest;
    activity: BbActivity[];
    comments: BbComment[];
    /** Tasks of the PR (`task_count` = the unresolved ones). */
    tasks: BbTask[];
}

export interface FakeData {
    repo: FakeRepo;
    /** "version..master" -> real base. */
    mergeBases: Map<string, string>;
    prs: Map<number, FakePr>;
    /** PR id -> build statuses of its commits (served per commit on /commit/{hash}/statuses, like Bitbucket). */
    statuses: Map<number, BbStatus[]>;
    /** HTTP status the statuses route answers instead of the list (simulates an unreadable CI integration). */
    statusesFailure?: number;
    /** When set, the PR list is answered only once it resolves (built before: a read that lags behind a write). */
    holdList?: Promise<void>;
    /** Branch name -> full head hash. master moved past the base of every PR but #44 (see buildFakeData). */
    branchHeads: Map<string, string>;
    /** PR id -> paths in conflict with its destination (GET .../pullrequests/{id}/conflicts; none when absent). */
    conflicts: Map<number, string[]>;
    /** HTTP status the conflicts route answers instead of the list. */
    conflictsFailure?: number;
    nextId(): number;
    /** Task ids: their own sequence (as on Bitbucket), so comment ids stay what they were. */
    nextTaskId(): number;
}

/** A request the fake Bitbucket answered (reads included), to count what a computation costs. */
export interface RecordedRequest {
    method: string;
    path: string;
    /** Page number of a paginated read (1 when absent). */
    page: number;
}

export interface FakeBitbucket {
    url: string;
    port: number;
    data: FakeData;
    /** Writes only. */
    calls: RecordedCall[];
    /** Every authenticated API request, reads included. */
    requests: RecordedRequest[];
    close(): Promise<void>;
}

/** Version of a PR: commit (name), master base (name) and push date. */
interface PlanStep {
    commit: string;
    base: string;
    date: string;
}

const openTasks = (tasks: readonly BbTask[]): number => tasks.filter((t) => t.state !== 'RESOLVED').length;
const hex = (name: string): string => createHash('sha1').update(name).digest('hex');
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const lines = (list: readonly string[]): string => `${list.join('\n')}\n`;
const DAY_MS = 86_400_000;
const addDays = (iso: string, days: number): string => new Date(Date.parse(iso) + days * DAY_MS).toISOString().replace('.000', '');

class FakeBuilder {
    readonly repo = new FakeRepo();
    readonly mergeBases = new Map<string, string>();
    readonly prs = new Map<number, FakePr>();
    private id = 1000;
    private taskId = 1;

    nextId = (): number => this.id++;
    nextTaskId = (): number => this.taskId++;

    commit(name: string, files: Record<string, string>, parent: string | null = null, message = 'DEMO-1 - feat(x): do it'): void {
        this.repo.commit(hex(name), files, parent ? hex(parent) : null, message);
    }

    derive(name: string, from: string, changes: Record<string, string | null>, message?: string): void {
        const files = { ...this.repo.get(hex(from)).files };
        for (const [path, content] of Object.entries(changes)) {
            if (content === null) {
                delete files[path];
            } else {
                files[path] = content;
            }
        }
        this.commit(name, files, from, message ?? this.repo.get(hex(from)).message);
    }

    comment(user: BbUser, date: string, raw: string, extra: Partial<BbComment> = {}): BbComment {
        return { id: this.nextId(), created_on: date, updated_on: date, user, content: { raw, html: `<p>${escapeHtml(raw)}</p>` }, deleted: false, ...extra };
    }

    task(creator: BbUser, date: string, raw: string, extra: Partial<BbTask> = {}): BbTask {
        return { id: this.nextTaskId(), state: 'UNRESOLVED', creator, created_on: date, updated_on: date, content: { raw, html: `<p>${escapeHtml(raw)}</p>` }, ...extra };
    }

    pr(id: number, { title, author, participants, plan, events = [], comments = [], tasks = [], description, descriptionHtml, draft }: {
        title: string;
        author: BbUser;
        participants: BbParticipant[];
        plan: PlanStep[];
        events?: BbActivity[];
        comments?: BbComment[];
        tasks?: BbTask[];
        /** Raw description and the HTML Bitbucket renders from it (default: a one-word description, no summary). */
        description?: string;
        descriptionHtml?: string;
        /** Draft PR (Bitbucket's `draft` flag). */
        draft?: boolean;
    }): void {
        const first = plan[0];
        const last = plan[plan.length - 1];
        if (!first || !last) {
            throw new Error(`PR ${id} sans version`);
        }
        for (const step of plan) {
            this.mergeBases.set(`${hex(step.commit)}..${hex(step.base)}`, hex(step.base));
        }
        this.prs.set(id, {
            pr: {
                id,
                title,
                description: description ?? 'Démo',
                ...(descriptionHtml === undefined ? {} : { summary: { html: descriptionHtml } }),
                state: 'OPEN',
                ...(draft ? { draft: true } : {}),
                author,
                source: { branch: { name: `feature/DEMO-${id}-demo` }, commit: { hash: hex(last.commit).slice(0, 12) } },
                destination: { branch: { name: 'master' }, commit: { hash: hex(last.base).slice(0, 12) } },
                created_on: first.date,
                updated_on: last.date,
                comment_count: comments.length,
                task_count: openTasks(tasks),
                participants,
                // Like Bitbucket, the designated reviewers are the participants with the REVIEWER role.
                reviewers: participants.flatMap((p) => (p.role === 'REVIEWER' && p.user ? [p.user] : [])),
                links: { html: { href: `https://bitbucket.org/${WS}/${REPO}/pull-requests/${id}` } },
            },
            activity: [
                // Like Bitbucket, every approval of a participant has its event (here: on the last push, if not given).
                ...participants.flatMap((p): BbActivity[] => (p.approved && p.user && !events.some((e) => e.approval?.user?.uuid === p.user?.uuid)
                    ? [{ approval: { date: last.date, user: p.user } }]
                    : [])),
                ...plan.map((step): BbActivity => ({
                    update: { date: step.date, author, source: { commit: { hash: hex(step.commit).slice(0, 12) } }, destination: { commit: { hash: hex(step.base).slice(0, 12) } } },
                })),
                ...events,
                // Like Bitbucket, the activity also contains every comment.
                ...comments.map((comment): BbActivity => ({ comment })),
            ],
            comments,
            tasks,
        });
    }
}

/** #42: scenario of fake-repo.ts (amend, pure rebase, RC bump, rebase + code, message only). */
function mainPr(b: FakeBuilder): void {
    const { repo, versions } = scenario();
    const named = (name: string): string => `main:${name}`;
    for (const [name, commit] of repo.commits) {
        b.commit(named(name), commit.files, commit.parent ? named(commit.parent) : null, commit.message);
    }
    const general = b.comment(AI, '2026-10-01T10:05:00Z', '## Test impact');
    general.content = {
        raw: '## Test impact',
        html: '<h2>Test impact</h2><table><tr><th>Test</th></tr><tr><td>ActionSpec</td></tr></table><img src=x onerror="alert(1)">',
    };
    // My comment on v2, line 7 (return this.save(id) -> modified in v5).
    const mine = b.comment(ME, '2026-10-02T12:00:00Z', 'Utilise le repository pour sauver.', { inline: { path: 'src/Action.ts', to: 7, from: null } });
    const reply = b.comment(CAM, '2026-10-20T10:30:00Z', 'Fait dans la dernière version.', { parent: { id: mine.id } });
    // One open task (Camille's, under my comment) and one resolved (mine, ticked by Camille).
    const tasks = [
        b.task(CAM, '2026-10-20T10:35:00Z', 'Ajouter un test pour archiveAll', { comment: { id: mine.id } }),
        b.task(ME, '2026-10-02T12:10:00Z', 'Mettre à jour le changelog', { state: 'RESOLVED', resolved_by: CAM, resolved_on: '2026-10-20T10:40:00Z', updated_on: '2026-10-20T10:40:00Z' }),
    ];
    b.pr(FAKE_PRS.main, {
        title: 'DEMO-1 - feat(records): archive records in bulk',
        author: CAM,
        participants: [
            { user: YAN, role: 'PARTICIPANT', approved: true, state: 'approved' },
            { user: CAM, role: 'PARTICIPANT', approved: false, state: null },
            { user: ME, role: 'REVIEWER', approved: false, state: null },
        ],
        plan: versions.map((v) => ({ commit: named(v.hash), base: named(v.base), date: v.pushedAt })),
        // My review of v2 is an explicit approval event (withdrawn since): a comment alone does not set the review, and
        // neither would a request for changes.
        events: [
            { approval: { date: '2026-10-02T12:30:00Z', user: ME } },
            { approval: { date: '2026-10-21T12:00:00Z', user: YAN } },
        ],
        comments: [
            general,
            mine,
            reply,
            // A like: the Bitbucket API has no reactions, Revspan shows a reply made of a single emoji as one.
            b.comment(YAN, '2026-10-20T11:00:00Z', '👍', { parent: { id: reply.id } }),
            b.comment(YAN, '2026-10-20T11:05:00Z', 'Pourquoi une RC ici ?', { inline: { path: 'package-lock.json', to: 5, from: null } }),
            b.comment(AI, '2026-10-01T10:06:00Z', 'critical: missing check', { inline: { path: 'src/Action.ts', to: 4, from: null }, resolution: { user: CAM } }),
        ],
        tasks,
        description: 'Archives records in bulk.\n\n- keeps the history\n- see the [guide](https://example.com/guide)',
        descriptionHtml: '<p>Archives records in bulk.</p><ul><li>keeps the history</li></ul>'
            + '<p>See the <a href="https://example.com/guide">guide</a>.</p><script>window.__descriptionPwned = 1</script>',
    });
}

/** #43: 34 versions from June to October; rebase onto a new master every 7 versions; I approved v30. */
function longPr(b: FakeBuilder): void {
    const longFile = (version: number): string => lines(Array.from({ length: 40 }, (_, i) => (i < version ? `    line ${i + 1} // v${i + 1}` : `    line ${i + 1}`)));
    b.commit('long:m0', { 'src/Long.ts': longFile(0), 'src/Master.ts': lines(['export const master = 0;']) });
    const plan: PlanStep[] = [];
    let master = 'long:m0';
    let previous: string | null = null;
    for (let version = 1; version <= 34; version++) {
        const date = addDays('2026-06-01T09:00:00Z', (version - 1) * 4);
        const rebase = version % 7 === 0;
        if (rebase) {
            const next = `long:m${version}`;
            b.derive(next, master, { 'src/Master.ts': lines([`export const master = ${version};`]) });
            master = next;
        }
        const name = `long:v${version}`;
        b.derive(name, rebase || !previous ? master : previous, { 'src/Long.ts': longFile(version) }, 'DEMO-43 - feat(long): a very long running pull request');
        plan.push({ commit: name, base: master, date });
        previous = name;
    }
    const approvedAt = addDays(plan[29]?.date ?? '2026-10-01T09:00:00Z', 0.05);
    b.pr(FAKE_PRS.long, {
        title: 'DEMO-43 - feat(long): a very long running pull request',
        author: CAM,
        participants: [
            { user: ME, role: 'REVIEWER', approved: true, state: 'approved' },
            { user: CAM, role: 'PARTICIPANT', approved: false, state: null },
        ],
        plan,
        events: [{ approval: { date: approvedAt, user: ME } }],
    });
}

/** #44: v1 (code), my approval, then v2 = pure rebase onto a master that moved on. */
function rebaseOnlyPr(b: FakeBuilder): void {
    b.commit('rebase:m0', { 'src/R.ts': lines(['a', 'b']), 'src/Other.ts': lines(['1']) });
    b.derive('rebase:v1', 'rebase:m0', { 'src/R.ts': lines(['a', 'B']) }, 'DEMO-44 - fix(r): rebase only since review');
    b.derive('rebase:m1', 'rebase:m0', { 'src/Other.ts': lines(['2']) });
    b.derive('rebase:v2', 'rebase:m1', { 'src/R.ts': lines(['a', 'B']) }, 'DEMO-44 - fix(r): rebase only since review');
    b.pr(FAKE_PRS.rebaseOnly, {
        title: 'DEMO-44 - fix(r): rebase only since review',
        author: CAM,
        // My approval of v1 was removed by Bitbucket on the push of v2 (repository setting): quick re-approval.
        participants: [
            { user: ME, role: 'REVIEWER', approved: false, state: null },
            { user: CAM, role: 'PARTICIPANT', approved: false, state: null },
        ],
        plan: [
            { commit: 'rebase:v1', base: 'rebase:m0', date: '2026-10-01T09:00:00Z' },
            { commit: 'rebase:v2', base: 'rebase:m1', date: '2026-10-05T09:00:00Z' },
        ],
        events: [{ approval: { date: '2026-10-02T09:00:00Z', user: ME } }],
    });
}

/**
 * #48: old PR whose v1 commit Bitbucket erased (overwritten by a force-push); v2 and v3 readable.
 * My approval (withdrawn since: only the event remains) dates from v1: my last review falls on an unavailable version.
 */
function purgedPr(b: FakeBuilder): void {
    const title = 'DEMO-48 - feat(purged): long running pull request';
    b.commit('purged:m0', { 'src/Purged.ts': lines(['a', 'b']) });
    b.derive('purged:v1', 'purged:m0', { 'src/Purged.ts': lines(['a', 'b', 'v1']) }, title);
    b.derive('purged:v2', 'purged:m0', { 'src/Purged.ts': lines(['a', 'b', 'v2']) }, title);
    b.derive('purged:v3', 'purged:v2', { 'src/Purged.ts': lines(['a', 'b', 'v2', 'v3']) }, title);
    b.pr(FAKE_PRS.purged, {
        title,
        author: CAM,
        participants: [
            { user: ME, role: 'REVIEWER', approved: false, state: null },
            { user: CAM, role: 'PARTICIPANT', approved: false, state: null },
        ],
        plan: [
            { commit: 'purged:v1', base: 'purged:m0', date: '2026-08-30T10:00:00Z' },
            { commit: 'purged:v2', base: 'purged:m0', date: '2026-10-14T09:00:00Z' },
            { commit: 'purged:v3', base: 'purged:m0', date: '2026-10-19T15:00:00Z' },
        ],
        events: [{ approval: { date: '2026-09-01T09:30:00Z', user: ME } }],
        comments: [b.comment(ME, '2026-09-01T09:00:00Z', 'Pourquoi cette ligne ?', { inline: { path: 'src/Purged.ts', to: 3, from: null } })],
    });
    b.repo.commits.delete(hex('purged:v1'));
}

/** Simple PR with 1 or 2 code versions (mine, never reviewed, others, waiting). */
function simplePr(b: FakeBuilder, id: number, key: string, title: string, author: BbUser, participants: BbParticipant[], versions: number, events: BbActivity[] = [], draft = false): void {
    b.commit(`${key}:m0`, { [`src/${key}.ts`]: lines(['x']) });
    const plan: PlanStep[] = [];
    for (let v = 1; v <= versions; v++) {
        b.derive(`${key}:v${v}`, v === 1 ? `${key}:m0` : `${key}:v${v - 1}`, { [`src/${key}.ts`]: lines(['x', ...Array.from({ length: v }, (_, i) => `y${i + 1}`)]) }, title);
        plan.push({ commit: `${key}:v${v}`, base: `${key}:m0`, date: addDays('2026-10-10T09:00:00Z', v) });
    }
    b.pr(id, { title, author, participants, plan, events, draft });
}

/** Line `i` of a generated TypeScript file (`salt` changes the values: modified lines). */
function codeLine(i: number, salt = ''): string {
    switch (i % 8) {
        case 0: return `export function handler${i}${salt}(input: Record<string, number>): number {`;
        case 1: return `    const value = input['key${i}${salt}'] ?? ${i};`;
        case 2: return `    // compute the weight of item ${i}${salt ? ` (${salt})` : ''}`;
        case 3: return `    const weight = Math.max(value * ${i % 7}, ${i % 13}) + compute(${i}, 'label ${i}${salt}');`;
        case 4: return `    if (weight > ${i * 3}${salt ? ' + 1' : ''}) {`;
        case 5: return `        return weight - ${i % 5}${salt ? ' + 1' : ''};`;
        case 6: return `    }${salt ? ' // checked' : ''}`;
        default: return `    return value + weight${salt ? ' * 2' : ''}; }`;
    }
}

/**
 * #50 (perf run only): many files, a new one of 5 000 lines and one with 11 lines replaced every 40 lines (the server's
 * diff gives up beyond 3 000 changed lines and shows a single hunk: that case is the new file).
 */
function bigPr(b: FakeBuilder): void {
    const title = 'DEMO-50 - refactor(big): regenerate the handlers';
    const ts = (count: number, changed: (i: number) => boolean): string => lines(Array.from({ length: count }, (_, i) => codeLine(i, changed(i) ? 'v2' : '')));
    const vue = (n: number, salt: string): string => lines([
        '<script setup lang="ts">',
        "import { computed, ref } from 'vue';",
        ...Array.from({ length: 50 }, (_, i) => `const item${i} = ref<number>(${(i * n) % 17}${i % 9 === 0 ? salt : ''});`),
        '</script>',
        '',
        '<template>',
        ...Array.from({ length: 60 }, (_, i) => `    <div class="row r${i}" :title="'item ${i}${i % 11 === 0 ? salt : ''}'">{{ item${i % 50} }}</div>`),
        '</template>',
    ]);
    const md = (n: number, salt: string): string => lines(Array.from({ length: 80 }, (_, i) => (i % 10 === 0 ? `## Section ${i / 10} of note ${n}` : `Paragraph ${i} explains the *handler* \`h${i}\`${i % 13 === 0 ? salt : ''}.`)));
    const json = (n: number, salt: string): string => lines(['{', ...Array.from({ length: 60 }, (_, i) => `    "setting${n}_${i}": ${i % 4 === 0 ? `"value ${i}${salt}"` : i},`), '    "end": true', '}']);
    const base: Record<string, string> = {
        'src/big/Generated.ts': ts(5000, () => false),
    };
    const head: Record<string, string> = {
        'src/big/Generated.ts': ts(5000, (i) => i % 40 >= 10 && i % 40 < 21),
        'src/big/Fixtures.ts': ts(5000, () => false),
    };
    for (let n = 0; n < 30; n++) {
        const path = `src/modules/m${String(n).padStart(2, '0')}/Service.ts`;
        base[path] = ts(160, () => false);
        head[path] = ts(160, (i) => i % 40 >= 12 && i % 40 < 16);
    }
    for (let n = 0; n < 6; n++) {
        base[`src/components/Panel${n}.vue`] = vue(n, '');
        head[`src/components/Panel${n}.vue`] = vue(n, ' + 1');
    }
    for (let n = 0; n < 4; n++) {
        base[`docs/note${n}.md`] = md(n, '');
        head[`docs/note${n}.md`] = md(n, ' (updated)');
    }
    for (let n = 0; n < 3; n++) {
        base[`config/settings${n}.json`] = json(n, '');
        head[`config/settings${n}.json`] = json(n, ' v2');
    }
    b.commit('big:m0', base);
    b.derive('big:v1', 'big:m0', head, title);
    b.pr(FAKE_BIG_PR, {
        title,
        author: CAM,
        participants: [
            { user: ME, role: 'REVIEWER', approved: false, state: null },
            { user: CAM, role: 'PARTICIPANT', approved: false, state: null },
        ],
        plan: [{ commit: 'big:v1', base: 'big:m0', date: '2026-10-22T09:00:00Z' }],
    });
}

/** New push on a PR: commit `commit` (content of `from` modified by `changes`, same message) on base `base`. */
export function pushVersion(data: FakeData, id: number, { commit, from, base, changes, date }: {
    commit: string;
    from: string;
    base: string;
    changes: Record<string, string | null>;
    date: string;
}): void {
    const fake = data.prs.get(id);
    if (!fake) {
        throw new Error(`PR ${id} inconnue`);
    }
    const hash = hex(commit);
    data.repo.derive(hash, hex(from), changes, data.repo.get(hex(from)).message);
    data.mergeBases.set(`${hash}..${hex(base)}`, hex(base));
    const source = { commit: { hash: hash.slice(0, 12) } };
    const destination = { commit: { hash: hex(base).slice(0, 12) } };
    fake.pr.source = { ...fake.pr.source, ...source };
    fake.pr.destination = { ...fake.pr.destination, ...destination };
    fake.pr.updated_on = date;
    fake.activity.push({ update: { date, author: fake.pr.author, source, destination } });
}

export function buildFakeData({ bigPr: withBigPr = false } = {}): FakeData {
    const b = new FakeBuilder();
    mainPr(b);
    longPr(b);
    rebaseOnlyPr(b);
    simplePr(b, FAKE_PRS.mine, 'mine', 'DEMO-45 - feat(mine): my own pull request', ME,
        [{ user: YAN, role: 'PARTICIPANT', approved: true, state: 'approved' }, { user: ME, role: 'PARTICIPANT', approved: false, state: null }], 2);
    simplePr(b, FAKE_PRS.neverReviewed, 'never', 'DEMO-46 - feat(never): not reviewed yet', YAN,
        [{ user: ME, role: 'REVIEWER', approved: false, state: null }, { user: YAN, role: 'PARTICIPANT', approved: false, state: null }], 2);
    simplePr(b, FAKE_PRS.others, 'others', 'DEMO-47 - chore(others): not about me', YAN,
        [{ user: CAM, role: 'REVIEWER', approved: true, state: 'approved' }, { user: AI, role: 'PARTICIPANT', approved: true, state: 'approved' }], 1);
    purgedPr(b);
    simplePr(b, FAKE_PRS.waiting, 'waiting', 'DEMO-49 - fix(waiting): approved, waiting on the author', YAN,
        [{ user: ME, role: 'PARTICIPANT', approved: true, state: 'approved' }, { user: YAN, role: 'PARTICIPANT', approved: false, state: null }], 1,
        [{ approval: { date: '2026-10-12T09:00:00Z', user: ME } }]);
    simplePr(b, FAKE_PRS.draft, 'draft', 'DEMO-51 - feat(draft): work in progress', YAN, [{ user: CAM, role: 'PARTICIPANT', approved: false, state: null }], 1, [], true);
    if (withBigPr) {
        bigPr(b);
    }
    const headOf = (id: number): string => {
        const prefix = b.prs.get(id)?.pr.source?.commit?.hash ?? '';
        return [...b.repo.commits.keys()].find((k) => k.startsWith(prefix)) ?? prefix;
    };
    const status = (id: number, over: Pick<BbStatus, 'key' | 'state'> & Partial<BbStatus>): BbStatus => ({
        url: `https://ci.example.test/${over.key}/${id}`,
        updated_on: '2026-10-21T09:00:00Z',
        commit: { hash: headOf(id) },
        ...over,
    });
    const statuses = new Map<number, BbStatus[]>([
        // Failed: a failure and a success on the head, plus a stale success on an older commit.
        [FAKE_PRS.main, [
            status(FAKE_PRS.main, { key: 'pipeline', name: 'Pipeline #12', state: 'FAILED' }),
            status(FAKE_PRS.main, { key: 'scan', name: 'Security scan', state: 'SUCCESSFUL' }),
            status(FAKE_PRS.main, { key: 'pipeline', name: 'Pipeline #11', state: 'SUCCESSFUL', updated_on: '2026-10-20T09:00:00Z', commit: { hash: hex('main:old-head') } }),
        ]],
        // Running: one in-progress check among successful ones.
        [FAKE_PRS.mine, [
            status(FAKE_PRS.mine, { key: 'pipeline', name: 'Pipeline #13', state: 'SUCCESSFUL' }),
            status(FAKE_PRS.mine, { key: 'integration', name: 'Integration tests', state: 'INPROGRESS' }),
        ]],
        // PR #46 and the others have no status at all.
    ]);
    // master moved past every base (m0 of #45, #46, #47...) except that of #44, whose v2 sits on master.
    const branchHeads = new Map<string, string>([['master', hex('rebase:m1')]]);
    // Merge base of each PR head and master's current head: still its own base, which is master's head only for #44.
    for (const id of b.prs.keys()) {
        const head = headOf(id);
        const own = [...b.mergeBases.keys()].find((k) => k.startsWith(`${head}..`));
        const base = own ? b.mergeBases.get(own) : undefined;
        if (own && base && head) {
            b.mergeBases.set(`${head}..${hex('rebase:m1')}`, base);
        }
    }
    // #47 is behind master and cannot be merged without resolving its only file.
    const conflicts = new Map<number, string[]>([[FAKE_PRS.others, ['src/others.ts']]]);
    return { repo: b.repo, mergeBases: b.mergeBases, prs: b.prs, statuses, branchHeads, conflicts, nextId: b.nextId, nextTaskId: b.nextTaskId };
}

function send(res: ServerResponse, status: number, value: unknown, type = 'application/json'): void {
    res.writeHead(status, { 'Content-Type': type });
    res.end(type === 'application/json' ? JSON.stringify(value) : String(value ?? ''));
}

function page<T>(req: IncomingMessage, values: readonly T[], size: number): { values: T[]; next?: string } {
    const url = new URL(req.url ?? '/', 'http://x');
    const pagelen = Math.min(Number(url.searchParams.get('pagelen') ?? size) || size, size);
    const pageNo = Number(url.searchParams.get('page') ?? 1);
    const out: { values: T[]; next?: string } = { values: values.slice((pageNo - 1) * pagelen, pageNo * pagelen) };
    if (pageNo * pagelen < values.length) {
        url.searchParams.set('page', String(pageNo + 1));
        out.next = `http://${req.headers.host}${url.pathname}?${url.searchParams}`;
    }
    return out;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : null;
}

/** bigPr: also serves FAKE_BIG_PR (performance run only; the other tests keep the 8 PRs). */
export function startFakeBitbucket({ port = 0, bigPr = false } = {}): Promise<FakeBitbucket> {
    const data = buildFakeData({ bigPr });
    const calls: RecordedCall[] = [];
    const requests: RecordedRequest[] = [];
    const src = data.repo.source();
    const auth = `Basic ${Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString('base64')}`;
    const fullHash = (prefix: string): string | undefined => [...data.repo.commits.keys()].find((k) => k.startsWith(prefix));
    let failNext: number | null = null;
    /** Answer delay by path segment ("diffstat", "src"...): slow Bitbucket for the loading indicators. */
    const delays = new Map<string, number>();

    const server = http.createServer((req, res) => {
        void handle(req, res).catch((error: Error) => send(res, 500, { error: { message: error.message } }));
    });

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://x');
        const path = decodeURIComponent(url.pathname);
        if (path === '/__calls') {
            return send(res, 200, calls);
        }
        if (path === '/__requests') {
            return send(res, 200, requests);
        }
        if (path === '/__fail-next') {
            failNext = Number(url.searchParams.get('status'));
            return send(res, 200, { ok: true });
        }
        if (path === '/__delay') {
            const route = url.searchParams.get('route') ?? '';
            const ms = Number(url.searchParams.get('ms') ?? 0);
            if (ms > 0) {
                delays.set(route, ms);
            } else {
                delays.delete(route);
            }
            return send(res, 200, { ok: true });
        }
        if (path === '/__comment' && req.method === 'POST') {
            const input = await readBody(req) ?? {};
            const fake = data.prs.get(Number(input.pr ?? FAKE_PRS.main));
            if (!fake) {
                return send(res, 404, { error: { message: 'no pr' } });
            }
            const now = new Date(Math.max(Date.now(), Date.parse(fake.pr.updated_on ?? '') + 1 || 0)).toISOString();
            const parent = typeof input.parent === 'number' ? input.parent : undefined;
            const inline = input.inline as { path: string; to: number } | undefined;
            const created: BbComment = {
                id: data.nextId(), created_on: now, updated_on: now, user: YAN, deleted: false,
                content: { raw: String(input.raw ?? ''), html: `<p>${escapeHtml(String(input.raw ?? ''))}</p>` },
                ...(parent ? { parent: { id: parent } } : {}),
                ...(inline ? { inline: { path: inline.path, to: inline.to, from: null } } : {}),
            };
            fake.comments.push(created);
            fake.activity.push({ comment: created });
            fake.pr.comment_count = fake.comments.filter((c) => !c.deleted).length;
            fake.pr.updated_on = now;
            return send(res, 201, created);
        }
        if (req.headers.authorization !== auth) {
            return send(res, 401, { type: 'error', error: { message: 'Unauthorized' } });
        }
        requests.push({ method: req.method ?? '', path, page: Number(url.searchParams.get('page') ?? 1) });
        if (failNext) {
            const status = failNext;
            failNext = null;
            return send(res, status, { type: 'error', error: { message: 'boom' } });
        }
        const delay = [...delays].find(([route]) => path.split('/').includes(route))?.[1];
        if (delay) {
            await new Promise((done) => setTimeout(done, delay));
        }
        const body = req.method === 'GET' ? null : await readBody(req);
        if (req.method !== 'GET') {
            calls.push({ method: req.method ?? '', path, body });
        }
        if (path === '/2.0/user') {
            return send(res, 200, ME);
        }
        const repoBase = `/2.0/repositories/${WS}/${REPO}`;
        if (!path.startsWith(repoBase)) {
            return send(res, 404, { error: { message: 'not found' } });
        }
        const rest = path.slice(repoBase.length);
        let m: RegExpExecArray | null;
        if (rest === '/pullrequests' && req.method === 'GET') {
            const list = JSON.parse(JSON.stringify(page(req, [...data.prs.values()].map((p) => p.pr), 50))) as unknown;
            await data.holdList;
            return send(res, 200, list);
        }
        if ((m = /^\/refs\/branches\/(.+)$/.exec(rest))) {
            const name = m[1] ?? '';
            const hash = data.branchHeads.get(name);
            return hash ? send(res, 200, { name, target: { hash } }) : send(res, 404, { error: { message: 'no branch' } });
        }
        if ((m = /^\/commit\/([0-9a-f]+)\/statuses$/.exec(rest)) && req.method === 'GET') {
            if (data.statusesFailure) {
                return send(res, data.statusesFailure, { error: { message: 'statuses unavailable' } });
            }
            const prefix = m[1] ?? '';
            const ofCommit = [...data.statuses.values()].flat().filter((s) => s.commit?.hash.startsWith(prefix));
            return send(res, 200, page(req, ofCommit, 50));
        }
        if ((m = /^\/commit\/([0-9a-f]+)$/.exec(rest))) {
            const hash = fullHash(m[1] ?? '');
            const commit = hash ? data.repo.get(hash) : undefined;
            return commit
                ? send(res, 200, { hash: commit.hash, message: commit.message, date: '2026-10-01T00:00:00Z', parents: commit.parent ? [{ hash: commit.parent }] : [] })
                : send(res, 404, { error: { message: 'no commit' } });
        }
        if ((m = /^\/merge-base\/([0-9a-f]+)\.\.([0-9a-f]+)$/.exec(rest))) {
            const [, a = '', b = ''] = m;
            const key = [...data.mergeBases.keys()].find((k) => {
                const [x = '', y = ''] = k.split('..');
                return x.startsWith(a) && y.startsWith(b);
            });
            const base = key ? data.mergeBases.get(key) : undefined;
            return base ? send(res, 200, { hash: base }) : send(res, 404, { error: { message: 'none' } });
        }
        if ((m = /^\/diffstat\/([0-9a-f]+)\.\.([0-9a-f]+)$/.exec(rest))) {
            const newHash = fullHash(m[1] ?? '');
            const oldHash = fullHash(m[2] ?? '');
            if (!newHash || !oldHash) {
                return send(res, 404, { error: { message: 'no commit' } });
            }
            const entries = await src.diffstat(newHash, oldHash);
            return send(res, 200, page(req, entries.map((e) => ({
                status: e.status,
                old: e.oldPath ? { path: e.oldPath } : null,
                new: e.newPath ? { path: e.newPath } : null,
                lines_added: e.added,
                lines_removed: e.removed,
            })), 500));
        }
        if ((m = /^\/src\/([0-9a-f]+)\/(.+)$/.exec(rest))) {
            const hash = fullHash(m[1] ?? '');
            const content = hash ? await src.content(hash, m[2] ?? '') : { missing: true as const };
            return 'text' in content ? send(res, 200, content.text, 'text/plain') : send(res, 404, { error: { message: 'no file' } });
        }
        if ((m = /^\/pullrequests\/(\d+)(\/.*)?$/.exec(rest))) {
            const fake = data.prs.get(Number(m[1]));
            return fake ? handlePr(req, res, fake, m[2] ?? '', body) : send(res, 404, { error: { message: 'no pr' } });
        }
        return send(res, 404, { error: { message: `no route ${req.method} ${rest}` } });
    }

    function handlePr(req: IncomingMessage, res: ServerResponse, fake: FakePr, sub: string, body: Record<string, unknown> | null): void {
        const now = new Date().toISOString();
        const findComment = (id: string): BbComment | undefined => fake.comments.find((c) => c.id === Number(id));
        // Like Bitbucket: you only become a participant by acting (approval, change request), not by reading.
        const participant = (): BbParticipant => {
            let me = fake.pr.participants.find((p) => p.user?.uuid === ME.uuid);
            if (!me) {
                me = { user: ME, role: 'PARTICIPANT', approved: false, state: null };
                fake.pr.participants.push(me);
            }
            return me;
        };
        // Every write moves the PR's updated_on forward (strictly: two writes in the same millisecond still differ).
        if (req.method !== 'GET') {
            fake.pr.updated_on = new Date(Math.max(Date.now(), Date.parse(fake.pr.updated_on ?? '') + 1 || 0)).toISOString();
        }
        let m: RegExpExecArray | null;
        if (sub === '' && req.method === 'GET') {
            return send(res, 200, fake.pr);
        }
        if (sub === '/conflicts' && req.method === 'GET') {
            // Bitbucket redirects to the repository's file-conflicts; answered here directly.
            if (data.conflictsFailure) {
                return send(res, data.conflictsFailure, { error: { message: 'conflicts unavailable' } });
            }
            const paths = data.conflicts.get(fake.pr.id) ?? [];
            return send(res, 200, page(req, paths.map((path) => ({ type: 'file_conflict', path, scenario: 'content', message: 'File modified in both source and destination' })), 100));
        }
        if (sub === '/activity') {
            return send(res, 200, page(req, [...fake.activity].reverse(), 3));
        }
        if (sub === '/comments' && req.method === 'GET') {
            return send(res, 200, page(req, fake.comments, 4));
        }
        if (sub === '/comments' && req.method === 'POST') {
            const raw = String((body?.content as { raw?: string } | undefined)?.raw ?? '');
            const parent = body?.parent as { id: number } | undefined;
            const inline = body?.inline as { path: string; to: number } | undefined;
            const created: BbComment = {
                id: data.nextId(), created_on: now, updated_on: now, user: ME, deleted: false,
                content: { raw, html: `<p>${escapeHtml(raw)}</p>` },
                ...(parent ? { parent: { id: parent.id } } : {}),
                ...(inline ? { inline: { path: inline.path, to: inline.to, from: null } } : {}),
            };
            fake.comments.push(created);
            fake.activity.push({ comment: created });
            fake.pr.comment_count = fake.comments.filter((c) => !c.deleted).length;
            return send(res, 201, created);
        }
        if ((m = /^\/comments\/(\d+)$/.exec(sub)) && req.method === 'PUT') {
            const target = findComment(m[1] ?? '');
            if (!target || target.deleted) {
                return send(res, 404, { error: { message: 'no comment' } });
            }
            const raw = String((body?.content as { raw?: string } | undefined)?.raw ?? '');
            target.content = { raw, html: `<p>${escapeHtml(raw)}</p>` };
            target.updated_on = fake.pr.updated_on ?? now;
            return send(res, 200, target);
        }
        if ((m = /^\/comments\/(\d+)$/.exec(sub)) && req.method === 'DELETE') {
            const target = findComment(m[1] ?? '');
            if (!target) {
                return send(res, 404, { error: { message: 'no comment' } });
            }
            // Like Bitbucket: the deleted comment stays listed with its text blanked, and comment_count leaves it out.
            target.deleted = true;
            target.content = { raw: '', html: '' };
            fake.pr.comment_count = fake.comments.filter((c) => !c.deleted).length;
            return send(res, 204, '', 'text/plain');
        }
        if ((m = /^\/comments\/(\d+)\/resolve$/.exec(sub))) {
            const target = findComment(m[1] ?? '');
            if (!target) {
                return send(res, 404, { error: { message: 'no comment' } });
            }
            target.resolution = req.method === 'POST' ? { user: ME } : null;
            return send(res, 200, target.resolution ?? {});
        }
        if (sub === '/tasks' && req.method === 'GET') {
            return send(res, 200, page(req, fake.tasks, 100));
        }
        if (sub === '/tasks' && req.method === 'POST') {
            const raw = String((body?.content as { raw?: string } | undefined)?.raw ?? '').trim();
            if (!raw) {
                return send(res, 400, { error: { message: 'The task content is blank.' } });
            }
            const comment = body?.comment as { id: number } | undefined;
            const created: BbTask = {
                id: data.nextTaskId(), state: 'UNRESOLVED', creator: ME, created_on: now, updated_on: now,
                content: { raw, html: `<p>${escapeHtml(raw)}</p>` }, ...(comment ? { comment: { id: comment.id } } : {}),
            };
            fake.tasks.push(created);
            fake.pr.task_count = openTasks(fake.tasks);
            return send(res, 201, created);
        }
        if ((m = /^\/tasks\/(\d+)$/.exec(sub)) && (req.method === 'PUT' || req.method === 'DELETE')) {
            const index = fake.tasks.findIndex((t) => t.id === Number(m?.[1]));
            const target = fake.tasks[index];
            if (!target) {
                return send(res, 404, { error: { message: 'no task' } });
            }
            if (req.method === 'DELETE') {
                fake.tasks.splice(index, 1);
                fake.pr.task_count = openTasks(fake.tasks);
                return send(res, 204, '', 'text/plain');
            }
            const raw = (body?.content as { raw?: string } | undefined)?.raw;
            if (raw !== undefined) {
                target.content = { raw, html: `<p>${escapeHtml(raw)}</p>` };
            }
            if (body?.state === 'RESOLVED' || body?.state === 'UNRESOLVED') {
                target.state = body.state;
                target.resolved_by = body.state === 'RESOLVED' ? ME : null;
                target.resolved_on = body.state === 'RESOLVED' ? now : null;
            }
            target.updated_on = now;
            fake.pr.task_count = openTasks(fake.tasks);
            return send(res, 200, target);
        }
        if (sub === '/approve') {
            const me = participant();
            me.approved = req.method === 'POST';
            me.state = me.approved ? 'approved' : null;
            if (me.approved) {
                fake.activity.push({ approval: { date: now, user: ME } });
            }
            return send(res, 200, me);
        }
        if (sub === '/request-changes') {
            const me = participant();
            me.state = req.method === 'POST' ? 'changes_requested' : null;
            if (me.state) {
                fake.activity.push({ changes_requested: { date: now, user: ME } });
            }
            return send(res, 200, me);
        }
        return send(res, 404, { error: { message: `no route ${req.method} ${sub}` } });
    }

    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            const address = server.address();
            const bound = typeof address === 'object' && address ? address.port : port;
            resolve({
                url: `http://127.0.0.1:${bound}/2.0`,
                port: bound,
                data,
                calls,
                requests,
                close: () => new Promise((done) => {
                    server.closeAllConnections();
                    server.close(() => done());
                }),
            });
        });
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const fake = await startFakeBitbucket({ port: Number(process.argv[2] ?? 0) });
    console.log(JSON.stringify({ url: fake.url, port: fake.port, email: FAKE_EMAIL, token: FAKE_TOKEN, workspace: WS, repo: REPO, prs: FAKE_PRS }));
}
