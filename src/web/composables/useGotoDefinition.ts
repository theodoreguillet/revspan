// Go to definition in the diff: Ctrl+click (⌘+click on macOS) on a name looks for its definition among the displayed
// lines (lib/goto-definition.ts), then moves there like the search does (file expanded, line scrolled under the sticky
// bars, flashed). Several definitions: a choice under the click. None: the import of the name in the same file, with
// "Search <file> (whole file)" when it points to a file of the PR. Back: Alt+← or the chip shown after a jump.
// Nothing runs on mouse moves: the underline is CSS (the `armed` class while the modifier is held, :hover on a token).
import { computed, nextTick, onScopeDispose, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import type { FileDiff } from '../../shared/api.ts';
import { familyOf, findDefinitions, findLine, gotoDefinition, identifierAt, lineNumber, type LineRef } from '../lib/goto-definition.ts';
import { isGotoClick, isMacPlatform } from '../lib/keyboard.ts';
import type { useDiffNav } from './useDiffNav.ts';

/** How long the notice (back chip, not found, import) stays, unless the pointer rests on it. */
export const NOTICE_MS = 5000;
/** Places kept for back. */
const MAX_BACK = 50;

/** Line to reach: its block renders it and registers it to the navigation (seq: one per jump). */
export interface JumpTarget {
    path: string;
    hunk: number;
    index: number;
    side: 'old' | 'new';
    seq: number;
}

/** A place to come back to: a displayed line and where it was in the window (top: px from the top, if known). */
export interface BackEntry {
    path: string;
    side: 'old' | 'new';
    number: number;
    top?: number;
    scrollY: number;
}

/** Several definitions: the list shown under the click (anchor: the clicked row, in window coordinates). */
export interface GotoChoice {
    name: string;
    targets: LineRef[];
    x: number;
    top: number;
    bottom: number;
    origin: BackEntry | null;
    /** Clicked row: focus goes back to it when the choice is closed by Escape. */
    row: HTMLElement | null;
}

/** "Search <file> (whole file)": looks for `name` in `file` with "whole file" on. */
export interface GotoOffer {
    name: string;
    file: string;
    /** File holding the import (where the search comes from). */
    from: string;
    origin: BackEntry | null;
}

/** Notice at the bottom of the window. */
export interface GotoNotice {
    /**
     * notFound: no definition of `name` shown (searched in `file` only, after "Search <file>"); atImport: its
     * import reached instead; notShown: the import clicked, the definition is elsewhere; null: the back chip alone.
     */
    message: 'notFound' | 'atImport' | 'notShown' | null;
    name: string;
    file: string | null;
    /** Suggest "whole file" (it is off). */
    hint: boolean;
    offer: GotoOffer | null;
    back: boolean;
}

/** The name clicked: its line and where that line was. */
export interface GotoClick {
    name: string;
    ref: LineRef;
    origin: BackEntry;
    /** Clicked row (window coordinates), to place the choice under it. */
    x: number;
    top: number;
    bottom: number;
    row?: HTMLElement;
}

export interface GotoHooks {
    /** Shows a file expanded and current (no scroll: the line is scrolled to). */
    showFile: (fileIdx: number) => Promise<void>;
    nav: Pick<ReturnType<typeof useDiffNav>, 'clearJump' | 'revealJump'>;
    fullContext: Readonly<Ref<boolean>>;
    /** Turns "whole file" on; resolves once the comparison with it is shown. */
    loadWholeFile: () => Promise<void>;
}

type CaretDocument = Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** Text node and offset under a point of the window. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
    const doc = document as CaretDocument;
    if (doc.caretPositionFromPoint) {
        const pos = doc.caretPositionFromPoint(x, y);
        return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
    }
    const range = doc.caretRangeFromPoint?.(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** Range of the characters [start, end[ of an element's text. */
function charRange(root: Node, start: number, end: number): Range | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let pos = 0;
    let started = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (!started && start < pos + length) {
            range.setStart(node, start - pos);
            started = true;
        }
        if (started && end <= pos + length) {
            range.setEnd(node, end - pos);
            return range;
        }
        pos += length;
    }
    return null;
}

/** A diff line takes the focus (left by the closed choice) without scrolling. */
function focusLine(el: HTMLElement | null | undefined): void {
    if (el?.isConnected) {
        el.tabIndex = -1;
        el.focus({ preventScroll: true });
    }
}

const contains = (rects: Iterable<DOMRect>, x: number, y: number): boolean =>
    [...rects].some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1);

export function useGotoDefinition(files: ComputedRef<FileDiff[]>, hooks: GotoHooks) {
    const mac = typeof navigator !== 'undefined' && isMacPlatform(navigator.platform);
    const modifierKey = mac ? 'Meta' : 'Control';
    /** The modifier is held: identifiers underline on hover. */
    const armed = ref(false);
    const target = shallowRef<JumpTarget | null>(null);
    const choice = shallowRef<GotoChoice | null>(null);
    const notice = shallowRef<GotoNotice | null>(null);
    const backStack = shallowRef<readonly BackEntry[]>([]);
    const canGoBack = computed(() => backStack.value.length > 0);
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // another comparison (range, context, refresh): the hunk of the jump target and the lines offered are not its own
    watch(files, () => {
        target.value = null;
        closeChoice();
    });

    // the modifier alone, on the whole window: a class on the diff, nothing per mouse move
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === modifierKey) {
            armed.value = true;
        }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
        if (event.key === modifierKey) {
            armed.value = false;
        }
    };
    const disarm = (): void => {
        armed.value = false;
    };
    if (typeof window !== 'undefined') {
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', disarm);
    }
    onScopeDispose(() => {
        clearTimeout(timer);
        if (typeof window !== 'undefined') {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            window.removeEventListener('blur', disarm);
        }
    });

    function showNotice(next: GotoNotice): void {
        notice.value = next;
        holdNotice(false);
    }

    /** The pointer rests on the notice: it stays until the pointer leaves. */
    function holdNotice(hold: boolean): void {
        clearTimeout(timer);
        if (!hold && notice.value) {
            timer = setTimeout(() => {
                notice.value = null;
            }, NOTICE_MS);
        }
    }

    /** Closes the choice (focus back on the clicked line if asked: Escape); false if it was not open. */
    function closeChoice(focusBack = false): boolean {
        const open = choice.value;
        choice.value = null;
        if (focusBack) {
            focusLine(open?.row);
        }
        return !!open;
    }

    /** Closes the choice and the notice; false if neither was open. */
    function dismiss(): boolean {
        const open = closeChoice() || !!notice.value;
        clearTimeout(timer);
        notice.value = null;
        return open;
    }

    function remember(origin: BackEntry | null): void {
        if (origin) {
            backStack.value = [...backStack.value.slice(1 - MAX_BACK), origin];
        }
    }

    /**
     * Shows `ref`: its file expanded, its block rendered, the line scrolled under the bars (or at `top`) and flashed.
     * Returns the line's element (null if it did not render).
     */
    async function navigate(ref: LineRef, top?: number): Promise<HTMLElement | null> {
        hooks.nav.clearJump();
        target.value = { path: ref.path, hunk: ref.hunk, index: ref.index, side: ref.side, seq: ++seq };
        await hooks.showFile(ref.fileIdx);
        return hooks.nav.revealJump(top);
    }

    async function jump(ref: LineRef, origin: BackEntry | null): Promise<HTMLElement | null> {
        closeChoice();
        remember(origin);
        const el = await navigate(ref);
        showNotice({ message: null, name: '', file: null, hint: false, offer: null, back: canGoBack.value });
        return el;
    }

    const notFound = (name: string, file: string | null = null): GotoNotice =>
        ({ message: 'notFound', name, file, hint: !hooks.fullContext.value, offer: null, back: false });

    /** A name clicked: its definition, the choice, its import or "not found". */
    async function follow(click: GotoClick): Promise<void> {
        closeChoice();
        const { name, ref, origin } = click;
        const result = gotoDefinition(files.value, name, { fileIdx: ref.fileIdx, line: ref.line });
        switch (result.kind) {
            case 'none':
                return;
            case 'jump':
                await jump(result.target, origin);
                return;
            case 'choose':
                choice.value = { name, targets: result.targets, x: click.x, top: click.top, bottom: click.bottom, origin, row: click.row ?? null };
                return;
            case 'import': {
                const offer = result.file && !hooks.fullContext.value
                    ? { name, file: result.file, from: ref.path, origin: result.here ? origin : null }
                    : null;
                if (result.here && !offer) {
                    showNotice(notFound(name));
                    return;
                }
                if (!result.here) {
                    remember(origin);
                    await navigate(result.target);
                    if (offer) {
                        // back from the definition found in that file: to the import line just reached
                        offer.origin = { path: result.target.path, side: result.target.side, number: lineNumber(result.target), scrollY: window.scrollY };
                    }
                }
                showNotice({ message: result.here ? 'notShown' : 'atImport', name, file: null, hint: false, offer, back: !result.here });
                return;
            }
            case 'notFound':
                showNotice(notFound(name));
        }
    }

    /** "Search <file> (whole file)": "whole file" on, then the definitions of the name in that file. */
    async function openOffer(anchor?: DOMRect): Promise<void> {
        const offer = notice.value?.offer;
        if (!offer) {
            return;
        }
        dismiss();
        await hooks.loadWholeFile();
        // the watchers of the new comparison run first (they drop the previous jump target)
        await nextTick();
        const from = files.value.findIndex((f) => f.path === offer.from);
        const defs = from < 0 ? [] : findDefinitions(files.value, offer.name, from, offer.file);
        if (defs.length === 1) {
            await jump(defs[0]!, offer.origin);
        } else if (defs.length > 1) {
            const box = anchor ?? new DOMRect(window.innerWidth / 2, window.innerHeight - 60, 0, 30);
            choice.value = { name: offer.name, targets: defs, x: box.left, top: box.top, bottom: box.bottom, origin: offer.origin, row: null };
        } else {
            showNotice(notFound(offer.name, offer.file));
        }
    }

    /** A definition picked in the choice: the focus, inside the choice, moves to the line reached. */
    async function choose(ref: LineRef): Promise<void> {
        const origin = choice.value?.origin ?? null;
        focusLine(await jump(ref, origin));
    }

    /** Back to the place before the last jump (Alt+←, the chip): its line at the same height, else the scroll position. */
    async function back(): Promise<boolean> {
        const entry = backStack.value.at(-1);
        if (!entry) {
            return false;
        }
        backStack.value = backStack.value.slice(0, -1);
        dismiss();
        const ref = findLine(files.value, entry.path, entry.side, entry.number);
        if (ref) {
            await navigate(ref, entry.top);
        } else {
            window.scrollTo({ top: entry.scrollY });
        }
        return true;
    }

    /** The name under a Ctrl/⌘+click in the code of a diff line, or null (plain click, selection, not a name). */
    function clickedName(event: MouseEvent): GotoClick | null {
        if (!isGotoClick(event, mac)) {
            return null;
        }
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) {
            return null;
        }
        const caret = caretAt(event.clientX, event.clientY);
        const host = caret && (caret.node.nodeType === Node.TEXT_NODE ? caret.node.parentElement : caret.node as Element);
        const code = host?.closest<HTMLElement>('.c');
        // strings, comments, keywords (syntax colors) and the "no final newline" mark are not names
        if (!caret || !host || !code || host.closest('.nosym, .rv-noeol')) {
            return null;
        }
        const row = code.closest<HTMLElement>('.rv-l, .half');
        const path = row?.closest<HTMLElement>('.rv-file')?.dataset.path;
        const family = path === undefined ? null : familyOf(path);
        if (!row || path === undefined || !family) {
            return null;
        }
        const side = row.dataset.n ? 'new' : 'old';
        const ref = findLine(files.value, path, side, Number(side === 'new' ? row.dataset.n : row.dataset.o));
        if (!ref) {
            return null;
        }
        const before = document.createRange();
        before.setStart(code, 0);
        before.setEnd(caret.node, caret.offset);
        const word = identifierAt(ref.line.text, before.toString().length, family);
        // the caret is the closest one: the pointer must be on the name itself (not in the blank after the line)
        const range = word && charRange(code, word.start, word.end);
        if (!word || !range || !contains(range.getClientRects(), event.clientX, event.clientY)) {
            return null;
        }
        const box = row.getBoundingClientRect();
        return {
            name: word.name, ref, x: event.clientX, top: box.top, bottom: box.bottom, row,
            origin: { path, side, number: lineNumber(ref), top: box.top, scrollY: window.scrollY },
        };
    }

    /** Click in the diff (delegated): Ctrl/⌘+click on a name only, a plain click keeps its behavior. */
    function onClick(event: MouseEvent): void {
        const click = clickedName(event);
        if (click) {
            event.preventDefault();
            void follow(click);
        }
    }

    /** A new range: its lines are not those of the places kept. */
    function reset(): void {
        dismiss();
        backStack.value = [];
        target.value = null;
    }

    return {
        armed, target, choice, notice, canGoBack,
        onClick, follow, choose, openOffer, back, dismiss, closeChoice, holdNotice, reset,
    };
}

export type GotoDefinition = ReturnType<typeof useGotoDefinition>;
