<script setup lang="ts">
import { computed } from 'vue';
import { errorInfo } from '../services/api.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { MINUS, plural, vname } from '../lib/format.ts';
import DiffFile from './DiffFile.vue';
import DiffToolbar from './DiffToolbar.vue';
import FileList from './FileList.vue';

const page = usePrPage();
const cmp = computed(() => page.compare);
const masterOnlyNote = computed(() => {
    const count = cmp.value?.masterOnly.length ?? 0;
    return count ? ` ${plural(count, 'fichier venu', 'fichiers venus')} de master ${count > 1 ? 'masqués' : 'masqué'}.` : '';
});
</script>

<template>
    <div v-if="!cmp" class="rv-body">
        <div class="rv-diff">
            <div v-if="page.compareError" class="rv-empty">Impossible de charger le diff : {{ errorInfo(page.compareError).message }}</div>
            <div v-else class="rv-loading">Calcul du diff…</div>
        </div>
    </div>
    <div v-else :class="['rv-body', { loading: page.compareLoading }]">
        <FileList />
        <div class="rv-diff">
            <DiffToolbar />
            <div v-if="cmp.messageChanged" class="rv-msgdiff">
                <div class="t">Message du commit modifié</div>
                <div v-if="cmp.messageFrom" class="rv-l r"><span class="s">{{ MINUS }}</span><span class="c">{{ cmp.messageFrom }}</span></div>
                <div class="rv-l a"><span class="s">+</span><span class="c">{{ cmp.messageTo }}</span></div>
            </div>
            <div v-if="!cmp.files.length" class="rv-empty">
                Aucun changement de l'auteur entre {{ vname(cmp.from) }} et v{{ cmp.to }}.{{ masterOnlyNote }}
            </div>
            <DiffFile v-for="(file, idx) in cmp.files" :key="file.path" :file="file" :idx="idx" />
            <div v-if="cmp.files.length" class="rv-tail" />
        </div>
    </div>
</template>

<style scoped>
/* laisse défiler le dernier fichier jusque sous la frise (navigation j/k) */
.rv-tail { height: 55vh; }
</style>
