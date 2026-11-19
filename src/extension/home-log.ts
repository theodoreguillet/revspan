// "Revspan" log output channel: one line per "My PRs" home load, to tell where a slow or stuck load spends its time.
import type { LogOutputChannel } from 'vscode';
import type { HomeLoad } from '../server/services/home-service.ts';

/** The log line of a home load: timings, how the home was obtained and identity hashes, never PR data or tokens. */
export function homeLoadLine(load: HomeLoad): { level: 'info' | 'warn'; text: string } {
    const fields = [
        `fresh=${load.fresh}`,
        `durationMs=${load.durationMs}`,
        `leaseWaitMs=${load.leaseWaitMs}`,
        `identity=${load.identity}`,
        // The holder of the lease when this load found it taken; one written by an older version records no identity.
        ...(load.holderIdentity === undefined ? [] : [`holder=${load.holderIdentity || 'unknown'}`]),
        `startedAt=${new Date(load.startedAt).toISOString()}`,
    ].join(' ');
    return load.error
        ? { level: 'warn', text: `home load failed: error=${load.error} ${fields}` }
        : { level: 'info', text: `home load: source=${load.source} ${fields}` };
}

/** Writes each home load to the channel, at the level of its line. */
export function logHomeLoads(channel: Pick<LogOutputChannel, 'info' | 'warn'>): (load: HomeLoad) => void {
    return (load) => {
        const { level, text } = homeLoadLine(load);
        channel[level](text);
    };
}
