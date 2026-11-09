<script setup lang="ts">
import { computed } from 'vue';
import { usePrPage } from '../composables/usePrPage.ts';
import { changedSegs, versionTypeBadge } from '../lib/describe.ts';
import { fmtDateTime, plural } from '../lib/format.ts';
import { isCode, isMuted } from '../lib/kinds.ts';
import SegText from './SegText.vue';

const page = usePrPage();
const versions = computed(() => page.detail.versions);
const lastReviewed = computed(() => page.detail.review.lastReviewed);
const summaryNote = computed(() => {
    const code = versions.value.filter((v) => isCode(page.sums.get(v.index))).length;
    const rebases = versions.value.filter((v) => v.isRebase).length;
    return `${plural(versions.value.length, 'version')}, dont ${code} avec du code et ${plural(rebases, 'rebase')}. Clic sur une ligne : ce que cette version a changé.`;
});
</script>

<template>
    <div class="rv-vers">
        <table class="rv-tbl">
            <thead>
                <tr><th>Version</th><th>Date</th><th>Type</th><th>Commit · base</th><th>Changé par l'auteur</th></tr>
            </thead>
            <tbody>
                <tr
                    v-for="v in versions"
                    :key="v.index"
                    :class="{ dim: isMuted(page.sums.get(v.index)), sel: v.index > page.from && v.index <= page.to }"
                    :data-v="v.index"
                    role="button"
                    tabindex="0"
                    :aria-disabled="!v.available"
                    :title="`Voir ce que v${v.index} a changé`"
                    @click="page.selectVersion(v.index)"
                    @keydown.enter.space.prevent="page.selectVersion(v.index)"
                >
                    <td><b>v{{ v.index }}</b><span v-if="v.index === lastReviewed" class="relu">✓ relu</span></td>
                    <td>{{ fmtDateTime(v.pushedAt) }}</td>
                    <td><span :class="versionTypeBadge(v).cls">{{ versionTypeBadge(v).label }}</span></td>
                    <td class="mono" :title="`${v.hash}\nbase ${v.base}`">{{ v.shortHash }} · {{ v.baseShort }}</td>
                    <td><SegText :segs="changedSegs(v, page.sums.get(v.index))" /></td>
                </tr>
            </tbody>
        </table>
        <p v-if="page.summary" class="note">{{ summaryNote }}</p>
    </div>
</template>

<style scoped>
.note { color: var(--text-secondary); font-size: 11.5px; }
</style>
