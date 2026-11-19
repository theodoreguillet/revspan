import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { homeLoadLine, logHomeLoads } from '../../src/extension/home-log.ts';
import type { HomeLoad } from '../../src/server/services/home-service.ts';

describe('"Revspan" log: one line per "My PRs" load', () => {
    const load: HomeLoad = {
        fresh: false,
        startedAt: Date.parse('2026-11-19T09:00:00.000Z'),
        durationMs: 1234,
        leaseWaitMs: 0,
        identity: '1a2b3c4d5e6f7a8b',
        source: 'computed',
    };

    it('timings, how the home was obtained and its identity hash, at info level', () => {
        expect(homeLoadLine(load)).toEqual({
            level: 'info',
            text: 'home load: source=computed fresh=false durationMs=1234 leaseWaitMs=0 identity=1a2b3c4d5e6f7a8b startedAt=2026-11-19T09:00:00.000Z',
        });
    });

    it('the identity the lease holder computes when the lease was taken; "unknown" when it recorded none (older version)', () => {
        expect(homeLoadLine({ ...load, source: 'shared', leaseWaitMs: 5100, holderIdentity: '1a2b3c4d5e6f7a8b' }).text)
            .toBe('home load: source=shared fresh=false durationMs=1234 leaseWaitMs=5100 identity=1a2b3c4d5e6f7a8b holder=1a2b3c4d5e6f7a8b startedAt=2026-11-19T09:00:00.000Z');
        expect(homeLoadLine({ ...load, holderIdentity: '' }).text).toContain(' holder=unknown ');
    });

    it('a failed load at warn level, with its error code', () => {
        expect(homeLoadLine({ ...load, fresh: true, durationMs: 30_000, source: undefined, error: 'BB_UNREACHABLE' })).toEqual({
            level: 'warn',
            text: 'home load failed: error=BB_UNREACHABLE fresh=true durationMs=30000 leaseWaitMs=0 identity=1a2b3c4d5e6f7a8b startedAt=2026-11-19T09:00:00.000Z',
        });
    });

    it('each load written to the channel at the level of its line', () => {
        const channel = { info: vi.fn(), warn: vi.fn() };
        const log = logHomeLoads(channel);
        log(load);
        log({ ...load, error: 'NO_TOKEN' });
        expect(channel.info).toHaveBeenCalledWith(homeLoadLine(load).text);
        expect(channel.warn).toHaveBeenCalledWith(homeLoadLine({ ...load, error: 'NO_TOKEN' }).text);
    });

    it('the extension writes the home loads to a "Revspan" log output channel', () => {
        const source = fs.readFileSync(new URL('../../src/extension/extension.ts', import.meta.url), 'utf8');
        expect(source).toContain("createOutputChannel('Revspan', { log: true })");
        expect(source).toMatch(/createExtensionApp\(context, \{ onHomeLoad: logHomeLoads\(\w+\) \}\)/);
    });
});
