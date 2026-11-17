<script setup lang="ts">
import { computed } from 'vue';
import { errorInfo } from '../services/api.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { t } from '../i18n/index.ts';
import { MINUS, vname } from '../lib/format.ts';
import DiffFile from './DiffFile.vue';
import DiffToolbar from './DiffToolbar.vue';
import FileList from './FileList.vue';
import GotoDefinition from './GotoDefinition.vue';

/** Line widths of the placeholder files. */
const SKELETON_FILES = [['62%', '48%', '71%', '35%', '56%'], ['44%', '67%', '52%'], ['58%', '39%', '64%', '47%']];

const page = usePrPage();
const cmp = computed(() => page.compare);
const skeleton = computed(() => page.diffMode === 'skeleton');
const masterOnlyNote = computed(() => {
    const count = cmp.value?.masterOnly.length ?? 0;
    return count ? ` ${t('diff.masterOnlyHidden', { count })}` : '';
});
</script>

<template>
    <div v-if="!cmp && page.compareError" class="rv-body">
        <div class="rv-diff">
            <div class="rv-empty">{{ t('diff.loadFailed', { message: errorInfo(page.compareError).message }) }}</div>
        </div>
    </div>
    <div v-else class="rv-body">
        <FileList :skeleton="skeleton" />
        <!-- Ctrl/⌘+click on a name (delegated); `rv-goto` while the modifier is held: names underline on hover -->
        <div :class="['rv-diff', { 'rv-goto': page.goto.armed }]" @click="page.goto.onClick">
            <DiffToolbar />
            <!-- slow diff (or none yet): placeholder files instead of the previous range's diff -->
            <div v-if="skeleton || !cmp" class="rv-diff-skel" role="status" aria-busy="true">
                <span class="rv-sr-only">{{ t('diff.computing') }}</span>
                <div v-for="(lines, k) in SKELETON_FILES" :key="k" class="rv-skel-file">
                    <div class="rv-skel-fh"><div class="rv-skel" /></div>
                    <div class="rv-skel-lines">
                        <div v-for="(width, i) in lines" :key="i" class="rv-skel" :style="{ width }" />
                    </div>
                </div>
            </div>
            <template v-else>
                <div v-if="cmp.messageChanged" class="rv-msgdiff">
                    <div class="t">{{ t('diff.messageChanged') }}</div>
                    <div v-if="cmp.messageFrom" class="rv-l r"><span class="s">{{ MINUS }}</span><span class="c">{{ cmp.messageFrom }}</span></div>
                    <div class="rv-l a"><span class="s">+</span><span class="c">{{ cmp.messageTo }}</span></div>
                </div>
                <div v-if="!cmp.files.length" class="rv-empty">
                    {{ t('diff.noAuthorChanges', { from: vname(cmp.from), to: vname(cmp.to) }) }}{{ masterOnlyNote }}
                </div>
                <DiffFile v-for="(file, idx) in cmp.files" :key="file.path" :file="file" :idx="idx" />
                <div v-if="cmp.files.length" class="rv-tail" />
                <GotoDefinition />
            </template>
        </div>
    </div>
</template>

<style scoped>
/* lets the last file scroll up to just under the timeline (j/k navigation) */
.rv-tail { height: 55vh; }
</style>
