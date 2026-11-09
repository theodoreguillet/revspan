// Comparison of two PR versions, keeping only the author's changes.
// If B was rebased, A is first replayed onto B's base (3-way merge), then compared with B:
// lines brought in by master (lockfile, changelog...) disappear.
import { createHash } from 'node:crypto';
import type {
    Comparison, FileCategory, FileDiff, FileStatus, Thread, ThreadPlacement, Version, VersionKind, VersionSummary,
} from '../../shared/api.ts';
import { buildHunks, diffLines, diffStats, NO_EOL, splitDiffLines } from './diff.ts';
import { merge3 } from './merge3.ts';
import { mapLine } from './linemap.ts';
import { categoryOf, sameHash } from './classify.ts';
import { isReadable, previousAvailable } from './model.ts';

const MAX_LINES = 60000;

/** Diffstat entry (two-dot diff between two commits). */
export interface DiffstatEntry {
    status: string;
    oldPath: string | null;
    newPath: string | null;
    added: number;
    removed: number;
}

/** Path of an entry (the new one, or the old one for a deleted file). */
export const pathOf = (entry: DiffstatEntry): string => entry.newPath ?? entry.oldPath ?? '';

/** fingerprint: content fingerprint, absent from older cache entries (two sides without a fingerprint are never equal). */
export type FileContent =
    | { text: string; submodule?: boolean }
    | { missing: true }
    | { binary: true; fingerprint?: string }
    | { tooLarge: true; fingerprint?: string }
    | { special: true };

/** Access to a repository's data (real Bitbucket, in-memory in tests). */
export interface CompareSource {
    diffstat(newHash: string, oldHash: string): Promise<DiffstatEntry[]>;
    content(hash: string, path: string): Promise<FileContent>;
}

/** Compared version; `available` absent = readable. */
export type CompareVersion = Pick<Version, 'index' | 'hash' | 'base' | 'message' | 'isRebase' | 'messageChanged'> & Partial<Pick<Version, 'available'>>;

export class InvalidComparisonError extends Error {
    override name = 'InvalidComparisonError';
}

type Flag = 'binary' | 'tooLarge' | 'special';

/** One side of a file comparison. */
interface Side {
    exists: boolean;
    lines: string[];
    text: string | null;
    flag: Flag | null;
    /** Fingerprint of a binary or oversized side (null if unknown). */
    fingerprint: string | null;
    submodule: boolean;
}

interface FileOptions {
    context: number;
    withHunks: boolean;
}

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

function sideOf(content: FileContent): Side {
    if ('missing' in content) {
        return { exists: false, lines: [], text: null, flag: null, fingerprint: null, submodule: false };
    }
    if ('text' in content) {
        return { exists: true, lines: splitDiffLines(content.text), text: content.text, flag: null, fingerprint: null, submodule: Boolean(content.submodule) };
    }
    const flag: Flag = 'binary' in content ? 'binary' : 'tooLarge' in content ? 'tooLarge' : 'special';
    const fingerprint = 'fingerprint' in content ? content.fingerprint ?? null : null;
    return { exists: true, lines: [], text: null, flag, fingerprint, submodule: false };
}

function sameSide(a: Side, b: Side): boolean {
    if (a.exists !== b.exists) {
        return false;
    }
    if (!a.exists) {
        return true;
    }
    if (a.flag || b.flag) {
        // Binary or too large: equal only if both fingerprints are known and identical.
        return a.flag === b.flag && a.fingerprint !== null && a.fingerprint === b.fingerprint;
    }
    return a.text === b.text;
}

function statusOf(entry: DiffstatEntry, oldSide: Side, newSide: Side): FileStatus {
    if (!oldSide.exists && newSide.exists) {
        return 'added';
    }
    if (oldSide.exists && !newSide.exists) {
        return 'removed';
    }
    return entry.status === 'renamed' ? 'renamed' : 'modified';
}

