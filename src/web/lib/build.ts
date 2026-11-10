// Build state shown on the home rows, the PR header badge and the Builds tab (texts from the translator).
import type { BuildCheck, BuildSummary } from '../../shared/api.ts';
import type { MessageKey, Translator } from '../i18n/index.ts';
import { ago } from './format.ts';

const CHECK_STATES = {
    success: 'build.state.success',
    failed: 'build.state.failed',
    running: 'build.state.running',
    stopped: 'build.state.stopped',
} as const satisfies Record<BuildCheck['state'], MessageKey>;

/** Short pill of a home row: "✗ failed", "running", "✓ passed"; empty without build. */
export function buildRowText(tr: Translator, build: BuildSummary): string {
    switch (build.state) {
        case 'failed':
            return tr.t('build.row.failed');
        case 'running':
            return tr.t('build.row.running');
        case 'success':
            return tr.t('build.row.success');
        default:
            return '';
    }
}

/** Compact badge of the PR header: "✗ 1 failure", "build running", "✓ builds passed"; empty without build. */
export function buildHeaderText(tr: Translator, build: BuildSummary): string {
    switch (build.state) {
        case 'failed':
            return tr.t('build.head.failed', { count: build.failed });
        case 'running':
            return tr.t('build.head.running');
        case 'success':
            return tr.t('build.head.success');
        default:
            return '';
    }
}

/** State and age of one check of the Builds tab. */
export function buildCheckText(tr: Translator, check: BuildCheck): { state: string; when: string } {
    return { state: tr.t(CHECK_STATES[check.state]), when: check.updatedOn ? ago(tr, check.updatedOn) : '' };
}

/** Link of a check, opened in a new tab: absolute http or https URL only, otherwise null. */
export function safeBuildUrl(value: string | null): string | null {
    if (!value) {
        return null;
    }
    try {
        const url = new URL(value.trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
        return null;
    }
}
