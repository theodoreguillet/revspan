<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import type { FileDiff } from '../../shared/api.ts';
import type { MessageKey } from '../i18n/index.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { fileThreadCount, viewedStatus, type ViewedStatus } from '../lib/diff.ts';
import { t } from '../i18n/index.ts';
import { basename, dirname, MINUS } from '../lib/format.ts';

const STATUS_ICONS = {
    none: { icon: '○', cls: '', title: 'files.notViewed' },
    seen: { icon: '✓', cls: 'seen', title: 'files.viewed' },
    changed: { icon: '●', cls: 'changed', title: 'files.changedSinceViewed' },
} as const satisfies Record<ViewedStatus, { icon: string; cls: string; title: MessageKey }>;

const page = usePrPage();
const files = computed(() => page.compare?.files ?? []);
const masterOnly = computed(() => page.compare?.masterOnly ?? []);
const seenCount = computed(() => files.value.filter((f) => viewedStatus(f, page.detail.review.viewed) === 'seen').length);
const groups = computed(() => {
    const rows = files.value.map((file, idx) => ({ file, idx }));
    return [
        { label: 'files.code' as const, rows: rows.filter(({ file }) => file.category !== 'deps') },
        { label: 'files.deps' as const, rows: rows.filter(({ file }) => file.category === 'deps') },
    ].filter((g) => g.rows.length);
});

const status = (file: FileDiff) => STATUS_ICONS[viewedStatus(file, page.detail.review.viewed)];
const threads = (file: FileDiff): number => fileThreadCount(file, page.threadsById, page.showResolved);

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
    await nextTick();
    rows.get(idx)?.scrollIntoView({ block: 'nearest' });
});
</script>

<template>
    <aside class="rv-files" :aria-label="t('files.label')">
        <div class="rv-prog">
            <span class="cnt">{{ t('files.progress', { seen: seenCount, total: files.length }) }}</span>
            <span class="rv-bar"><i :style="{ width: `${files.length ? (100 * seenCount) / files.length : 0}%` }" /></span>
        </div>
        <template v-for="group in groups" :key="group.label">
            <div class="rv-grp">{{ t(group.label) }}</div>
            <div
                v-for="{ file, idx } in group.rows"
                :key="file.path"
                :ref="(el) => setRow(idx, el)"
                :class="['rv-f', { cur: idx === page.curFile }]"
                :data-path="file.path"
                :data-idx="idx"
                :title="file.path"
                role="button"
                tabindex="0"
                @click="page.gotoFile(idx, { expand: true })"
                @keydown.enter.space.prevent="page.gotoFile(idx, { expand: true })"
            >
                <span :class="['ck', status(file).cls]" :title="t(status(file).title)">{{ status(file).icon }}</span>
                <span class="nm">
                    <span v-if="file.path.includes('/')" class="dir"><bdi>{{ dirname(file.path) }}</bdi></span>
                    <span class="base">{{ basename(file.path) }}</span>
                </span>
                <span v-if="file.conflict" class="cf" :title="t('files.conflictTitle')">⚠</span>
                <span v-if="threads(file)" class="cm" :title="t('common.threads', { count: threads(file) })">💬{{ threads(file) }}</span>
                <span class="ad">+{{ file.added }}</span>
                <span class="dl">{{ MINUS }}{{ file.removed }}</span>
            </div>
        </template>
        <div v-if="!files.length" class="rv-grp">{{ t('files.none') }}</div>
        <div v-if="masterOnly.length" class="rv-masked">
            {{ t('files.masterOnly', { count: masterOnly.length }) }}
            <button type="button" class="rv-link" @click="page.showMasterOnly = !page.showMasterOnly">{{ page.showMasterOnly ? t('files.hide') : t('files.show') }}</button>
            <ul v-if="page.showMasterOnly">
                <li v-for="p in masterOnly" :key="p" :title="p"><bdi>{{ p }}</bdi></li>
            </ul>
        </div>
    </aside>
</template>
