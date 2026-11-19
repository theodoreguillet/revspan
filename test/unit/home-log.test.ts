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

    it('a home another window computed: the time waited for it', () => {
        expect(homeLoadLine({ ...load, source: 'shared', leaseWaitMs: 5100 }).text)
            .toBe('home load: source=shared fresh=false durationMs=1234 leaseWaitMs=5100 identity=1a2b3c4d5e6f7a8b startedAt=2026-11-19T09:00:00.000Z');
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
