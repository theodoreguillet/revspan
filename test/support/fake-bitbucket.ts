// Faux Bitbucket Cloud (API 2.0) en mémoire pour les tests d'intégration, l'UI et le développement.
// Dépôt acme/demo-repo, plusieurs PR couvrant les cas de la page (voir FAKE_PRS). Les écritures sont
// enregistrées (GET /__calls). Lancement manuel : node test/support/fake-bitbucket.ts [port]
import { createHash } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { BbActivity, BbComment, BbParticipant, BbPullRequest, BbUser } from '../../src/server/bitbucket/types.ts';
import { FakeRepo, scenario } from './fake-repo.ts';

export const FAKE_EMAIL = 'me@example.test';
export const FAKE_TOKEN = 'fake-token-123';
export const WS = 'acme';
export const REPO = 'demo-repo';

/** PR servies par le faux Bitbucket (moi = Thomas Girard, uuid {me}). */
export const FAKE_PRS = {
    /** 6 versions, rebases en v3 et v5 ; mon commentaire sur v2 ; Yann a approuvé ; plusieurs fils. */
    main: 42,
    /** 34 versions de juin à octobre, 5 rebases, chacune modifie src/Long.ts ; j'ai approuvé v30. */
    long: 43,
    /** v1 avec du code, mon approbation, puis v2 = rebase pur. */
    rebaseOnly: 44,
    /** Ma PR (2 versions), approuvée par Yann. */
    mine: 45,
    /** Je suis relecteur mais n'ai rien fait (2 versions). */
    neverReviewed: 46,
    /** Ne me concerne pas (auteur Yann, 1 version). */
    others: 47,
    /** v1 effacée par Bitbucket (commit introuvable), v2 et v3 lisibles ; mon commentaire date de v1. */
    purged: 48,
} as const;

/** PR du scénario principal (rétrocompatibilité des tests). */
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
}

export interface FakeData {
    repo: FakeRepo;
    /** « version..master » → base réelle. */
    mergeBases: Map<string, string>;
    prs: Map<number, FakePr>;
    nextId(): number;
}

export interface FakeBitbucket {
    url: string;
    port: number;
    data: FakeData;
    calls: RecordedCall[];
    close(): Promise<void>;
}

/** Version d'une PR : commit (nom), base master (nom) et date du push. */
interface PlanStep {
    commit: string;
    base: string;
    date: string;
}

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

    nextId = (): number => this.id++;

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

    pr(id: number, { title, author, participants, plan, events = [], comments = [] }: {
        title: string;
        author: BbUser;
        participants: BbParticipant[];
        plan: PlanStep[];
        events?: BbActivity[];
        comments?: BbComment[];
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
                description: 'Démo',
                state: 'OPEN',
                author,
                source: { branch: { name: `feature/DEMO-${id}-demo` }, commit: { hash: hex(last.commit).slice(0, 12) } },
                destination: { branch: { name: 'master' }, commit: { hash: hex(last.base).slice(0, 12) } },
                created_on: first.date,
                updated_on: last.date,
                participants,
                links: { html: { href: `https://bitbucket.org/${WS}/${REPO}/pull-requests/${id}` } },
            },
            activity: [
                ...plan.map((step): BbActivity => ({
                    update: { date: step.date, author, source: { commit: { hash: hex(step.commit).slice(0, 12) } }, destination: { commit: { hash: hex(step.base).slice(0, 12) } } },
                })),
                ...events,
                // Comme Bitbucket, l'activité contient aussi chaque commentaire.
                ...comments.map((comment): BbActivity => ({ comment })),
            ],
            comments,
        });
    }
}

/** #42 : scénario de fake-repo.ts (amend, rebase pur, montée de RC, rebase + code, message seul). */
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
    // Mon commentaire sur v2, ligne 7 (return this.save(id) → modifiée en v5).
    const mine = b.comment(ME, '2026-10-02T12:00:00Z', 'Utilise le repository pour sauver.', { inline: { path: 'src/Action.ts', to: 7, from: null } });
    const reply = b.comment(CAM, '2026-10-20T10:30:00Z', 'Fait dans la dernière version.', { parent: { id: mine.id } });
    b.pr(FAKE_PRS.main, {
        title: 'DEMO-1 - feat(records): archive records in bulk',
        author: CAM,
        participants: [
            { user: YAN, role: 'PARTICIPANT', approved: true, state: 'approved' },
            { user: CAM, role: 'PARTICIPANT', approved: false, state: null },
            { user: ME, role: 'REVIEWER', approved: false, state: null },
        ],
        plan: versions.map((v) => ({ commit: named(v.hash), base: named(v.base), date: v.pushedAt })),
        events: [{ approval: { date: '2026-10-21T12:00:00Z', user: YAN } }],
        comments: [
            general,
            mine,
            reply,
            b.comment(YAN, '2026-10-20T11:00:00Z', '👍', { parent: { id: reply.id } }),
            b.comment(YAN, '2026-10-20T11:05:00Z', 'Pourquoi une RC ici ?', { inline: { path: 'package-lock.json', to: 5, from: null } }),
            b.comment(AI, '2026-10-01T10:06:00Z', 'critical: missing check', { inline: { path: 'src/Action.ts', to: 4, from: null }, resolution: { user: CAM } }),
        ],
    });
}

/** #43 : 34 versions de juin à octobre ; rebase sur un nouveau master toutes les 7 versions ; j'ai approuvé v30. */
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

