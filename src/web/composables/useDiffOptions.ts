// Options d'affichage de la page PR : onglet, frise, vue du diff, fichiers repliés, fils résolus dépliés.
import { reactive, ref, type Ref } from 'vue';
import type { FileDiff, PrDetail } from '../../shared/api.ts';
import { viewedStatus } from '../lib/diff.ts';
import { isBoolean, useLocalPref } from './useLocalPref.ts';

export type PrTab = 'diff' | 'discussions' | 'versions';
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
    /** Choix explicites de l'utilisateur ; sinon un fichier vu est replié. */
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
