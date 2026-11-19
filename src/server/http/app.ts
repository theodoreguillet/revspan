// HTTP application (Hono): JSON API under /api + built page (dist/web).
// Local security: Host header checked (anti DNS rebinding), writes require X-Revspan and a matching origin,
// CSP headers, and for the CLI a per-run secret cookie on every /api call (cli-secret.ts). The token never leaves the server.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ApiErrorBody, ContributorList, ErrorCode, ErrorParams, Health, PrRef } from '../../shared/api.ts';
import { MUTATION_HEADER } from '../../shared/api.ts';
import { parsePrUrl } from '../../shared/pr-url.ts';
import { AppError } from '../errors.ts';
import { redirectHash, secretCookie, secretMatches } from './cli-secret.ts';
import type { HomeService } from '../services/home-service.ts';
import type { PrService } from '../services/pr-service.ts';
import type { SettingsService } from '../services/settings-service.ts';
import {
    commentIdSchema, compareQuerySchema, editCommentSchema, newCommentSchema, newTaskSchema, parse, prRefSchema, reviewedSchema,
    settingsUpdateSchema, taskIdSchema, viewedSchema,
} from './schemas.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const PR_ROUTE = '/api/pr/:ws/:repo/:id{[0-9]+}';

export interface HttpDeps {
    /** Version shown by /api/health. */
    version: string;
    settings: SettingsService;
    home: HomeService;
    prs: PrService;
    /** Folder of the built page (dist/web); absent in the VS Code extension (the page is served by VS Code). */
    webDir?: string;
    /** Accepted hosts (e.g. 127.0.0.1:7420), known once the port is open. */
    allowedHosts: () => readonly string[];
    /** CLI's per-run secret, required as a cookie on /api (except /api/health); null/absent: no check (extension, tests). */
    secret?: string | null;
}

/** Host of the request: over HTTP the Host header is always present; an in-memory call (extension) only has the URL. */
const hostOf = (c: Context): string => c.req.header('host') ?? new URL(c.req.url).host;
/** Cookie of this server's secret, named after its port (read from the Host, already checked against allowedHosts). */
function secretCookieOf(c: Context): string {
    const host = hostOf(c);
    return secretCookie(host.slice(host.lastIndexOf(':') + 1));
}

const refOf = (c: Context): PrRef => parse(prRefSchema, { workspace: c.req.param('ws'), repo: c.req.param('repo'), id: c.req.param('id') });

async function jsonBody(c: Context): Promise<unknown> {
    const text = await c.req.text();
    if (!text) {
        return {};
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new AppError(400, 'BAD_REQUEST', 'Invalid JSON body.');
    }
}

function errorResponse(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string, params?: ErrorParams): Response {
    return c.json<ApiErrorBody>({ error: params ? { code, message, params } : { code, message } }, status);
}

const prHash = (url: string | undefined): string => {
    const ref = parsePrUrl(url);
    return ref ? `#/pr/${ref.workspace}/${ref.repo}/${ref.id}` : '';
};

