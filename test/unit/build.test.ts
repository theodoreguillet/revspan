import { describe, expect, it } from 'vitest';
import type { BuildCheck } from '../../src/shared/api.ts';
import type { BbStatus } from '../../src/server/bitbucket/types.ts';
import { summarizeBuild, toBuildChecks } from '../../src/server/core/build.ts';

const HEAD = 'a'.repeat(40);

const check = (key: string, state: BuildCheck['state']): BuildCheck => ({ key, name: key, state, url: null, updatedOn: null });

describe('summarizeBuild', () => {
    it('gives none without any check', () => {
        expect(summarizeBuild([])).toEqual({ state: 'none', failed: 0, running: 0, total: 0 });
    });

    it('gives success when every check succeeded', () => {
        expect(summarizeBuild([check('a', 'success'), check('b', 'success')])).toEqual({ state: 'success', failed: 0, running: 0, total: 2 });
    });

    it('gives running for one in-progress check among successful ones', () => {
        expect(summarizeBuild([check('a', 'success'), check('b', 'running')])).toEqual({ state: 'running', failed: 0, running: 1, total: 2 });
    });

    it('gives failed when a failure sits next to a running check', () => {
        expect(summarizeBuild([check('a', 'failed'), check('b', 'running'), check('c', 'success')]))
            .toEqual({ state: 'failed', failed: 1, running: 1, total: 3 });
    });

    it('treats a stopped check as failed', () => {
        expect(summarizeBuild([check('a', 'success'), check('b', 'stopped')])).toEqual({ state: 'failed', failed: 1, running: 0, total: 2 });
    });
});

describe('toBuildChecks', () => {
    const status = (over: Partial<BbStatus>): BbStatus => ({ key: 'ci', state: 'SUCCESSFUL', commit: { hash: HEAD }, ...over });

    it('drops statuses of another commit than the head', () => {
        const checks = toBuildChecks([status({ key: 'old', commit: { hash: 'b'.repeat(40) } }), status({ key: 'new' })], HEAD);
        expect(checks.map((c) => c.key)).toEqual(['new']);
    });

    it('matches a short head hash against a full status hash and the reverse', () => {
        expect(toBuildChecks([status({})], HEAD.slice(0, 12))).toHaveLength(1);
        expect(toBuildChecks([status({ commit: { hash: HEAD.slice(0, 12) } })], HEAD)).toHaveLength(1);
    });

    it('keeps a status without commit', () => {
        expect(toBuildChecks([{ key: 'ci', state: 'FAILED' }], HEAD)).toHaveLength(1);
    });

    it('keeps the newest status of each key', () => {
        const checks = toBuildChecks([
            status({ key: 'ci', state: 'FAILED', updated_on: '2026-10-01T10:00:00Z' }),
            status({ key: 'ci', state: 'SUCCESSFUL', updated_on: '2026-10-01T11:00:00Z' }),
            status({ key: 'scan', state: 'INPROGRESS', updated_on: '2026-10-01T09:00:00Z' }),
        ], HEAD);
        expect(checks.map((c) => [c.key, c.state])).toEqual([['ci', 'success'], ['scan', 'running']]);
    });

    it('maps fields and falls back to the key for the name', () => {
        expect(toBuildChecks([status({ key: 'scan', name: 'Security scan', state: 'STOPPED', url: 'https://ci.example.test/1', updated_on: '2026-10-01T09:00:00Z' }), status({ key: 'it' })], HEAD))
            .toEqual([
                { key: 'scan', name: 'Security scan', state: 'stopped', url: 'https://ci.example.test/1', updatedOn: '2026-10-01T09:00:00Z' },
                { key: 'it', name: 'it', state: 'success', url: null, updatedOn: null },
            ]);
    });
});