function finishFile(entry: DiffstatEntry, oldSide: Side, newSide: Side, options: FileOptions & { conflict: boolean }): FileDiff | null {
    const path = pathOf(entry);
    const status = statusOf(entry, oldSide, newSide);
    // A submodule pointer is grouped with the dependencies.
    const category: FileCategory = oldSide.submodule || newSide.submodule ? 'deps' : categoryOf(path);
    const base: FileDiff = {
        path,
        oldPath: status === 'renamed' ? entry.oldPath : null,
        status,
        category,
        binary: false,
        tooLarge: false,
        added: 0,
        removed: 0,
        contentHash: sha1(newSide.text ?? (newSide.exists ? `${newSide.flag}:${path}` : '')),
        conflict: options.conflict,
        hunks: [],
        threads: [],
    };
    // Identical content: nothing to show, except a rename (kept, as for a text file).
    const unchanged = status === 'modified' && sameSide(oldSide, newSide);
    if (oldSide.flag || newSide.flag) {
        if (unchanged) {
            return null;
        }
        const flag = oldSide.flag ?? newSide.flag;
        return { ...base, binary: flag !== 'tooLarge', tooLarge: flag === 'tooLarge', added: entry.added, removed: entry.removed };
    }
    if (oldSide.lines.length > MAX_LINES || newSide.lines.length > MAX_LINES) {
        return unchanged ? null : { ...base, tooLarge: true, added: entry.added, removed: entry.removed };
    }
    const ops = diffLines(oldSide.lines, newSide.lines);
    const { added, removed } = diffStats(ops);
    if (added === 0 && removed === 0 && status === 'modified') {
        return null;
    }
    return {
        ...base,
        added,
        removed,
        hunks: options.withHunks ? buildHunks(ops, oldSide.lines, newSide.lines, options.context) : [],
    };
}

/** Both sides of a file to compare, and whether an area was touched by both master and the author. */
interface Sides {
    oldSide: Side;
    newSide: Side;
    conflict: boolean;
}

async function directSides(src: CompareSource, entry: DiffstatEntry, oldHash: string, newHash: string): Promise<Sides> {
    const [oldContent, newContent] = await Promise.all([
        entry.oldPath ? src.content(oldHash, entry.oldPath) : { missing: true as const },
        entry.newPath ? src.content(newHash, entry.newPath) : { missing: true as const },
    ]);
    return { oldSide: sideOf(oldContent), newSide: sideOf(newContent), conflict: false };
}

/** Replays version A onto B's base (3-way merge): the "old" side keeps only the author's changes. */
async function rebasedSides(src: CompareSource, entry: DiffstatEntry, va: CompareVersion, vb: CompareVersion): Promise<Sides> {
    const path = pathOf(entry);
    const [anc, mine, newBase, target] = (await Promise.all([
        src.content(va.base, path),
        src.content(va.hash, path),
        src.content(vb.base, path),
        src.content(vb.hash, path),
    ])).map(sideOf) as [Side, Side, Side, Side];

    // File untouched by the author in A (A replayed = new base) or by master (A unchanged): also holds for a binary.
    if (sameSide(mine, anc)) {
        return { oldSide: newBase, newSide: target, conflict: false };
    }
    if (sameSide(newBase, anc)) {
        return { oldSide: mine, newSide: target, conflict: false };
    }
    const tooBig = [anc, mine, newBase, target].some((s) => s.lines.length > MAX_LINES);
    if (anc.flag || mine.flag || newBase.flag || target.flag || tooBig) {
        return { oldSide: mine, newSide: target, conflict: false };
    }
    if (!mine.exists || !newBase.exists || !anc.exists) {
        return { oldSide: mine, newSide: target, conflict: true };
    }
    const merged = merge3(anc.lines, newBase.lines, mine.lines);
    return {
        oldSide: { exists: true, lines: merged.lines, text: merged.lines.join('\n'), flag: null, fingerprint: null, submodule: mine.submodule },
        newSide: target,
        conflict: merged.conflicts > 0,
    };
}

/** va = null: full version vb against its base. Otherwise direct diff if same base (or rename), replayed otherwise. */
function sidesFor(src: CompareSource, entry: DiffstatEntry, va: CompareVersion | null, vb: CompareVersion): Promise<Sides> {
    if (!va) {
        return directSides(src, entry, vb.base, vb.hash);
    }
    if (sameHash(va.base, vb.base) || entry.status === 'renamed') {
        return directSides(src, entry, va.hash, vb.hash);
    }
    return rebasedSides(src, entry, va, vb);
}

