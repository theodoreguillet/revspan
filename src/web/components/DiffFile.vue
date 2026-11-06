<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { FileDiff } from '../../shared/api.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { FILE_STATUS_TAGS, fileThreadCount, firstChangedLine, lastTouched, placeFileThreads, viewedStatus } from '../lib/diff.ts';
import { MINUS, plural } from '../lib/format.ts';
import { isVsCode, openLocalFile, openNativeDiff } from '../services/host.ts';
import DiffHunk from './DiffHunk.vue';
import ThreadCard from './ThreadCard.vue';

const props = defineProps<{ file: FileDiff; idx: number }>();
const page = usePrPage();
const root = ref<HTMLElement | null>(null);

const vstat = computed(() => viewedStatus(props.file, page.detail.review.viewed));
const collapsed = computed(() => page.isCollapsed(props.file));
const touched = computed(() => (page.summary ? lastTouched(page.sums, page.from, page.to, props.file.path) : null));
const statusTag = computed(() => FILE_STATUS_TAGS[props.file.status]);
const openThreads = computed(() => fileThreadCount(props.file, page.threadsById, false));
const placed = computed(() => placeFileThreads(props.file, page.threadsById, page.showResolved));
const title = computed(() => (props.file.status === 'renamed' && props.file.oldPath ? `${props.file.oldPath} → ${props.file.path}` : props.file.path));

function toggle(): void {
    page.toggleCollapsed(props.file);
}

// Dans VS Code : ouvrir le fichier du dépôt local, ou sa comparaison dans l'éditeur de diff
function openFile(): void {
    openLocalFile(page.ref, props.file.path, firstChangedLine(props.file));
}

function openDiff(): void {
    const cmp = page.compare;
    if (cmp) {
        openNativeDiff(page.ref, cmp.from, cmp.to, props.file.path, props.file.oldPath);
    }
}

function onViewed(event: Event): void {
    void page.setViewed(props.file, (event.target as HTMLInputElement).checked);
}

// la navigation (j/k, liste des fichiers) fait défiler jusqu'à ce bloc
onMounted(() => page.registerFile(props.file.path, root.value));
onBeforeUnmount(() => page.registerFile(props.file.path, null));
</script>

<template>
    <section
        ref="root"
        :class="['rv-file', { folded: collapsed, split: page.view === 'split', cur: idx === page.curFile }]"
        :data-path="file.path"
        :data-idx="idx"
    >
        <div class="rv-fh">
            <button type="button" class="tog" :aria-expanded="!collapsed" :title="collapsed ? 'Déplier' : 'Replier'" @click="toggle">{{ collapsed ? '▸' : '▾' }}</button>
            <span class="path" :title="file.path" @click="toggle">{{ title }}</span>
            <span v-if="statusTag" class="tag">{{ statusTag }}</span>
            <span v-if="touched" class="tag" :title="`Dernière modification de l'auteur dans la plage : v${touched}`">v{{ touched }}</span>
            <span v-if="file.conflict" class="rv-conf" title="Pendant un rebase, master et l'auteur ont modifié la même zone : vérifier la résolution.">⚠ zone touchée par master et l'auteur</span>
            <span v-if="vstat === 'changed'" class="rv-conf" title="Tu avais marqué ce fichier comme vu, mais son contenu a changé depuis.">modifié depuis vu</span>
            <span class="sp" />
            <span v-if="openThreads" class="tag" :title="plural(openThreads, 'fil ouvert', 'fils ouverts')">💬 {{ openThreads }}</span>
            <span class="ad">+{{ file.added }}</span>
            <span class="dl">{{ MINUS }}{{ file.removed }}</span>
            <template v-if="isVsCode">
                <button
                    v-if="file.status !== 'removed'"
                    type="button"
                    class="act"
                    data-action="open-file"
                    title="Ouvrir le fichier dans l'éditeur (dépôt cloné localement)"
                    @click="openFile"
                >
                    Ouvrir le fichier
                </button>
                <button type="button" class="act" data-action="open-diff" title="Comparer ces versions dans l'éditeur de diff de VS Code" @click="openDiff">Diff VS Code</button>
            </template>
            <label title="Marquer comme vu (v)">
                <input type="checkbox" :checked="vstat === 'seen'" data-action="viewed" @change="onViewed"> Vu
            </label>
        </div>
        <template v-if="!collapsed">
            <div v-if="placed.fileLevel.length" class="rv-flevel">
                <ThreadCard v-for="t in placed.fileLevel" :key="t.thread.id" :thread="t.thread" :placement="t.placement" file-level />
            </div>
            <div v-if="file.binary" class="rv-fnote">Fichier binaire : contenu non affiché.</div>
            <div v-else-if="file.tooLarge" class="rv-fnote">Diff trop volumineux pour être affiché.</div>
            <div v-else-if="!file.hunks.length" class="rv-fnote">
                {{ file.status === 'renamed' ? 'Fichier renommé sans changement de contenu.' : 'Aucune ligne modifiée à afficher.' }}
            </div>
            <template v-else>
                <DiffHunk v-for="(hunk, k) in file.hunks" :key="k" :path="file.path" :hunk="hunk" :by-line="placed.byLine" />
            </template>
        </template>
    </section>
</template>
