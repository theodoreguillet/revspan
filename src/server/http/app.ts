// Application HTTP (Hono) : API JSON sous /api + page construite (dist/web).
// Sécurité locale : en-tête Host vérifié (anti DNS-rebinding), écritures soumises à X-Strata et à l'origine,
// en-têtes CSP. Le jeton ne quitte jamais le serveur.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ApiErrorBody, ErrorCode, Health, PrRef } from '../../shared/api.ts';
import { MUTATION_HEADER } from '../../shared/api.ts';
import { parsePrUrl } from '../../shared/pr-url.ts';
import { AppError } from '../errors.ts';
import type { HomeService } from '../services/home-service.ts';
import type { PrService } from '../services/pr-service.ts';
import type { SettingsService } from '../services/settings-service.ts';
import {
    commentIdSchema, compareQuerySchema, newCommentSchema, parse, prRefSchema, reactSchema, reviewedSchema,
    settingsUpdateSchema, viewedSchema,
} from './schemas.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const PR_ROUTE = '/api/pr/:ws/:repo/:id{[0-9]+}';

export interface HttpDeps {
    /** Version affichée par /api/health. */
    version: string;
    settings: SettingsService;
    home: HomeService;
    prs: PrService;
    /** Dossier de la page construite (dist/web) ; absent dans l'extension VS Code (la page est servie par VS Code). */
    webDir?: string;
    /** Hôtes acceptés (ex. 127.0.0.1:7420), connus une fois le port ouvert. */
    allowedHosts: () => readonly string[];
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
        throw new AppError(400, 'BAD_REQUEST', 'Corps JSON invalide.');
    }
}

function errorResponse(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string): Response {
    return c.json<ApiErrorBody>({ error: { code, message } }, status);
}

export function createHttpApp({ version, settings, home, prs, webDir, allowedHosts }: HttpDeps): Hono {
    const app = new Hono();

    app.use('*', async (c, next) => {
        const hosts = allowedHosts();
        // En HTTP, l'en-tête Host est toujours présent ; un appel en mémoire (extension) n'a que l'URL.
        const host = c.req.header('host') ?? new URL(c.req.url).host;
        if (!hosts.includes(host)) {
            return errorResponse(c, 403, 'FORBIDDEN', 'Hôte refusé.');
        }
        if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
            const origin = c.req.header('origin');
            if (c.req.header(MUTATION_HEADER) !== '1' || (origin && !hosts.some((h) => origin === `http://${h}`))) {
                return errorResponse(c, 403, 'FORBIDDEN', `Requête refusée (en-tête ${MUTATION_HEADER} manquant ou origine étrangère).`);
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

    app.use('/api/*', bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => errorResponse(c, 413, 'BAD_REQUEST', 'Requête trop volumineuse.'),
    }));

    app.onError((error, c) => {
        if (error instanceof AppError) {
            return errorResponse(c, error.status, error.code, error.message);
        }
        console.error('strata:', error);
        return errorResponse(c, 500, 'INTERNAL', `Erreur interne : ${error.message}`);
    });

    // ---------- API ----------

    app.get('/api/health', (c) => c.json<Health>({ app: 'strata', version }));

    app.get('/api/settings', async (c) => c.json(await settings.get()));
    app.put('/api/settings', async (c) => c.json(await settings.update(parse(settingsUpdateSchema, await jsonBody(c)))));
    app.post('/api/settings/test', async (c) => c.json(await settings.test()));

    // ?fresh=1 : ignore le cache court de l'accueil (bouton « Actualiser »).
    app.get('/api/home', async (c) => c.json(await home.get({ fresh: c.req.query('fresh') === '1' })));

    app.get(PR_ROUTE, async (c) => c.json(await prs.detail(refOf(c))));
    app.get(`${PR_ROUTE}/summary`, async (c) => c.json(await prs.summary(refOf(c))));
    app.get(`${PR_ROUTE}/compare`, async (c) => {
        const { from, to, context } = parse(compareQuerySchema, c.req.query());
        return c.json(await prs.compare(refOf(c), from, to, context));
    });

    app.post(`${PR_ROUTE}/comments`, async (c) => c.json(await prs.createComment(refOf(c), parse(newCommentSchema, await jsonBody(c)))));
    app.delete(`${PR_ROUTE}/comments/:cid`, async (c) => c.json(await prs.deleteComment(refOf(c), parse(commentIdSchema, c.req.param('cid')))));
    app.post(`${PR_ROUTE}/comments/:cid/resolve`, async (c) => c.json(await prs.resolve(refOf(c), parse(commentIdSchema, c.req.param('cid')), true)));
    app.delete(`${PR_ROUTE}/comments/:cid/resolve`, async (c) => c.json(await prs.resolve(refOf(c), parse(commentIdSchema, c.req.param('cid')), false)));
    app.post(`${PR_ROUTE}/react`, async (c) => c.json(await prs.react(refOf(c), parse(reactSchema, await jsonBody(c)))));
    app.post(`${PR_ROUTE}/approve`, async (c) => c.json(await prs.approve(refOf(c), true)));
    app.delete(`${PR_ROUTE}/approve`, async (c) => c.json(await prs.approve(refOf(c), false)));
    app.post(`${PR_ROUTE}/request-changes`, async (c) => c.json(await prs.requestChanges(refOf(c), true)));
    app.delete(`${PR_ROUTE}/request-changes`, async (c) => c.json(await prs.requestChanges(refOf(c), false)));
    app.post(`${PR_ROUTE}/reviewed`, async (c) => c.json(await prs.markReviewed(refOf(c), parse(reviewedSchema, await jsonBody(c)).version)));
    app.post(`${PR_ROUTE}/viewed`, async (c) => c.json(prs.markViewed(refOf(c), parse(viewedSchema, await jsonBody(c)))));

    app.all('/api/*', (c) => errorResponse(c, 404, 'NOT_FOUND', `Route inconnue : ${c.req.method} ${c.req.path}`));

    // ---------- Page ----------

    // Lien direct depuis une URL Bitbucket : /open?url=https://bitbucket.org/<ws>/<repo>/pull-requests/<id>
    app.get('/open', (c) => {
        const ref = parsePrUrl(c.req.query('url'));
        return c.redirect(ref ? `/#/pr/${ref.workspace}/${ref.repo}/${ref.id}` : '/', 302);
    });

    if (webDir) {
        app.use('/*', serveStatic({ root: webDir }));
    }
    app.notFound((c) => errorResponse(c, 404, 'NOT_FOUND', 'Fichier introuvable.'));

    return app;
}
