// Relocating a line from one version of a file to another.
import { diffLines, type DiffOp } from './diff.ts';

export interface MappedLine {
    /** 1-based number in the new text (null if the file is empty). */
    line: number | null;
    /** The original line was modified or deleted; line then points to the closest position. */
    changed: boolean;
}

const clamp = (line: number, max: number): number => Math.max(1, Math.min(line, max));

/** line: 1-based number in oldLines. */
export function mapLine(oldLines: readonly string[], newLines: readonly string[], line: number): MappedLine {
    return mapLines(oldLines, newLines, [line])[0] ?? { line: null, changed: true };
}

/** Several lines of oldLines at once (a range's start and end): the two texts are compared once. */
export function mapLines(oldLines: readonly string[], newLines: readonly string[], lines: readonly number[]): MappedLine[] {
    let ops: DiffOp[] | null = null;
    return lines.map((line) => {
        if (newLines.length === 0) {
            return { line: null, changed: true };
        }
        const index = line - 1;
        if (index < 0 || index >= oldLines.length) {
            return { line: clamp(line, newLines.length), changed: true };
        }
        ops ??= diffLines(oldLines, newLines);
        return mapIndex(ops, index, line, newLines.length);
    });
}

function mapIndex(ops: readonly DiffOp[], index: number, line: number, newCount: number): MappedLine {
    for (const [i, op] of ops.entries()) {
        if (index < op.a || index >= op.a + op.len) {
            continue;
        }
        if (op.op === '=') {
            return { line: op.b + (index - op.a) + 1, changed: false };
        }
        if (op.op === '-') {
            const next = ops[i + 1];
            if (next?.op === '+') {
                return { line: next.b + Math.min(index - op.a, next.len - 1) + 1, changed: true };
            }
            return { line: clamp(op.b + 1, newCount), changed: true };
        }
    }
    return { line: clamp(line, newCount), changed: true };
}
