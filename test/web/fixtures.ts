// Données de test de src/web/lib : PR #212 (longue, 10 versions) et #118 (rebase seul) en JSON, anonymisées ;
// versions synthétiques.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrDetail, Summary, Thread, Version, VersionKind, VersionSummary } from '../../src/shared/api.ts';
import { summaryMap, type SummaryMap } from '../../src/web/lib/kinds.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/api');

function fixture<T>(name: string): T {
    return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as T;
}

export function loadPr(id: 'long' | 'rebase'): { data: PrDetail; sums: SummaryMap } {
    return { data: fixture<PrDetail>(`pr-${id}.json`), sums: summaryMap(fixture<Summary>(`summary-${id}.json`)) };
}

export const prLong = (): { data: PrDetail; sums: SummaryMap } => loadPr('long');

export function versionAt(versions: Version[], index: number): Version {
    const version = versions.find((v) => v.index === index);
    if (!version) {
        throw new Error(`version v${index} absente`);
    }
    return version;
}

export function threadById(data: PrDetail, id: number): Thread {
    const thread = data.threads.find((t) => t.id === id);
    if (!thread) {
        throw new Error(`fil ${id} absent`);
    }
    return thread;
}

export interface VersionOptions {
    /** Versions qui sont des rebases. */
    rebases?: number[];
    /** Versions dont le message du commit a changé. */
    messageChanged?: number[];
    /** Écart en jours entre deux pushs (à partir du 1er juin 2026, midi UTC). */
    stepDays?: number;
    /** Versions dont Bitbucket a effacé le commit. */
    unavailable?: number[];
}

export function makeVersions(count: number, { rebases = [], messageChanged = [], stepDays = 1, unavailable = [] }: VersionOptions = {}): Version[] {
    return Array.from({ length: count }, (_, k) => ({
        index: k + 1,
        hash: `h${k + 1}`.padEnd(40, '0'),
        shortHash: `h${k + 1}`,
        pushedAt: new Date(Date.UTC(2026, 5, 1 + k * stepDays, 12)).toISOString(),
        pushedBy: null,
        destHash: 'd'.repeat(40),
        base: 'b'.repeat(40),
        baseShort: 'bbbbbbb',
        isRebase: rebases.includes(k + 1),
        message: 'msg',
        messageChanged: messageChanged.includes(k + 1),
        available: !unavailable.includes(k + 1),
    }));
}

export function makeSums(kinds: VersionKind[]): SummaryMap {
    const versions: VersionSummary[] = kinds.map((kind, k) => ({
        index: k + 1,
        kind,
        added: kind === 'code' || kind === 'creation' ? 10 : 0,
        removed: kind === 'code' ? 2 : 0,
        files: kind === 'code' || kind === 'creation'
            ? [{ path: `src/F${k + 1}.ts`, added: 10, removed: 2, category: 'code' }]
            : kind === 'deps' ? [{ path: 'package-lock.json', added: 4, removed: 4, category: 'deps' }] : [],
        masterFiles: kind === 'rebase-only' ? 5 : 0,
        conflicts: 0,
    }));
    return summaryMap({ versions });
}
