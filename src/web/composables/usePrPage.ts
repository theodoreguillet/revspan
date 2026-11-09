// PR page state, shared through provide/inject: assembles the specialized composables
// (data, range, display options, navigation, comments, review) and wires them together.
import { computed, inject, nextTick, provide, reactive, watch, type InjectionKey } from 'vue';
import type { PrDetail, PrRef, ThreadPlacement } from '../../shared/api.ts';
import { viewedStatus } from '../lib/diff.ts';
import { useDiffNav } from './useDiffNav.ts';
import { useDiffOptions } from './useDiffOptions.ts';
import { useDiscussion } from './useDiscussion.ts';
import { usePrLoad } from './usePrLoad.ts';
import { useRangeSelection } from './useRangeSelection.ts';
import { useReviewActions } from './useReviewActions.ts';

const FULL_CONTEXT = 100000;

function createPrPage(prRef: PrRef, initial: PrDetail) {
    const load = usePrLoad(prRef, initial);
    const range = useRangeSelection(prRef, load.detail);
    const options = useDiffOptions(load.detail);
    const nav = useDiffNav();
    const discussion = useDiscussion(prRef, load);
    const review = useReviewActions(prRef, load, options, nav.keepFileInView);

    const threadsById = computed(() => new Map(load.detail.value.threads.map((t) => [t.id, t])));
    const canInlineComment = computed(() => load.compare.value?.to === range.n.value && load.detail.value.pr.state === 'OPEN');
    const files = computed(() => load.compare.value?.files ?? []);

    const compareParams = () => ({ from: range.from.value, to: range.to.value, context: options.fullContext.value ? FULL_CONTEXT : 3 });

    void load.loadSummary();
    void load.loadCompare(compareParams());

    watch([range.from, range.to], () => {
        discussion.closeComposer();
        nav.scrollToTabsIfBelow();
    });
    watch([range.from, range.to, options.fullContext], async () => {
        await load.loadCompare(compareParams());
        if (nav.curFile.value >= files.value.length) {
            nav.curFile.value = 0;
        }
    });

    async function gotoFile(idx: number, { expand = false } = {}): Promise<void> {
        const file = files.value[idx];
        if (!file) {
            return;
        }
        if (expand && options.isCollapsed(file)) {
            options.collapsed.set(file.path, false);
        }
        nav.curFile.value = idx;
        await nextTick();
        nav.scrollToFile(file.path);
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

    /** Shortcuts: j/k file, n/p thread, v seen, [ ] version, Escape closes the composer. Returns true if the key is handled. */
    function handleKey(key: string): boolean {
        const inDiff = options.tab.value === 'diff';
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
            case '[':
                return range.stepVersion(-1);
            case ']':
                return range.stepVersion(1);
            case 'Escape':
                if (!discussion.composer.value) {
                    return false;
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
        ...load, ...range, ...options, ...nav, ...discussion, ...review,
        threadsById, canInlineComment, gotoFile, updateCurrentFromScroll, placementOf, showInDiff, handleKey,
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
