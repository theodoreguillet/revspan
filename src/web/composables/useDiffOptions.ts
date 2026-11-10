// Display options of the PR page: tab, timeline, diff view, collapsed files, expanded resolved threads.
import { reactive, ref, type Ref } from 'vue';
import type { FileDiff, PrDetail } from '../../shared/api.ts';
import { viewedStatus } from '../lib/diff.ts';
import { isBoolean, useLocalPref } from './useLocalPref.ts';

export type PrTab = 'diff' | 'discussions' | 'versions' | 'builds';
export type DiffView = 'unified' | 'split';

const isDiffView = (value: unknown): value is DiffView => value === 'unified' || value === 'split';

export function useDiffOptions(detail: Ref<PrDetail>) {
    const tab = ref<PrTab>('diff');
    const hideNoCode = useLocalPref('hideNoCode', false, isBoolean);
    const view = useLocalPref<DiffView>('diffView', 'unified', isDiffView);
    const foldDisabled = ref(false);
    const fullContext = ref(false);
    const showResolved = ref(false);
    const showMasterOnly = ref(false);
    /** Explicit user choices; otherwise a seen file is collapsed. */
    const collapsed = reactive(new Map<string, boolean>());
    const expandedThreads = reactive(new Set<number>());

    function isCollapsed(file: FileDiff): boolean {
        return collapsed.get(file.path) ?? viewedStatus(file, detail.value.review.viewed) === 'seen';
    }

    function toggleCollapsed(file: FileDiff): void {
        collapsed.set(file.path, !isCollapsed(file));
    }

    function toggleThreadExpanded(id: number): void {
        if (!expandedThreads.delete(id)) {
            expandedThreads.add(id);
        }
    }

    return {
        tab, hideNoCode, view, foldDisabled, fullContext, showResolved, showMasterOnly,
        collapsed, expandedThreads, isCollapsed, toggleCollapsed, toggleThreadExpanded,
    };
}

export type DiffOptions = ReturnType<typeof useDiffOptions>;
