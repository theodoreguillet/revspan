// Fusion 3 voies ligne à ligne.
// merge3(base, ours, theirs) applique sur `base` les changements de `ours` ET de `theirs`.
// Une zone modifiée des deux côtés de façon différente est un conflit : on garde la version `theirs`.
// Usage : rejouer une ancienne version de PR (theirs) sur la nouvelle base master (ours).
import { diffLines, type DiffOp } from './diff.ts';

interface Chunk {
    /** Plage [start, end[ remplacée dans `base`. */
    start: number;
    end: number;
    lines: string[];
    side: 'ours' | 'theirs';
}

interface Group {
    start: number;
    end: number;
    chunks: Chunk[];
}

export interface MergeResult {
    lines: string[];
    conflicts: number;
}

/** Regroupe les segments non '=' consécutifs en blocs exprimés en coordonnées de `base`. */
export function changeChunks(ops: readonly DiffOp[], otherLines: readonly string[], side: Chunk['side']): Chunk[] {
    const chunks: Chunk[] = [];
    let current: Chunk | null = null;
    for (const op of ops) {
        if (op.op === '=') {
            current = null;
            continue;
        }
        if (!current) {
            current = { start: op.a, end: op.a, lines: [], side };
            chunks.push(current);
        }
        if (op.op === '-') {
            current.end = op.a + op.len;
        } else {
            for (let i = 0; i < op.len; i++) {
                current.lines.push(otherLines[op.b + i]!);
            }
        }
    }
    return chunks;
}

function overlaps(chunk: Chunk, group: Group): boolean {
    const chunkEmpty = chunk.start === chunk.end;
    const groupEmpty = group.start === group.end;
    if (!chunkEmpty && !groupEmpty) {
        return chunk.start < group.end && group.start < chunk.end;
    }
    if (chunkEmpty && groupEmpty) {
        return chunk.start === group.start;
    }
    if (chunkEmpty) {
        return chunk.start > group.start && chunk.start < group.end;
    }
    return group.start > chunk.start && group.start < chunk.end;
}

// push(...grand tableau) dépasse la pile au-delà de ~100 000 éléments : copie en boucle.
function append(out: string[], items: readonly string[]): void {
    for (const item of items) {
        out.push(item);
    }
}

function sideVersion(base: readonly string[], start: number, end: number, chunks: readonly Chunk[]): string[] {
    const out: string[] = [];
    let pos = start;
    for (const chunk of chunks) {
        for (; pos < chunk.start; pos++) {
            out.push(base[pos]!);
        }
        append(out, chunk.lines);
        pos = chunk.end;
    }
    for (; pos < end; pos++) {
        out.push(base[pos]!);
    }
    return out;
}

export function sameLines(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((line, i) => line === b[i]);
}

export function merge3(base: readonly string[], ours: readonly string[], theirs: readonly string[]): MergeResult {
    const all = [
        ...changeChunks(diffLines(base, ours), ours, 'ours'),
        ...changeChunks(diffLines(base, theirs), theirs, 'theirs'),
    ].sort((x, y) => x.start - y.start || x.end - y.end);

    const groups: Group[] = [];
    for (const chunk of all) {
        const group = groups[groups.length - 1];
        if (group && overlaps(chunk, group)) {
            group.start = Math.min(group.start, chunk.start);
            group.end = Math.max(group.end, chunk.end);
            group.chunks.push(chunk);
        } else {
            groups.push({ start: chunk.start, end: chunk.end, chunks: [chunk] });
        }
    }

    const lines: string[] = [];
    let conflicts = 0;
    let pos = 0;
    for (const group of groups) {
        for (; pos < group.start; pos++) {
            lines.push(base[pos]!);
        }
        const oursPart = group.chunks.filter((c) => c.side === 'ours');
        const theirsPart = group.chunks.filter((c) => c.side === 'theirs');
        if (theirsPart.length === 0) {
            append(lines, sideVersion(base, group.start, group.end, oursPart));
        } else if (oursPart.length === 0) {
            append(lines, sideVersion(base, group.start, group.end, theirsPart));
        } else {
            const oursVersion = sideVersion(base, group.start, group.end, oursPart);
            const theirsVersion = sideVersion(base, group.start, group.end, theirsPart);
            if (!sameLines(oursVersion, theirsVersion)) {
                conflicts++;
            }
            append(lines, theirsVersion);
        }
        pos = group.end;
    }
    for (; pos < base.length; pos++) {
        lines.push(base[pos]!);
    }
    return { lines, conflicts };
}
