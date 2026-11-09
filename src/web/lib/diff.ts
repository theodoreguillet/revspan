// Règles du diff : fichiers vus, paires côte à côte, placement des fils, commentaires sur ligne supprimée.
import type { DiffLine, FileDiff, Hunk, Thread, ThreadPlacement } from '../../shared/api.ts';
import type { MessageKey, Translator } from '../i18n/index.ts';
import { MINUS, vname } from './format.ts';
import type { SummaryMap } from './kinds.ts';

export type ViewedStatus = 'none' | 'seen' | 'changed';

/** none : jamais vu ; seen : vu avec ce contenu ; changed : vu, mais le contenu a changé depuis. */
export function viewedStatus(file: Pick<FileDiff, 'path' | 'contentHash'>, viewed: Record<string, string> | undefined): ViewedStatus {
    const stored = viewed?.[file.path];
    if (stored == null) {
        return 'none';
    }
    return stored === file.contentHash ? 'seen' : 'changed';
}

/** Dernière version de la plage (from, to] qui a modifié ce fichier, d'après le résumé. */
export function lastTouched(sums: SummaryMap, from: number, to: number, path: string): number | null {
    for (let i = to; i >= from + 1; i--) {
        if (sums.get(i)?.files.some((f) => f.path === path)) {
            return i;
        }
    }
    return null;
}

export interface SplitRow {
    left: DiffLine | null;
    right: DiffLine | null;
}

/** Paires gauche/droite d'un hunk : les suites - puis + sont alignées ligne à ligne. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
    const rows: SplitRow[] = [];
    let dels: DiffLine[] = [];
    let adds: DiffLine[] = [];
    const flush = (): void => {
        const count = Math.max(dels.length, adds.length);
        for (let k = 0; k < count; k++) {
            rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
        }
        dels = [];
        adds = [];
    };
    for (const line of lines) {
        if (line.t === ' ') {
            flush();
            rows.push({ left: line, right: line });
        } else if (line.t === '-') {
            if (adds.length) {
                flush();
            }
            dels.push(line);
        } else {
            adds.push(line);
        }
    }
    flush();
    return rows;
}

export function hunkRange(h: Pick<Hunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>): string {
    return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

export function lineSign(t: DiffLine['t']): string {
    if (t === '+') {
        return '+';
    }
    return t === '-' ? MINUS : '';
}

export interface TextPart {
    text: string;
    hl: boolean;
}

/** Découpe le texte d'une ligne selon les plages [début, fin[ à surligner. */
export function highlightParts(text: string, ranges: [number, number][] | undefined): TextPart[] {
    if (!ranges?.length) {
        return [{ text, hl: false }];
    }
    const out: TextPart[] = [];
    let pos = 0;
    for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
        const s = Math.max(pos, Math.min(start, text.length));
        const e = Math.max(s, Math.min(end, text.length));
        if (s > pos) {
            out.push({ text: text.slice(pos, s), hl: false });
        }
        if (e > s) {
            out.push({ text: text.slice(s, e), hl: true });
        }
        pos = e;
    }
    if (pos < text.length) {
        out.push({ text: text.slice(pos), hl: false });
    }
    return out;
}

export interface PlacedThread {
    placement: ThreadPlacement;
    thread: Thread;
}

export interface FileThreads {
    /** Fils sans ligne affichée : niveau fichier, ligne hors des hunks. */
    fileLevel: PlacedThread[];
    /** Fils en ligne, par numéro de ligne côté « to ». */
    byLine: Map<number, PlacedThread[]>;
}

/** Répartit les fils d'un fichier entre la tête du fichier et les lignes affichées. Les fils résolus sont omis sauf demande. */
export function placeFileThreads(file: FileDiff, threadsById: Map<number, Thread>, showResolved: boolean): FileThreads {
    const lineSet = new Set<number>();
    for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
            if (line.n != null && line.t !== '-') {
                lineSet.add(line.n);
            }
        }
    }
    const fileLevel: PlacedThread[] = [];
    const byLine = new Map<number, PlacedThread[]>();
    for (const placement of file.threads) {
        const thread = threadsById.get(placement.threadId);
        if (!thread || (thread.resolved && !showResolved)) {
            continue;
        }
        if (placement.line == null || !lineSet.has(placement.line)) {
            fileLevel.push({ placement, thread });
        } else {
            const list = byLine.get(placement.line) ?? [];
            list.push({ placement, thread });
            byLine.set(placement.line, list);
        }
    }
    return { fileLevel, byLine };
}

/** Nombre de fils d'un fichier (ouverts seulement, sauf si les résolus sont affichés). */
export function fileThreadCount(file: FileDiff, threadsById: Map<number, Thread>, includeResolved: boolean): number {
    return file.threads.filter((p) => {
        const t = threadsById.get(p.threadId);
        return !!t && (!t.resolved || includeResolved);
    }).length;
}