/** #44 : v1 (code), mon approbation, puis v2 = rebase pur sur un master qui a avancé. */
function rebaseOnlyPr(b: FakeBuilder): void {
    b.commit('rebase:m0', { 'src/R.ts': lines(['a', 'b']), 'src/Other.ts': lines(['1']) });
    b.derive('rebase:v1', 'rebase:m0', { 'src/R.ts': lines(['a', 'B']) }, 'DEMO-44 - fix(r): rebase only since review');
    b.derive('rebase:m1', 'rebase:m0', { 'src/Other.ts': lines(['2']) });
    b.derive('rebase:v2', 'rebase:m1', { 'src/R.ts': lines(['a', 'B']) }, 'DEMO-44 - fix(r): rebase only since review');
    b.pr(FAKE_PRS.rebaseOnly, {
        title: 'DEMO-44 - fix(r): rebase only since review',
        author: CAM,
        participants: [
            { user: ME, role: 'REVIEWER', approved: true, state: 'approved' },
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
 * #48 : PR ancienne dont Bitbucket a effacé le commit de v1 (écrasé par un force-push) ; v2 et v3 lisibles.
 * Mon commentaire en ligne date de v1 : ma dernière relecture tombe sur une version indisponible.
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
        comments: [b.comment(ME, '2026-09-01T09:00:00Z', 'Pourquoi cette ligne ?', { inline: { path: 'src/Purged.ts', to: 3, from: null } })],
    });
    b.repo.commits.delete(hex('purged:v1'));
}

/** PR simple à 1 ou 2 versions de code (mine, jamais relue, autres). */
function simplePr(b: FakeBuilder, id: number, key: string, title: string, author: BbUser, participants: BbParticipant[], versions: number): void {
    b.commit(`${key}:m0`, { [`src/${key}.ts`]: lines(['x']) });
    const plan: PlanStep[] = [];
    for (let v = 1; v <= versions; v++) {
        b.derive(`${key}:v${v}`, v === 1 ? `${key}:m0` : `${key}:v${v - 1}`, { [`src/${key}.ts`]: lines(['x', ...Array.from({ length: v }, (_, i) => `y${i + 1}`)]) }, title);
        plan.push({ commit: `${key}:v${v}`, base: `${key}:m0`, date: addDays('2026-10-10T09:00:00Z', v) });
    }
    b.pr(id, { title, author, participants, plan });
}

export function buildFakeData(): FakeData {
    const b = new FakeBuilder();
    mainPr(b);
    longPr(b);
    rebaseOnlyPr(b);
    simplePr(b, FAKE_PRS.mine, 'mine', 'DEMO-45 - feat(mine): my own pull request', ME,
        [{ user: YAN, role: 'PARTICIPANT', approved: true, state: 'approved' }, { user: ME, role: 'PARTICIPANT', approved: false, state: null }], 2);
    simplePr(b, FAKE_PRS.neverReviewed, 'never', 'DEMO-46 - feat(never): not reviewed yet', YAN,
        [{ user: ME, role: 'REVIEWER', approved: false, state: null }, { user: YAN, role: 'PARTICIPANT', approved: false, state: null }], 2);
    simplePr(b, FAKE_PRS.others, 'others', 'DEMO-47 - chore(others): not about me', YAN,
        [{ user: CAM, role: 'REVIEWER', approved: false, state: null }], 1);
    purgedPr(b);
    return { repo: b.repo, mergeBases: b.mergeBases, prs: b.prs, nextId: b.nextId };
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

export function startFakeBitbucket({ port = 0 } = {}): Promise<FakeBitbucket> {
    const data = buildFakeData();
    const calls: RecordedCall[] = [];
    const src = data.repo.source();
    const auth = `Basic ${Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString('base64')}`;
    const fullHash = (prefix: string): string | undefined => [...data.repo.commits.keys()].find((k) => k.startsWith(prefix));
    let failNext: number | null = null;

    const server = http.createServer((req, res) => {
        void handle(req, res).catch((error: Error) => send(res, 500, { error: { message: error.message } }));
    });

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://x');
        const path = decodeURIComponent(url.pathname);
        if (path === '/__calls') {
            return send(res, 200, calls);
        }
        if (path === '/__fail-next') {
            failNext = Number(url.searchParams.get('status'));
            return send(res, 200, { ok: true });
        }
        if (req.headers.authorization !== auth) {
            return send(res, 401, { type: 'error', error: { message: 'Unauthorized' } });
        }
        if (failNext) {
            const status = failNext;
            failNext = null;
            return send(res, status, { type: 'error', error: { message: 'boom' } });
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
            return send(res, 200, page(req, [...data.prs.values()].map((p) => p.pr), 50));
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
        // Comme Bitbucket : on ne devient participant qu'en agissant (approbation, demande de modifs), pas en lisant.
        const participant = (): BbParticipant => {
            let me = fake.pr.participants.find((p) => p.user?.uuid === ME.uuid);
            if (!me) {
                me = { user: ME, role: 'PARTICIPANT', approved: false, state: null };
                fake.pr.participants.push(me);
            }
            return me;
        };
        let m: RegExpExecArray | null;
        if (sub === '' && req.method === 'GET') {
            return send(res, 200, fake.pr);
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
            return send(res, 201, created);
        }
        if ((m = /^\/comments\/(\d+)$/.exec(sub)) && req.method === 'DELETE') {
            const target = findComment(m[1] ?? '');
            if (!target) {
                return send(res, 404, { error: { message: 'no comment' } });
            }
            target.deleted = true;
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
