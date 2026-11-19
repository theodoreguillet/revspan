// Lead-in of a hunk in a Vue or HTML file: the opening tag of the <script> or <style> block its first line is in.
// The page tokenizes each hunk alone: without that tag first, the grammar reads the block's code as template text
// (`const count = ref<number>(0);` in <script setup lang="ts"> gets no keyword color, `<number>` even becomes a tag).
// A Vue <template> gives none: shiki colors the directives of a template line read alone, not inside <template>.
import type { Hunk } from '../../shared/api.ts';
import { NO_EOL } from './diff.ts';

type Flavour = 'vue' | 'html';

/** A tag line longer than this gives no lead-in (minified page: it would weigh on every hunk). */
const MAX_LEAD_IN = 1000;

/** Vue: a block opens with its tag at the start of a line (a component like <script-panel> is not one). */
const VUE_OPENER = /^<(script|style)(?=[\s/>]|$)/;
/** HTML: anywhere in a line. */
const HTML_OPENER = /<(script|style)(?=[\s/>]|$)/gi;
/** The content of a script or style is raw text: it ends at its closing tag, wherever it is (as for Vue's parser). */
const CLOSERS: Record<string, RegExp> = {
    script: /<\/script(?=[\s/>]|$)/gi,
    style: /<\/style(?=[\s/>]|$)/gi,
};

/** Lines [from, to[ (0-based) inside a block whose opening tag line is `tag`. */
interface Block {
    from: number;
    to: number;
    tag: string;
}

function flavourOf(path: string): Flavour | null {
    const lower = path.toLowerCase();
    return lower.endsWith('.vue') ? 'vue' : lower.endsWith('.html') ? 'html' : null;
}

function clean(line: string): string {
    const text = line.endsWith(NO_EOL) ? line.slice(0, -NO_EOL.length) : line;
    return text.endsWith('\r') ? text.slice(0, -1) : text;
}

/** Next opening tag from `pos`: [kind, end of the match] or null. */
function nextOpener(text: string, pos: number, flavour: Flavour): [string, number] | null {
    if (flavour === 'vue') {
        const m = pos === 0 ? VUE_OPENER.exec(text) : null;
        return m ? [m[1]!, m[0].length] : null;
    }
    HTML_OPENER.lastIndex = pos;
    const m = HTML_OPENER.exec(text);
    return m ? [m[1]!.toLowerCase(), HTML_OPENER.lastIndex] : null;
}

/** End of the closing tag of `kind` from `pos`, -1 if the line has none. */
function closerEnd(text: string, pos: number, kind: string): number {
    const closer = CLOSERS[kind]!;
    closer.lastIndex = pos;
    return closer.exec(text) ? closer.lastIndex : -1;
}

/**
 * The script and style blocks of a file, in one pass. A block whose tag spans several lines (or is very long) is
 * followed to its end but kept out: its first line alone would leave the grammar inside the tag.
 */
function blocksOf(lines: readonly string[], flavour: Flavour): Block[] {
    const blocks: Block[] = [];
    let open: { kind: string; line: number; tag: string | null } | null = null;
    for (let k = 0; k < lines.length; k++) {
        const text = lines[k]!;
        let pos = 0;
        for (;;) {
            if (open) {
                const end = closerEnd(text, pos, open.kind);
                if (end < 0) {
                    break;
                }
                if (open.tag !== null && open.line < k) {
                    blocks.push({ from: open.line + 1, to: k + 1, tag: open.tag });
                }
                open = null;
                pos = end;
                continue;
            }
            const opener = nextOpener(text, pos, flavour);
            if (!opener) {
                break;
            }
            const [kind, end] = opener;
            const tag = clean(text);
            open = { kind, line: k, tag: tag.includes('>', end) && tag.length <= MAX_LEAD_IN ? tag : null };
            pos = end;
        }
    }
    if (open && open.tag !== null && open.line + 1 < lines.length) {
        blocks.push({ from: open.line + 1, to: lines.length, tag: open.tag });
    }
    return blocks;
}

/** Tag of the block holding 0-based line `index` (blocks sorted, not overlapping), null outside. */
function tagAt(blocks: readonly Block[], index: number): string | null {
    let lo = 0;
    let hi = blocks.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const block = blocks[mid]!;
        if (index < block.from) {
            hi = mid - 1;
        } else if (index >= block.to) {
            lo = mid + 1;
        } else {
            return block.tag;
        }
    }
    return null;
}

/**
 * Vue or HTML file: the opening tag line of the <script> or <style> block holding 1-based `firstLine`, as written
 * (its `lang` tells the grammar), its closing line included. null: another kind of file, outside a block, on the tag
 * line itself, or a tag over several lines.
 */
export function leadInFor(lines: readonly string[], firstLine: number, path: string): string | null {
    const flavour = flavourOf(path);
    return flavour ? tagAt(blocksOf(lines.slice(0, Math.max(0, firstLine)), flavour), firstLine - 1) : null;
}

/**
 * The hunks of a Vue or HTML file with their lead-ins (one pass over each side's lines); the key is left out when
 * neither side has one. `path`: the file as the page shows it (its grammar colors both sides).
 */
export function withLeadIns(hunks: Hunk[], oldLines: readonly string[], newLines: readonly string[], path: string): Hunk[] {
    const flavour = flavourOf(path);
    if (!flavour || !hunks.length) {
        return hunks;
    }
    let oldBlocks: Block[] | null = null;
    let newBlocks: Block[] | null = null;
    return hunks.map((hunk) => {
        const leadIn: NonNullable<Hunk['leadIn']> = {};
        if (hunk.oldLines > 0) {
            oldBlocks ??= blocksOf(oldLines, flavour);
            const tag = tagAt(oldBlocks, hunk.oldStart - 1);
            if (tag !== null) {
                leadIn.old = tag;
            }
        }
        if (hunk.newLines > 0) {
            newBlocks ??= blocksOf(newLines, flavour);
            const tag = tagAt(newBlocks, hunk.newStart - 1);
            if (tag !== null) {
                leadIn.new = tag;
            }
        }
        return leadIn.old === undefined && leadIn.new === undefined ? hunk : { ...hunk, leadIn };
    });
}