export type ComposerKind = 'new' | 'old';

export interface ComposerTarget {
    key: string;
    path: string;
    kind: ComposerKind;
    /** Numéro de ligne côté nouveau (new) ou ancien (old). */
    line: number;
    code: string;
}

/**
 * Cible du « + » sur une ligne : côté nouveau, commentaire en ligne ; sur une ligne supprimée, commentaire général
 * qui la cite. `side` : colonne de la vue côte à côte, ou 'both' en vue unifiée.
 */
export function composerTargetFor(path: string, line: DiffLine, side: 'old' | 'new' | 'both'): ComposerTarget | null {
    if (side !== 'old' && line.t !== '-' && line.n != null) {
        return { key: composerKey('new', line.n, path), path, kind: 'new', line: line.n, code: line.text };
    }
    if (side !== 'new' && line.t === '-' && line.o != null) {
        return { key: composerKey('old', line.o, path), path, kind: 'old', line: line.o, code: line.text };
    }
    return null;
}

const sameTarget = (a: ComposerTarget | null, b: ComposerTarget | null): boolean => !!a && !!b && a.key === b.key;

export interface LineView {
    line: DiffLine;
    /** Cible du bouton « + » (null : pas de commentaire possible sur cette ligne). */
    target: ComposerTarget | null;
    /** Composeur ouvert sous cette ligne. */
    composer: ComposerTarget | null;
    threads: PlacedThread[];
}

export interface SplitCellView {
    side: 'old' | 'new';
    line: DiffLine | null;
    target: ComposerTarget | null;
}

export interface SplitRowView {
    cells: [SplitCellView, SplitCellView];
    /** Composeur ouvert sous la ligne supprimée (gauche) ou sous la ligne côté nouveau (droite). */
    leftComposer: ComposerTarget | null;
    rightComposer: ComposerTarget | null;
    threads: PlacedThread[];
}

export interface HunkViewInput {
    path: string;
    lines: DiffLine[];
    byLine: Map<number, PlacedThread[]>;
    canComment: boolean;
    composer: ComposerTarget | null;
}

const threadsAt = (byLine: Map<number, PlacedThread[]>, line: DiffLine | null): PlacedThread[] =>
    (line && line.t !== '-' && line.n != null ? byLine.get(line.n) ?? [] : []);

/** Lignes d'un hunk en vue unifiée, avec fils et composeur à insérer dessous. */
export function unifiedRows({ path, lines, byLine, canComment, composer }: HunkViewInput): LineView[] {
    return lines.map((line) => {
        const target = canComment ? composerTargetFor(path, line, 'both') : null;
        return { line, target, composer: sameTarget(target, composer) ? composer : null, threads: threadsAt(byLine, line) };
    });
}

/** Lignes d'un hunk en vue côte à côte (ancien à gauche, nouveau à droite). */
export function sideBySideRows({ path, lines, byLine, canComment, composer }: HunkViewInput): SplitRowView[] {
    const cell = (side: 'old' | 'new', line: DiffLine | null): SplitCellView =>
        ({ side, line, target: line && canComment ? composerTargetFor(path, line, side) : null });
    return splitRows(lines).map(({ left, right }) => {
        const cells: [SplitCellView, SplitCellView] = [cell('old', left), cell('new', right)];
        return {
            cells,
            leftComposer: sameTarget(cells[0].target, composer) ? composer : null,
            rightComposer: sameTarget(cells[1].target, composer) ? composer : null,
            threads: threadsAt(byLine, right),
        };
    });
}

export function composerKey(kind: ComposerKind, line: number, path: string): string {
    return `${kind === 'old' ? 'o' : 'n'}${line}:${path}`;
}

/** Commentaire général citant une ligne supprimée (Bitbucket ne permet pas d'ancrer côté ancien). */
export function deletedLineComment(tr: Translator, path: string, from: number, to: number, code: string, text: string): string {
    const fence = code.includes('```') ? '~~~' : '```';
    const quote = tr.t('diff.deletedLineQuote', { path: `\`${path}\``, from: vname(from), to: vname(to) });
    return `${quote}\n${fence}\n${code}\n${fence}\n${text}`;
}

/** Première ligne ajoutée (côté nouveau) du fichier, pour l'ouvrir au bon endroit ; null s'il n'y en a pas. */
export function firstChangedLine(file: Pick<FileDiff, 'hunks'>): number | null {
    for (const hunk of file.hunks) {
        const added = hunk.lines.find((line) => line.t === '+' && line.n != null);
        if (added?.n != null) {
            return added.n;
        }
    }
    return null;
}

export const FILE_STATUS_TAGS: Partial<Record<FileDiff['status'], 'file.status.added' | 'file.status.removed' | 'file.status.renamed'>> = {
    added: 'file.status.added',
    removed: 'file.status.removed',
    renamed: 'file.status.renamed',
} satisfies Partial<Record<FileDiff['status'], MessageKey>>;
