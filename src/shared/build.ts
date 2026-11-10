// Build state of a PR from its checks (shared by the server, the extension and the page).
import type { BuildCheck, BuildSummary } from './api.ts';

/** failed (or stopped) wins over running, running over success; no check gives none. */
export function summarizeBuild(checks: readonly BuildCheck[]): BuildSummary {
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
