// PR page state, shared through provide/inject: assembles the specialized composables
// (data, range, display options, navigation, comments, review) and wires them together.
import { computed, inject, nextTick, onScopeDispose, provide, reactive, watch, type InjectionKey } from 'vue';
import type { PrDetail, PrRef, ThreadPlacement } from '../../shared/api.ts';
import { viewedStatus } from '../lib/diff.ts';
import { PREFETCH_CONTEXT } from '../lib/prefetch.ts';
import { commentThreadId } from '../lib/tasks.ts';
import { useDiffNav } from './useDiffNav.ts';
import { useDiffOptions } from './useDiffOptions.ts';
import { useDiffSearch } from './useDiffSearch.ts';
import { useDiscussion } from './useDiscussion.ts';
import { useGotoDefinition } from './useGotoDefinition.ts';
import { usePrLoad } from './usePrLoad.ts';
import { useRangeSelection } from './useRangeSelection.ts';
import { ALT_LEFT_BACK } from './useShortcuts.ts';
import { useReviewActions } from './useReviewActions.ts';
import { useTasks } from './useTasks.ts';

const FULL_CONTEXT = 100000;

function createPrPage(prRef: PrRef, initial: PrDetail) {
    const load = usePrLoad(prRef, initial);
    const range = useRangeSelection(prRef, load.detail);
    const options = useDiffOptions(load.detail);
    const nav = useDiffNav();
    const discussion = useDiscussion(prRef, load);
    const review = useReviewActions(prRef, load, options, nav.keepFileInView);
    const tasks = useTasks(prRef, load);

    const threadsById = computed(() => new Map(load.detail.value.threads.map((t) => [t.id, t])));
    const canInlineComment = computed(() => load.compare.value?.to === range.n.value && load.detail.value.pr.state === 'OPEN');
    const files = computed(() => load.compare.value?.files ?? []);

    const context = (): number => (options.fullContext.value ? FULL_CONTEXT : PREFETCH_CONTEXT);
    const compareParams = () => ({ from: range.from.value, to: range.to.value, context: context() });

    void load.loadSummary();
    void load.loadCompare(compareParams());
    // presets computed in the background with the current context, so that a click on one shows it at once
    load.startPrefetch(() => ({ presets: range.presets.value, context: context() }));
    onScopeDispose(load.stopPrefetch);

    // the task list is read when its tab opens, and again on ↻ while it is open
    watch(options.tab, (tab) => {
        if (tab === 'tasks') {
            void tasks.loadTasks();
        }
    });
    onScopeDispose(load.onRefresh(() => {
        if (options.tab.value === 'tasks') {
            void tasks.loadTasks();
        }
    }));

    watch([range.from, range.to], () => {
        discussion.closeComposer();
        nav.scrollToTabsIfBelow();
    });
    // A composer opened on the previous range's diff, still shown during the first 200 ms of a load, is not sent
    // against the new one.
    watch(() => (load.compare.value ? `${load.compare.value.from}-${load.compare.value.to}` : null), () => discussion.closeComposer());
    /** The comparison being loaded for the current range and context (settled: its errors are Vue's, see below). */
    let shownLoad: Promise<void> = Promise.resolve();
    watch([range.from, range.to, options.fullContext], () => {
        const loading = (async () => {
            await load.loadCompare(compareParams());
            if (nav.curFile.value >= files.value.length) {
                nav.curFile.value = 0;
            }
        })();
        shownLoad = loading.catch(() => undefined);
        // returned: a rejection goes to Vue's error handling, as with an async watcher
        return loading;
    });

    async function gotoFile(idx: number, { expand = false, scroll = true } = {}): Promise<void> {
        const file = files.value[idx];
        if (!file) {
            return;
        }
        if (expand && options.isCollapsed(file)) {
            options.collapsed.set(file.path, false);
        }
        nav.curFile.value = idx;
        await nextTick();
        if (scroll) {
            nav.scrollToFile(file.path);
        }
    }

    // a match's file is shown expanded, then its line (not the file head) is scrolled under the timeline
    const search = useDiffSearch(files, {
        showFile: (idx) => gotoFile(idx, { expand: true, scroll: false }),
        scrollToMatch: nav.scrollToMatch,
    });

    // Ctrl/⌘+click on a name: its definition in the displayed diff, reached like a search match
    const goto = useGotoDefinition(files, {
        showFile: (idx) => gotoFile(idx, { expand: true, scroll: false }),
        nav,
        fullContext: options.fullContext,
        loadWholeFile: async () => {
            options.fullContext.value = true;
            // the watcher above starts the load of the comparison with the whole files
            await nextTick();
            await shownLoad;
        },
    });
    watch([range.from, range.to], () => goto.reset());

    /** "/": the search box of the file list, on the Diff tab. */
    async function focusSearch(): Promise<void> {
        options.tab.value = 'diff';
        await nextTick();
        search.focus();
    }

    function updateCurrentFromScroll(): void {
        if (options.tab.value === 'diff' && files.value.length) {
            nav.curFile.value = nav.fileUnderTimeline(files.value.map((f) => f.path));
        }
    }

    function placementOf(threadId: number): (ThreadPlacement & { path: string }) | null {
        for (const file of files.value) {
            const p = file.threads.find((x) => x.threadId === threadId);
            if (p) {
                return { ...p, path: file.path };
            }
        }
        return null;
    }

    /** "View in diff": Diff tab, file expanded, resolved thread expanded, then scroll to the thread. */
    async function showInDiff(threadId: number): Promise<void> {
        const placement = placementOf(threadId);
        if (!placement) {
            return;
        }
        if (threadsById.value.get(threadId)?.resolved) {
            options.showResolved.value = true;
            options.expandedThreads.add(threadId);
        }
        options.collapsed.set(placement.path, false);
        options.tab.value = 'diff';
        await nextTick();
        nav.revealThread(threadId);
    }

    /** "See the comment" of a task: its thread in the diff when placed there, otherwise the Discussions tab. */
    async function showComment(commentId: number): Promise<void> {
        const threadId = commentThreadId(load.detail.value.threads, commentId);
        if (threadId !== null && placementOf(threadId)) {
            await showInDiff(threadId);
            return;
        }
        options.tab.value = 'discussions';
    }

    /** Files the "mark all" button applies to: the listed ones (all, or the filtered ones while searching). */
    const listedFiles = computed(() => files.value.filter((_, idx) => search.listed(idx)));

    /** "Mark all as viewed" (or not): the files not seen yet (all the listed ones to unmark). */
    function markAllViewed(viewed: boolean): Promise<void> {
        const seen = load.detail.value.review.viewed;
        return review.setAllViewed(viewed ? listedFiles.value.filter((f) => viewedStatus(f, seen) !== 'seen') : listedFiles.value, viewed);
    }

    /**
     * Shortcuts: j/k file, n/p thread, v seen, Shift+V all seen, [ ] version, / search, Alt+← back from a definition,
     * Escape closes the go-to-definition choice, the composer, then the go-to-definition notice. Returns true if the key
     * is handled.
     */
    function handleKey(key: string, event?: Partial<Pick<KeyboardEvent, 'shiftKey' | 'altKey'>>): boolean {
        // under the skeleton, `files` is still the previous comparison: no file moves nor "seen" on it
        const inDiff = options.tab.value === 'diff' && load.diffMode.value !== 'skeleton';
        const current = files.value[nav.curFile.value];
        switch (key) {
            case 'j':
            case 'k':
                if (!inDiff || !files.value.length) {
                    return false;
                }
                void gotoFile(Math.min(Math.max(nav.curFile.value + (key === 'j' ? 1 : -1), 0), files.value.length - 1));
                return true;
            case 'n':
            case 'p':
                nav.nextThread(key === 'n' ? 1 : -1);
                return true;
            case 'v':
                if (!inDiff || !current) {
                    return false;
                }
                void review.setViewed(current, viewedStatus(current, load.detail.value.review.viewed) !== 'seen');
                return true;
            case 'V':
                // the real Shift modifier: with Caps Lock, "v" also yields "V" and must stay "this file only"
                if (!inDiff || !event?.shiftKey) {
                    return false;
                }
                void markAllViewed(true);
                return true;
            case '/':
                if (load.diffMode.value === 'skeleton') {
                    return false;
                }
                void focusSearch();
                return true;
            case '[':
                return range.stepVersion(-1);
            case ']':
                return range.stepVersion(1);
            case 'ArrowLeft':
                // Alt+← only, and only with a place to go back to (otherwise the browser's own Alt+←); never in the
                // VS Code webview on Windows (VS Code's Go Back would run too)
                if (!ALT_LEFT_BACK || !event?.altKey || options.tab.value !== 'diff' || !goto.canGoBack.value) {
                    return false;
                }
                void goto.back();
                return true;
            case 'Escape':
                if (goto.closeChoice()) {
                    return true;
                }
                if (!discussion.composer.value) {
                    return goto.dismiss();
                }
                discussion.closeComposer();
                return true;
            default:
                return false;
        }
    }

    // reactive(): components read page.from, page.detail... without .value (the shallowRefs stay shallow).
    return reactive({
        ref: prRef,
        ...load, ...range, ...options, ...nav, ...discussion, ...review, ...tasks,
        search, goto, listedFiles, markAllViewed, threadsById, canInlineComment, gotoFile, updateCurrentFromScroll, placementOf, showInDiff, showComment, handleKey,
    });
}

export type PrPage = ReturnType<typeof createPrPage>;

const PR_PAGE: InjectionKey<PrPage> = Symbol('prPage');

/** Creates the PR page state (detail already loaded) and makes it available to the child components. */
export function providePrPage(prRef: PrRef, initial: PrDetail): PrPage {
    const page = createPrPage(prRef, initial);
    provide(PR_PAGE, page);
    return page;
}

export function usePrPage(): PrPage {
    const page = inject(PR_PAGE);
    if (!page) {
        throw new Error('usePrPage() must be called under PrLoaded');
    }
    return page;
}
