// Build statuses of a PR (any CI that publishes statuses to Bitbucket): per-commit filtering and aggregation.
import type { BuildCheck, BuildSummary } from '../../shared/api.ts';
import type { BbStatus } from '../bitbucket/types.ts';

const HASH_PREFIX = 12;

const STATES: Record<BbStatus['state'], BuildCheck['state']> = {
    SUCCESSFUL: 'success',
    FAILED: 'failed',
    INPROGRESS: 'running',
    STOPPED: 'stopped',
};

const time = (iso: string | undefined): number => {
    const value = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(value) ? -Infinity : value;
};

/**
 * Checks of the head commit only (a status of an older commit says nothing about the code under review),
 * the newest status of each key. A status without commit is kept.
 */
export function toBuildChecks(statuses: BbStatus[], headHash: string): BuildCheck[] {
    const prefix = headHash.slice(0, HASH_PREFIX);
    const latest = new Map<string, BbStatus>();
    for (const status of statuses) {
        if (status.commit && !status.commit.hash.startsWith(prefix)) {
            continue;
        }
        const known = latest.get(status.key);
        if (!known || time(status.updated_on) > time(known.updated_on)) {
            latest.set(status.key, status);
        }
    }
    return [...latest.values()].map((status) => ({
        key: status.key,
        name: status.name || status.key,
        state: STATES[status.state],
        url: status.url ?? null,
        updatedOn: status.updated_on ?? null,
    }));
}

/** failed (or stopped) wins over running, running over success; no check gives none. */
export function summarizeBuild(checks: BuildCheck[]): BuildSummary {
    const failed = checks.filter((c) => c.state === 'failed' || c.state === 'stopped').length;
    const running = checks.filter((c) => c.state === 'running').length;
    const total = checks.length;
    if (failed > 0) {
        return { state: 'failed', failed, running, total };
    }
    if (running > 0) {
        return { state: 'running', failed, running, total };
    }
    return { state: total > 0 ? 'success' : 'none', failed, running, total };
}