export function createHttpApp({ version, settings, home, prs, webDir, allowedHosts, secret = null }: HttpDeps): Hono {
    const app = new Hono();

    app.use('*', async (c, next) => {
        const hosts = allowedHosts();
        if (!hosts.includes(hostOf(c))) {
            return errorResponse(c, 403, 'FORBIDDEN', 'Host refused.');
        }
        if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
            const origin = c.req.header('origin');
            if (c.req.header(MUTATION_HEADER) !== '1' || (origin && !hosts.some((h) => origin === `http://${h}`))) {
                return errorResponse(c, 403, 'FORBIDDEN', `Request refused (missing ${MUTATION_HEADER} header or foreign origin).`);
            }
        }
        await next();
        c.header('Cache-Control', c.req.path.startsWith('/api/') ? 'no-store' : 'no-cache');
    });

    app.use('*', secureHeaders({
        contentSecurityPolicy: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'https:', 'data:'],
            connectSrc: ["'self'"],
            baseUri: ["'none'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
        },
        referrerPolicy: 'no-referrer',
    }));

    // Reads included: the diffs and comments are as private as the writes. /api/health stays open (no data).
    app.use('/api/*', async (c, next) => {
        if (secret && c.req.path !== '/api/health' && !secretMatches(secret, getCookie(c, secretCookieOf(c)))) {
            return errorResponse(c, 401, 'NEEDS_SECRET', 'Open Revspan from the revspan command (or the address it prints).');
        }
        await next();
    });

    app.use('/api/*', bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => errorResponse(c, 413, 'BAD_REQUEST', 'Request too large.'),
    }));

    app.onError((error, c) => {
        if (error instanceof AppError) {
            return errorResponse(c, error.status, error.code, error.message, error.params);
        }
        console.error('revspan:', error);
        return errorResponse(c, 500, 'INTERNAL', `Internal error: ${error.message}`, { detail: error.message });
    });

    // ---------- API ----------

    app.get('/api/health', (c) => c.json<Health>({ app: 'revspan', version }));

    app.get('/api/settings', async (c) => c.json(await settings.get()));
    app.get('/api/settings/followed', (c) => c.json(settings.followed()));
    // Under /settings/ like the followed list: a read of /home would retitle the VS Code panel while on the Settings page.
    app.get('/api/settings/contributors', async (c) => c.json<ContributorList>({ contributors: await home.contributors() }));
    app.put('/api/settings', async (c) => c.json(await settings.update(parse(settingsUpdateSchema, await jsonBody(c)))));
    app.post('/api/settings/test', async (c) => c.json(await settings.test()));

    // ?fresh=1: ignores the home page's short cache ("Refresh" button).
    app.get('/api/home', async (c) => c.json(await home.get({ fresh: c.req.query('fresh') === '1' })));

    app.get(PR_ROUTE, async (c) => c.json(await prs.detail(refOf(c), { fresh: c.req.query('fresh') === '1' })));
    app.get(`${PR_ROUTE}/pulse`, async (c) => c.json(await prs.pulse(refOf(c))));
    app.get(`${PR_ROUTE}/summary`, async (c) => c.json(await prs.summary(refOf(c))));
    app.get(`${PR_ROUTE}/compare`, async (c) => {
        const { from, to, context } = parse(compareQuerySchema, c.req.query());
        return c.json(await prs.compare(refOf(c), from, to, context));
    });

    app.post(`${PR_ROUTE}/comments`, async (c) => c.json(await prs.createComment(refOf(c), parse(newCommentSchema, await jsonBody(c)))));
    app.put(`${PR_ROUTE}/comments/:cid`, async (c) => c.json(await prs.editComment(refOf(c), parse(commentIdSchema, c.req.param('cid')), parse(editCommentSchema, await jsonBody(c)))));
    app.delete(`${PR_ROUTE}/comments/:cid`, async (c) => c.json(await prs.deleteComment(refOf(c), parse(commentIdSchema, c.req.param('cid')))));
    app.post(`${PR_ROUTE}/comments/:cid/resolve`, async (c) => c.json(await prs.resolve(refOf(c), parse(commentIdSchema, c.req.param('cid')), true)));
    app.delete(`${PR_ROUTE}/comments/:cid/resolve`, async (c) => c.json(await prs.resolve(refOf(c), parse(commentIdSchema, c.req.param('cid')), false)));
    app.get(`${PR_ROUTE}/tasks`, async (c) => c.json(await prs.tasks(refOf(c))));
    app.post(`${PR_ROUTE}/tasks`, async (c) => c.json(await prs.createTask(refOf(c), parse(newTaskSchema, await jsonBody(c)))));
    app.delete(`${PR_ROUTE}/tasks/:tid`, async (c) => c.json(await prs.deleteTask(refOf(c), parse(taskIdSchema, c.req.param('tid')))));
    app.post(`${PR_ROUTE}/tasks/:tid/resolve`, async (c) => c.json(await prs.setTaskResolved(refOf(c), parse(taskIdSchema, c.req.param('tid')), true)));
    app.delete(`${PR_ROUTE}/tasks/:tid/resolve`, async (c) => c.json(await prs.setTaskResolved(refOf(c), parse(taskIdSchema, c.req.param('tid')), false)));
    app.post(`${PR_ROUTE}/approve`, async (c) => c.json(await prs.approve(refOf(c), true)));
    app.delete(`${PR_ROUTE}/approve`, async (c) => c.json(await prs.approve(refOf(c), false)));
    app.post(`${PR_ROUTE}/request-changes`, async (c) => c.json(await prs.requestChanges(refOf(c), true)));
    app.delete(`${PR_ROUTE}/request-changes`, async (c) => c.json(await prs.requestChanges(refOf(c), false)));
    app.post(`${PR_ROUTE}/reviewed`, async (c) => c.json(await prs.markReviewed(refOf(c), parse(reviewedSchema, await jsonBody(c)).version)));
    app.post(`${PR_ROUTE}/viewed`, async (c) => c.json(prs.markViewed(refOf(c), parse(viewedSchema, await jsonBody(c)))));

    app.all('/api/*', (c) => errorResponse(c, 404, 'NOT_FOUND', `Unknown route: ${c.req.method} ${c.req.path}`));

    // ---------- Page ----------

    // Direct link from a Bitbucket URL: /open?url=https://bitbucket.org/<ws>/<repo>/pull-requests/<id> (no secret, no data).
    // CLI: /open?k=<secret>[&to=<#/hash>] sets the secret cookie, then redirects to that hash of the page only. A wrong
    // or stale k (old address from the history) redirects the same way without a cookie: the page works if the browser
    // still holds a valid cookie, otherwise it says to open Revspan from the revspan command.
    app.get('/open', (c) => {
        const key = c.req.query('k');
        if (secret && key !== undefined) {
            if (secretMatches(secret, key)) {
                setCookie(c, secretCookieOf(c), secret, { httpOnly: true, sameSite: 'Strict', path: '/' });
            }
            return c.redirect(`/${redirectHash(c.req.query('to')) || prHash(c.req.query('url'))}`, 302);
        }
        return c.redirect(`/${prHash(c.req.query('url'))}`, 302);
    });

    if (webDir) {
        app.use('/*', serveStatic({ root: webDir }));
    }
    app.notFound((c) => errorResponse(c, 404, 'NOT_FOUND', 'File not found.'));

    return app;
}