function sortFiles(files: FileDiff[]): FileDiff[] {
    return files.sort((a, b) => (a.category === b.category ? a.path.localeCompare(b.path) : a.category === 'code' ? -1 : 1));
}

/** from = 0: full `to` version against its base; otherwise the author's changes between from and to. */
export async function compareVersions(
    src: CompareSource,
    versions: readonly CompareVersion[],
    from: number,
    to: number,
    { context = 3, withHunks = true }: Partial<FileOptions> = {},
): Promise<Comparison> {
    const vb = versions[to - 1];
    if (!vb || from < 0 || from >= to) {
        throw new InvalidComparisonError(`Comparaison invalide : ${from} → ${to}`);
    }
    const options: FileOptions = { context, withHunks };
    const masterOnly: string[] = [];
    let files: (FileDiff | null)[];
    let va: CompareVersion | null = null;

    if (from === 0) {
        const entries = await src.diffstat(vb.hash, vb.base);
        files = await Promise.all(entries.map(async (entry) => {
            const { oldSide, newSide, conflict } = await sidesFor(src, entry, null, vb);
            return finishFile(entry, oldSide, newSide, { ...options, conflict });
        }));
    } else {
        const a = versions[from - 1];
        if (!a) {
            throw new InvalidComparisonError(`Version inconnue : ${from}`);
        }
        va = a;
        const [entriesA, entriesB, tips] = await Promise.all([
            src.diffstat(a.hash, a.base),
            src.diffstat(vb.hash, vb.base),
            sameHash(a.hash, vb.hash) ? Promise.resolve([]) : src.diffstat(vb.hash, a.hash),
        ]);
        // Only files touched by the PR (in A or in B) can carry author changes.
        const prPaths = new Set([...entriesA, ...entriesB].flatMap((e) => [e.oldPath, e.newPath]).filter((p): p is string => Boolean(p)));
        const candidates: DiffstatEntry[] = [];
        for (const entry of tips) {
            if ((entry.newPath && prPaths.has(entry.newPath)) || (entry.oldPath && prPaths.has(entry.oldPath))) {
                candidates.push(entry);
            } else {
                masterOnly.push(pathOf(entry));
            }
        }
        files = await Promise.all(candidates.map(async (entry) => {
            const { oldSide, newSide, conflict } = await sidesFor(src, entry, a, vb);
            const file = finishFile(entry, oldSide, newSide, { ...options, conflict });
            if (!file) {
                masterOnly.push(pathOf(entry));
            }
            return file;
        }));
    }

    const kept = sortFiles(files.filter((f): f is FileDiff => f !== null));
    const messageFrom = va?.message ?? '';
    return {
        from,
        to,
        stats: {
            files: kept.length,
            added: kept.reduce((sum, f) => sum + f.added, 0),
            removed: kept.reduce((sum, f) => sum + f.removed, 0),
        },
        files: kept,
        masterOnly: masterOnly.sort(),
        messageChanged: va !== null && messageFrom.trim() !== vb.message.trim(),
        messageFrom,
        messageTo: vb.message,
    };
}

/** Displayable text of a side (final newline restored as in the original). */
function sideText(side: Side, path: string): string {
    if (!side.exists) {
        return '';
    }
    if (side.flag) {
        return `(${side.flag === 'tooLarge' ? 'file too large' : 'binary file'}: ${path})\n`;
    }
    const lines = side.lines.slice();
    const last = lines[lines.length - 1];
    if (last === undefined) {
        return '';
    }
    if (last.endsWith(NO_EOL)) {
        lines[lines.length - 1] = last.slice(0, -NO_EOL.length);
        return lines.join('\n');
    }
    return `${lines.join('\n')}\n`;
}

/** Content of both sides of a file, as compared by compareVersions (A replayed onto B's base if needed). */
export async function fileSides(
    src: CompareSource,
    versions: readonly CompareVersion[],
    from: number,
    to: number,
    { path, oldPath }: { path: string; oldPath: string | null },
): Promise<{ oldText: string; newText: string }> {
    const vb = versions[to - 1];
    const va = from === 0 ? null : versions[from - 1];
    if (!vb || va === undefined || from >= to) {
        throw new InvalidComparisonError(`Comparaison invalide : ${from} → ${to}`);
    }
    const before = oldPath ?? path;
    const entry: DiffstatEntry = { status: before === path ? 'modified' : 'renamed', oldPath: before, newPath: path, added: 0, removed: 0 };
    const { oldSide, newSide } = await sidesFor(src, entry, va, vb);
    return { oldText: sideText(oldSide, before), newText: sideText(newSide, path) };
}

