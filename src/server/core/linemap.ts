// Relocalisation d'une ligne d'une version d'un fichier vers une autre.
import { diffLines } from './diff.ts';

export interface MappedLine {
    /** Numéro 1-based dans le nouveau texte (null si le fichier est vide). */
    line: number | null;
    /** La ligne d'origine a été modifiée ou supprimée ; line pointe alors sur la position la plus proche. */
    changed: boolean;
}

const clamp = (line: number, max: number): number => Math.max(1, Math.min(line, max));

/** line : numéro 1-based dans oldLines. */
export function mapLine(oldLines: readonly string[], newLines: readonly string[], line: number): MappedLine {
    if (newLines.length === 0) {
        return { line: null, changed: true };
    }
    const index = line - 1;
    if (index < 0 || index >= oldLines.length) {
        return { line: clamp(line, newLines.length), changed: true };
    }
    const ops = diffLines(oldLines, newLines);
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
            return { line: clamp(op.b + 1, newLines.length), changed: true };
        }
    }
    return { line: clamp(line, newLines.length), changed: true };
}
