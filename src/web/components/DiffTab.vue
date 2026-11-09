<script setup lang="ts">
import { computed } from 'vue';
import { errorInfo } from '../services/api.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { t } from '../i18n/index.ts';
import { MINUS, vname } from '../lib/format.ts';
import DiffFile from './DiffFile.vue';
import DiffToolbar from './DiffToolbar.vue';
import FileList from './FileList.vue';

const page = usePrPage();
const cmp = computed(() => page.compare);
const masterOnlyNote = computed(() => {
    const count = cmp.value?.masterOnly.length ?? 0;
    return count ? ` ${t('diff.masterOnlyHidden', { count })}` : '';
});
</script>

<template>
    <div v-if="!cmp" class="rv-body">
        <div class="rv-diff">
            <div v-if="page.compareError" class="rv-empty">{{ t('diff.loadFailed', { message: errorInfo(page.compareError).message }) }}</div>
            <div v-else class="rv-loading">{{ t('diff.computing') }}</div>
        </div>
    </div>
    <div v-else :class="['rv-body', { loading: page.compareLoading }]">
        <FileList />
        <div class="rv-diff">
            <DiffToolbar />
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
        </div>
    </div>
</template>

<style scoped>
/* lets the last file scroll up to just under the timeline (j/k navigation) */
.rv-tail { height: 55vh; }
</style>
