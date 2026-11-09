// Simulated git repository in memory (commits = { path: content } snapshots) and realistic PR scenario:
// creation, amend, pure rebase, RC bump in the lockfile, rebase + code, message only.
import { diffLines, diffStats, splitLines } from '../../src/server/core/diff.ts';
import type { CompareSource, CompareVersion, DiffstatEntry } from '../../src/server/core/compare.ts';

export interface FakeCommit {
    hash: string;
    files: Record<string, string>;
    parent: string | null;
    message: string;
}

export class FakeRepo {
    readonly commits = new Map<string, FakeCommit>();
    readonly calls = { diffstat: 0, content: 0 };

    commit(hash: string, files: Record<string, string>, parent: string | null = null, message = 'DEMO-1 - feat(x): do it'): string {
        this.commits.set(hash, { hash, files: { ...files }, parent, message });
        return hash;
    }

    derive(hash: string, fromHash: string, changes: Record<string, string | null>, message?: string): string {
        const files = { ...this.get(fromHash).files };
        for (const [path, content] of Object.entries(changes)) {
            if (content === null) {
                delete files[path];
            } else {
                files[path] = content;
            }
        }
        return this.commit(hash, files, fromHash, message);
    }

    get(hash: string): FakeCommit {
        const commit = this.commits.get(hash);
        if (!commit) {
            throw new Error(`commit inconnu : ${hash}`);
        }
        return commit;
    }

    source(): CompareSource {
        return {
            diffstat: async (newHash, oldHash) => {
                this.calls.diffstat++;
                return diffstatBetween(this.get(oldHash).files, this.get(newHash).files);
            },
            content: async (hash, path) => {
                this.calls.content++;
                const text = this.commits.get(hash)?.files[path];
                return text === undefined ? { missing: true } : { text };
            },
        };
    }
}

export function diffstatBetween(a: Record<string, string>, b: Record<string, string>): DiffstatEntry[] {
    const entries: DiffstatEntry[] = [];
    for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[path] === b[path]) {
            continue;
        }
        const { added, removed } = diffStats(diffLines(splitLines(a[path] ?? ''), splitLines(b[path] ?? '')));
        entries.push({
            status: a[path] === undefined ? 'added' : b[path] === undefined ? 'removed' : 'modified',
            oldPath: a[path] === undefined ? null : path,
            newPath: b[path] === undefined ? null : path,
            added,
            removed,
        });
    }
    return entries;
}

const lines = (list: readonly string[]): string => `${list.join('\n')}\n`;

export function lockfile(deps: Record<string, string>): string {
    return lines(['{', ...Object.entries(deps).map(([name, version]) => `    "${name}": "${version}",`), '}']);
}

export interface ScenarioVersion extends CompareVersion {
    shortHash: string;
    pushedAt: string;
    destHash: string;
    baseShort: string;
}

/** M0 -> v1 (creation) -> v2 (amend code) -> M1 -> v3 (pure rebase) -> v4 (amend deps) -> M2 -> v5 (rebase + code) -> v6 (message only). */
export function scenario(): { repo: FakeRepo; versions: ScenarioVersion[] } {
    const repo = new FakeRepo();
    const action = (idExpression: string): string => lines([
        'export class Action {',
        '    run(data) {',
        `        const id = ${idExpression};`,
        '        if (!id) {',
        '            return false;',
        '        }',
        '        return this.save(id);',
        '    }',
        '}',
    ]);
    const lockM0 = { a: '1.0.0', b: '1.0.0', c: '1.0.0', d: '1.0.0', e: '1.0.0' };
    const spec = lines(['describe("Action", () => {});']);
    repo.commit('m0', {
        'src/Action.ts': action('data.labels?.slug'),
        'src/Other.ts': lines(['export const other = 1;']),
        'changelog.md': lines(['# Changelog', '## 1.0.0']),
        'package-lock.json': lockfile(lockM0),
    });
    repo.derive('v1', 'm0', {
        'src/Action.ts': action('data.labels?.slug ?? data.id'),
        'tests/ActionSpec.ts': spec,
        'package-lock.json': lockfile({ ...lockM0, c: '1.0.0-rc.1', e: '2.0.0-rc.1' }),
    });
    repo.derive('v2', 'v1', { 'src/Action.ts': action('this.repo.buildIdFromPayload(data)') });
    repo.derive('m1', 'm0', {
        'src/Other.ts': lines(['export const other = 2;']),
        'changelog.md': lines(['# Changelog', '## 1.1.0', '## 1.0.0']),
        'package-lock.json': lockfile({ ...lockM0, a: '1.1.0', e: '2.0.0' }),
    });
    // Rebase of v2 onto m1; conflict on "e" resolved by keeping the author's RC.
    repo.derive('v3', 'm1', {
        'src/Action.ts': action('this.repo.buildIdFromPayload(data)'),
        'tests/ActionSpec.ts': spec,
        'package-lock.json': lockfile({ ...lockM0, a: '1.1.0', c: '1.0.0-rc.1', e: '2.0.0-rc.1' }),
    });
    repo.derive('v4', 'v3', { 'package-lock.json': lockfile({ ...lockM0, a: '1.1.0', c: '1.0.0-rc.2', e: '2.0.0-rc.1' }) });
    repo.derive('m2', 'm1', { 'src/Third.ts': lines(['export const third = 3;']) });
    repo.derive('v5', 'm2', {
        'src/Action.ts': action('this.repo.buildIdFromPayload(data)').replace('return this.save(id);', 'return this.repo.save(id);'),
        'tests/ActionSpec.ts': spec,
        'package-lock.json': lockfile({ ...lockM0, a: '1.1.0', c: '1.0.0-rc.2', e: '2.0.0-rc.1' }),
    });
    repo.derive('v6', 'v5', {}, 'DEMO-1 - feat(x): do it better');

    const plan: [string, string, string][] = [
        ['v1', 'm0', '2026-10-01T10:00:00Z'],
        ['v2', 'm0', '2026-10-02T10:00:00Z'],
        ['v3', 'm1', '2026-10-10T10:00:00Z'],
        ['v4', 'm1', '2026-10-10T11:00:00Z'],
        ['v5', 'm2', '2026-10-20T10:00:00Z'],
        ['v6', 'm2', '2026-10-21T10:00:00Z'],
    ];
    const versions = plan.map(([hash, base, date], i): ScenarioVersion => {
        const previous = plan[i - 1];
        return {
            index: i + 1,
            hash,
            shortHash: hash,
            pushedAt: date,
            destHash: base,
            base,
            baseShort: base,
            isRebase: previous !== undefined && previous[1] !== base,
            message: repo.get(hash).message,
            messageChanged: previous !== undefined && repo.get(previous[0]).message !== repo.get(hash).message,
        };
    });
    return { repo, versions };
}
