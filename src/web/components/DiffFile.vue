<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { FileDiff } from '../../shared/api.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { FILE_STATUS_TAGS, fileThreadCount, firstChangedLine, lastTouched, placeFileThreads, viewedStatus } from '../lib/diff.ts';
import { t } from '../i18n/index.ts';
import { MINUS } from '../lib/format.ts';
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

// In VS Code: open the local repository file, or its comparison in the diff editor
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

// navigation (j/k, file list) scrolls to this block
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
            <button type="button" class="tog" :aria-expanded="!collapsed" :title="collapsed ? t('file.expand') : t('file.collapse')" @click="toggle">{{ collapsed ? '▸' : '▾' }}</button>
            <span class="path" :title="file.path" @click="toggle">{{ title }}</span>
            <span v-if="statusTag" class="tag">{{ t(statusTag) }}</span>
            <span v-if="touched" class="tag" :title="t('file.touchedTitle', { version: touched })">v{{ touched }}</span>
            <span v-if="file.conflict" class="rv-conf" :title="t('file.conflictTitle')">{{ t('file.conflict') }}</span>
            <span v-if="vstat === 'changed'" class="rv-conf" :title="t('file.changedSinceViewedTitle')">{{ t('file.changedSinceViewed') }}</span>
            <span class="sp" />
            <span v-if="openThreads" class="tag" :title="t('file.openThreads', { count: openThreads })">💬 {{ openThreads }}</span>
            <span class="ad">+{{ file.added }}</span>
            <span class="dl">{{ MINUS }}{{ file.removed }}</span>
            <template v-if="isVsCode">
                <button
                    v-if="file.status !== 'removed'"
                    type="button"
                    class="act"
                    data-action="open-file"
                    :title="t('file.openFileTitle')"
                    @click="openFile"
                >
                    {{ t('file.openFile') }}
                </button>
                <button type="button" class="act" data-action="open-diff" :title="t('file.openDiffTitle')" @click="openDiff">{{ t('file.openDiff') }}</button>
            </template>
            <label :title="t('file.viewedTitle')">
                <input type="checkbox" :checked="vstat === 'seen'" data-action="viewed" @change="onViewed"> {{ t('file.viewed') }}
            </label>
        </div>
        <template v-if="!collapsed">
            <div v-if="placed.fileLevel.length" class="rv-flevel">
                <ThreadCard v-for="item in placed.fileLevel" :key="item.thread.id" :thread="item.thread" :placement="item.placement" file-level />
            </div>
            <div v-if="file.binary" class="rv-fnote">{{ t('file.binary') }}</div>
            <div v-else-if="file.tooLarge" class="rv-fnote">{{ t('file.tooLarge') }}</div>
            <div v-else-if="!file.hunks.length" class="rv-fnote">
                {{ file.status === 'renamed' ? t('file.renamedOnly') : t('file.noLines') }}
            </div>
            <template v-else>
                <DiffHunk v-for="(hunk, k) in file.hunks" :key="k" :path="file.path" :hunk="hunk" :by-line="placed.byLine" />
            </template>
        </template>
    </section>
</template>
