<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { FileDiff } from '../../shared/api.ts';
import type { MessageKey } from '../i18n/index.ts';
import { buildFileTree, visibleTreeRows } from '../../shared/file-tree.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { useResizableWidth } from '../composables/useResizableWidth.ts';
import { fileThreadCount, viewedStatus, type ViewedStatus } from '../lib/diff.ts';
import { t } from '../i18n/index.ts';
import { basename, MINUS } from '../lib/format.ts';

const STATUS_ICONS = {
    none: { icon: '○', cls: '', title: 'files.notViewed' },
    seen: { icon: '✓', cls: 'seen', title: 'files.viewed' },
    changed: { icon: '●', cls: 'changed', title: 'files.changedSinceViewed' },
} as const satisfies Record<ViewedStatus, { icon: string; cls: string; title: MessageKey }>;
const INDENT = 12;

type GroupKey = 'code' | 'deps';
interface Entry { path: string; file: FileDiff; idx: number }

const page = usePrPage();
const files = computed(() => page.compare?.files ?? []);
const masterOnly = computed(() => page.compare?.masterOnly ?? []);
const seenCount = computed(() => files.value.filter((f) => viewedStatus(f, page.detail.review.viewed) === 'seen').length);

const groupOf = (file: FileDiff): GroupKey => (file.category === 'deps' ? 'deps' : 'code');
/** Collapsed folders, as "group:path" (a folder may exist in both groups). */
const collapsed = ref(new Set<string>());
const dirKey = (group: GroupKey, path: string): string => `${group}:${path}`;

const groups = computed(() => {
    const entries = files.value.map((file, idx): Entry => ({ path: file.path, file, idx }));
    return ([['code', 'files.code'], ['deps', 'files.deps']] as const)
        .map(([key, label]) => ({ key, label, entries: entries.filter((e) => groupOf(e.file) === key) }))
        .filter((g) => g.entries.length)
        .map((g) => ({ ...g, rows: visibleTreeRows(buildFileTree(g.entries), (path) => collapsed.value.has(dirKey(g.key, path))) }));
});

function toggleDir(group: GroupKey, path: string): void {
    const next = new Set(collapsed.value);
    const key = dirKey(group, path);
    if (!next.delete(key)) {
        next.add(key);
    }
    collapsed.value = next;
}

/** Expands the collapsed folders that contain the file. */
function reveal(file: FileDiff): void {
    const prefix = dirKey(groupOf(file), '');
    const hiding = [...collapsed.value].filter((key) => key.startsWith(prefix) && file.path.startsWith(`${key.slice(prefix.length)}/`));
    if (hiding.length) {
        collapsed.value = new Set([...collapsed.value].filter((key) => !hiding.includes(key)));
    }
}

const status = (file: FileDiff) => STATUS_ICONS[viewedStatus(file, page.detail.review.viewed)];
const threads = (file: FileDiff): number => fileThreadCount(file, page.threadsById, page.showResolved);
const unseen = (entries: readonly Entry[]): number => entries.filter((e) => viewedStatus(e.file, page.detail.review.viewed) !== 'seen').length;
const dirThreads = (entries: readonly Entry[]): number => entries.reduce((sum, e) => sum + threads(e.file), 0);
const indent = (depth: number) => ({ paddingLeft: `${6 + depth * INDENT}px` });

const panel = ref<HTMLElement | null>(null);
const resize = useResizableWidth(panel);

// keeps the current file's row visible in the list
const rows = new Map<number, HTMLElement>();
function setRow(idx: number, el: unknown): void {
    if (el instanceof HTMLElement) {
        rows.set(idx, el);
    } else {
        rows.delete(idx);
    }
}
watch(() => page.curFile, async (idx) => {
    const file = files.value[idx];
    if (file) {
        reveal(file);
    }
    await nextTick();
    rows.get(idx)?.scrollIntoView({ block: 'nearest' });
});
</script>