/** Places the comment threads on the files of the comparison ("to" side). */
export async function placeThreads(
    src: CompareSource,
    versions: readonly CompareVersion[],
    result: Comparison,
    threads: readonly Pick<Thread, 'id' | 'path' | 'anchor' | 'version'>[],
): Promise<Comparison> {
    const vb = versions[result.to - 1];
    if (!vb) {
        return result;
    }
    await Promise.all(threads.map(async (thread) => {
        const file = thread.path ? result.files.find((f) => f.path === thread.path || f.oldPath === thread.path) : undefined;
        if (!file || !thread.path) {
            return;
        }
        let line: number | null = null;
        let moved = false;
        const anchorLine = thread.anchor?.to;
        if (anchorLine && file.status !== 'removed' && !file.binary && !file.tooLarge) {
            if (thread.version === result.to) {
                line = anchorLine;
            } else {
                // Thread version unavailable (commit erased): original position unreadable, thread left at file level.
                const vc = versions[thread.version - 1];
                if (vc && isReadable(vc)) {
                    const [oldContent, newContent] = await Promise.all([src.content(vc.hash, thread.path), src.content(vb.hash, file.path)]);
                    const oldSide = sideOf(oldContent);
                    const newSide = sideOf(newContent);
                    if (oldSide.text !== null && newSide.text !== null) {
                        const mapped = mapLine(oldSide.lines, newSide.lines, anchorLine);
                        line = mapped.line;
                        moved = mapped.changed;
                    }
                }
            }
        }
        const outOfHunks = line !== null && !file.hunks.some((h) => line! >= h.newStart && line! < h.newStart + h.newLines);
        const placement: ThreadPlacement = { threadId: thread.id, line, moved, outOfHunks };
        file.threads.push(placement);
    }));
    for (const file of result.files) {
        file.threads.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.threadId - b.threadId);
    }
    return result;
}

type SummaryFile = VersionSummary['files'][number];

/** Type of a version based on the files changed by the author. */
function kindOf(files: readonly SummaryFile[], version: CompareVersion): VersionKind {
    if (files.length > 0) {
        return files.every((f) => f.category === 'deps') ? 'deps' : 'code';
    }
    if (version.isRebase) {
        return 'rebase-only';
    }
    return version.messageChanged ? 'message-only' : 'none';
}

/**
 * What the author changed in a version, master noise removed: against the previous one, or the last
 * readable version if the intermediate ones are unavailable (`since`), or the base if there is none.
 */
export async function summarizeVersion(src: CompareSource, versions: readonly CompareVersion[], index: number): Promise<VersionSummary> {
    const version = versions[index - 1];
    if (!version) {
        throw new InvalidComparisonError(`Version inconnue : ${index}`);
    }
    if (!isReadable(version)) {
        return { index, kind: 'unavailable', added: 0, removed: 0, files: [], masterFiles: 0, conflicts: 0 };
    }
    const since = previousAvailable(versions, index);
    const sinceField = since === index - 1 ? {} : { since };
    if (since === 0) {
        const files = (await src.diffstat(version.hash, version.base)).map((e): SummaryFile => {
            const path = pathOf(e);
            return { path, added: e.added, removed: e.removed, category: categoryOf(path) };
        });
        return {
            index,
            kind: index === 1 ? 'creation' : kindOf(files, version),
            ...sinceField,
            added: files.reduce((sum, f) => sum + f.added, 0),
            removed: files.reduce((sum, f) => sum + f.removed, 0),
            files,
            masterFiles: 0,
            conflicts: 0,
        };
    }
    const result = await compareVersions(src, versions, since, index, { withHunks: false });
    const files = result.files.map(({ path, added, removed, category }): SummaryFile => ({ path, added, removed, category }));
    return {
        index,
        kind: kindOf(files, version),
        ...sinceField,
        added: result.stats.added,
        removed: result.stats.removed,
        files,
        masterFiles: result.masterOnly.length,
        conflicts: result.files.filter((f) => f.conflict).length,
    };
}
