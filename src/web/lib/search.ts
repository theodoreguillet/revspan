// Search rules: file names and the lines of the comparison as displayed (case-insensitive substring, no regex).
import type { FileDiff } from '../../shared/api.ts';

/** Shorter queries search nothing (too many hits to be useful). */
export const MIN_QUERY = 2;

/** A match in a displayed line: [start, end[ in the text of `files[fileIdx].hunks[hunk].lines[line]`. */
export interface SearchHit {
    fileIdx: number;
    path: string;
    hunk: number;
    /** Index in hunk.lines. */
    line: number;
    start: number;
    end: number;
}

const NO_MARKS: readonly [number, number][] = Object.freeze([]) as readonly [number, number][];

/** The same empty list for every file or hunk without a match: what shows it does not render again. */
export const NO_HITS: readonly SearchHit[] = Object.freeze([]);

/** The path contains the query, ignoring case (a folder name matches its files). */
export function fileNameMatches(path: string, query: string): boolean {
    return path.toLowerCase().includes(query.toLowerCase());
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matches in the lines of every file, ordered by file, hunk, line, start; the matches of one line do not overlap.
 * Linear in the size of the diff. The query is escaped: the "i" flag keeps the indices of the original text, where
 * toLowerCase() may change the length of some characters.
 */
export function findHits(files: readonly FileDiff[], query: string): SearchHit[] {
    if (query.length < MIN_QUERY) {
        return [];
    }
    const re = new RegExp(escapeRegExp(query), 'gi');
    const hits: SearchHit[] = [];
    files.forEach((file, fileIdx) => {
        file.hunks.forEach((hunk, hunkIdx) => {
            hunk.lines.forEach((line, lineIdx) => {
                re.lastIndex = 0;
                for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
                    hits.push({ fileIdx, path: file.path, hunk: hunkIdx, line: lineIdx, start: m.index, end: m.index + m[0].length });
                }
            });
        });
    });
    return hits;
}

/** A name cut around its first match (before, match, after); null without a match or under 2 characters. */
export function splitMatch(name: string, query: string): [string, string, string] | null {
    if (query.length < MIN_QUERY) {
        return null;
    }
    const m = new RegExp(escapeRegExp(query), 'i').exec(name);
    return m ? [name.slice(0, m.index), m[0], name.slice(m.index + m[0].length)] : null;
}

/** Hits of one file grouped by hunk (index in file.hunks), in order. */
export function hitsByHunk(hits: readonly SearchHit[]): Map<number, SearchHit[]> {
    const out = new Map<number, SearchHit[]>();
    for (const hit of hits) {
        const list = out.get(hit.hunk);
        if (list) {
            list.push(hit);
        } else {
            out.set(hit.hunk, [hit]);
        }
    }
    return out;
}

/** Order of a hit's line against (fileIdx, hunk, line). */
function compareLine(h: SearchHit, fileIdx: number, hunk: number, line: number): number {
    return h.fileIdx - fileIdx || h.hunk - hunk || h.line - line;
}

/** Ranges of the hits of one line (binary search in the ordered hits; the same empty array when none). */
export function lineMarks(hits: readonly SearchHit[], fileIdx: number, hunk: number, line: number): [number, number][] {
    let lo = 0;
    let hi = hits.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (compareLine(hits[mid]!, fileIdx, hunk, line) < 0) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    const out: [number, number][] = [];
    for (let k = lo; k < hits.length && compareLine(hits[k]!, fileIdx, hunk, line) === 0; k++) {
        out.push([hits[k]!.start, hits[k]!.end]);
    }
    return out.length ? out : (NO_MARKS as [number, number][]);
}

/** Index of the next (1) or previous (-1) hit, wrapping around; from -1 (none yet), the first or the last. */
export function stepHit(current: number, total: number, dir: 1 | -1): number {
    if (!total) {
        return -1;
    }
    if (current < 0) {
        return dir > 0 ? 0 : total - 1;
    }
    return (current + dir + total) % total;
}