<template>
    <aside ref="panel" :class="['rv-files', { resizing: resize.dragging.value }]" :style="resize.style.value" :aria-label="t('files.label')">
        <div class="rv-files-in">
            <div class="rv-prog">
                <span class="cnt">{{ t('files.progress', { seen: seenCount, total: files.length }) }}</span>
                <span class="rv-bar"><i :style="{ width: `${files.length ? (100 * seenCount) / files.length : 0}%` }" /></span>
            </div>
            <template v-for="group in groups" :key="group.key">
                <div class="rv-grp">{{ t(group.label) }}</div>
                <template v-for="row in group.rows" :key="row.kind === 'dir' ? `d:${row.dir.path}` : `f:${row.item.path}`">
                    <div
                        v-if="row.kind === 'dir'"
                        :class="['rv-d', { collapsed: row.collapsed }]"
                        :style="indent(row.depth)"
                        :data-dir="row.dir.path"
                        :title="row.dir.path"
                        role="button"
                        tabindex="0"
                        :aria-expanded="!row.collapsed"
                        @click="toggleDir(group.key, row.dir.path)"
                        @keydown.enter.space.prevent="toggleDir(group.key, row.dir.path)"
                    >
                        <span class="tw" aria-hidden="true">{{ row.collapsed ? '▸' : '▾' }}</span>
                        <span class="nm"><bdi>{{ row.dir.name }}</bdi></span>
                        <template v-if="row.collapsed">
                            <span v-if="dirThreads(row.files)" class="cm" :title="t('common.threads', { count: dirThreads(row.files) })">💬{{ dirThreads(row.files) }}</span>
                            <span v-if="unseen(row.files)" class="un" :title="t('files.dirUnseen', { count: unseen(row.files) })">{{ unseen(row.files) }}</span>
                            <span v-else class="ck seen" :title="t('files.dirViewed')">✓</span>
                        </template>
                    </div>
                    <div
                        v-else
                        :ref="(el) => setRow(row.item.idx, el)"
                        :class="['rv-f', { cur: row.item.idx === page.curFile }]"
                        :style="indent(row.depth)"
                        :data-path="row.item.path"
                        :data-idx="row.item.idx"
                        :title="row.item.path"
                        role="button"
                        tabindex="0"
                        @click="page.gotoFile(row.item.idx, { expand: true })"
                        @keydown.enter.space.prevent="page.gotoFile(row.item.idx, { expand: true })"
                    >
                        <span :class="['ck', status(row.item.file).cls]" :title="t(status(row.item.file).title)">{{ status(row.item.file).icon }}</span>
                        <span class="nm"><span class="base">{{ basename(row.item.path) }}</span></span>
                        <span v-if="row.item.file.conflict" class="cf" :title="t('files.conflictTitle')">⚠</span>
                        <span v-if="threads(row.item.file)" class="cm" :title="t('common.threads', { count: threads(row.item.file) })">💬{{ threads(row.item.file) }}</span>
                        <span class="ad">+{{ row.item.file.added }}</span>
                        <span class="dl">{{ MINUS }}{{ row.item.file.removed }}</span>
                    </div>
                </template>
            </template>
            <div v-if="!files.length" class="rv-grp">{{ t('files.none') }}</div>
            <div v-if="masterOnly.length" class="rv-masked">
                {{ t('files.masterOnly', { count: masterOnly.length }) }}
                <button type="button" class="rv-link" @click="page.showMasterOnly = !page.showMasterOnly">{{ page.showMasterOnly ? t('files.hide') : t('files.show') }}</button>
                <ul v-if="page.showMasterOnly">
                    <li v-for="p in masterOnly" :key="p" :title="p"><bdi>{{ p }}</bdi></li>
                </ul>
            </div>
        </div>
        <div
            class="rv-resize"
            role="separator"
            aria-orientation="vertical"
            tabindex="0"
            :aria-label="t('files.resize')"
            :title="t('files.resize')"
            @pointerdown="resize.startDrag"
            @dblclick="resize.reset"
            @keydown="resize.onKey"
        />
    </aside>
</template>
