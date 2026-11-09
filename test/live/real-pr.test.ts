// Test réel en LECTURE SEULE sur une PR Bitbucket de ton choix (uniquement des GET, aucune écriture).
// Lancement : STRATA_LIVE_PR=<URL de la PR> STRATA_LIVE_EMAIL=<e-mail Atlassian> npm run test:live
// (STRATA_KEYCHAIN_SERVICE si le jeton est rangé sous un autre service du trousseau).
// Invariants valables pour toute PR ; le diff complet doit être identique au diffstat calculé par Bitbucket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Comparison, Home, PrDetail, Summary, VersionKind } from '../../src/shared/api.ts';
import { parsePrUrl } from '../../src/shared/pr-url.ts';
import { startApp, type RunningApp } from '../../src/server/app.ts';
import { DEFAULT_BASE_URL } from '../../src/server/bitbucket/client.ts';
import { createSecretStore } from '../../src/server/infra/secrets.ts';

const ref = parsePrUrl(process.env.STRATA_LIVE_PR);
const email = process.env.STRATA_LIVE_EMAIL ?? '';
const enabled = process.env.STRATA_LIVE === '1' && email !== '' && ref !== null;
const KINDS: readonly VersionKind[] = ['creation', 'code', 'deps', 'rebase-only', 'message-only', 'none', 'unavailable'];
const route = ref ? `/api/pr/${ref.workspace}/${ref.repo}/${ref.id}` : '';
let app: RunningApp | null = null;
let dir: string | null = null;

async function get<T>(url: string): Promise<T> {
    const response = await fetch(`${app!.url}${url}`);
    const body = await response.json() as T;
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
}

/** Diffstat de la PR calculé par Bitbucket (toutes les pages). */
async function bitbucketDiffstat(): Promise<{ files: number; added: number; removed: number }> {
    const token = await (await createSecretStore({ dir: dir! })).get(email);
    expect(token, 'jeton absent du trousseau').toBeTruthy();
    const headers = { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
    const total = { files: 0, added: 0, removed: 0 };
    let next: string | undefined = `${DEFAULT_BASE_URL}/repositories/${ref!.workspace}/${ref!.repo}/pullrequests/${ref!.id}/diffstat?pagelen=500`;
    while (next) {
        const response = await fetch(next, { headers });
        expect(response.status).toBe(200);
        const page = await response.json() as { values: { lines_added?: number; lines_removed?: number }[]; next?: string };
        for (const entry of page.values) {
            total.files += 1;
            total.added += entry.lines_added ?? 0;
            total.removed += entry.lines_removed ?? 0;
        }
        next = page.next;
    }
    return total;
}

beforeAll(async () => {
    if (!enabled) {
        return;
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-live-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ email, repos: [`${ref!.workspace}/${ref!.repo}`] }));
    app = await startApp({ port: 0, env: { ...process.env, STRATA_CONFIG_DIR: dir } });
});

afterAll(async () => {
    await app?.close();
    if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe.runIf(enabled)('PR réelle (lecture seule)', () => {
    it('versions numérotées dans l\'ordre des pushs, la première n\'est pas un rebase', async () => {
        const { versions } = await get<PrDetail>(route);
        expect(versions.length).toBeGreaterThanOrEqual(1);
        expect(versions.map((v) => v.index)).toEqual(versions.map((_, k) => k + 1));
        expect(versions[0]!.isRebase).toBe(false);
        const dates = versions.map((v) => v.pushedAt);
        expect(dates).toEqual([...dates].sort());
    });

    it('un résumé par version, types connus ; versions effacées par Bitbucket = indisponibles, jamais la dernière', async () => {
        const [{ versions }, summary] = await Promise.all([get<PrDetail>(route), get<Summary>(`${route}/summary`)]);
        expect(summary.versions.map((s) => s.index)).toEqual(versions.map((v) => v.index));
        expect(summary.versions.every((s) => KINDS.includes(s.kind))).toBe(true);
        expect(summary.versions.map((s) => s.kind === 'unavailable')).toEqual(versions.map((v) => !v.available));
        expect(versions.at(-1)!.available).toBe(true);
        expect(['creation', 'unavailable']).toContain(summary.versions[0]!.kind);
    });

    it('la comparaison de la dernière version avec sa référence correspond à son résumé', async () => {
        const { versions } = await get<Summary>(`${route}/summary`);
        const last = versions.at(-1)!;
        if (last.index < 2) {
            return;
        }
        const reference = last.since ?? last.index - 1;
        const { stats } = await get<Comparison>(`${route}/compare?from=${reference}&to=${last.index}`);
        expect([stats.added, stats.removed]).toEqual([last.added, last.removed]);
    });

    it('diff complet identique au diffstat de Bitbucket', async () => {
        const { versions } = await get<PrDetail>(route);
        const { stats } = await get<Comparison>(`${route}/compare?from=0&to=${versions.length}`);
        expect(stats).toEqual(await bitbucketDiffstat());
    });

    it('accueil réel sur le dépôt de la PR : lu sans erreur', async () => {
        const home = await get<Home>('/api/home');
        expect(home.errors).toEqual([]);
        expect(home.repos).toEqual([`${ref!.workspace}/${ref!.repo}`]);
    });
});
