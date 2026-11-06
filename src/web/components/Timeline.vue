<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { usePrPage } from '../composables/usePrPage.ts';
import { plural } from '../lib/format.ts';
import { presets, readout } from '../lib/selection.ts';
import { inBand, timelineModel, type TimelineItem } from '../lib/timeline.ts';
import TimelineNode from './TimelineNode.vue';

const page = usePrPage();
const root = ref<HTMLElement | null>(null);
const track = ref<HTMLElement | null>(null);

const versions = computed(() => page.detail.versions);
const lastReviewed = computed(() => page.detail.review.lastReviewed);
const dest = computed(() => page.detail.pr.destBranch);
const items = computed(() => timelineModel({
    versions: versions.value,
    sums: page.sums,
    lastReviewed: lastReviewed.value,
    from: page.from,
    to: page.to,
    hideNoCode: page.hideNoCode,
    foldDisabled: page.foldDisabled,
}));
const text = computed(() => {
    const cmp = page.compare;
    const stats = cmp && cmp.from === page.from && cmp.to === page.to ? cmp.stats : null;
    return readout({ from: page.from, to: page.to, versions: versions.value, sums: page.sums, stats, destBranch: dest.value });
});
const presetList = computed(() => presets(page.n, lastReviewed.value));

const band = (after: number): boolean => inBand(after, page.from, page.to);

function foldDetail(item: Extract<TimelineItem, { type: 'fold' }>): string {
    const parts: string[] = [];
    if (item.codeCount != null) {
        parts.push(`${item.codeCount} avec du code`);
    }
    parts.push(plural(item.rebases, 'rebase'));
    return parts.join(' · ');
}

// la hauteur de la frise (collante) décale les éléments collants en dessous : en-têtes de fichiers, liste des fichiers
let observer: ResizeObserver | null = null;
onMounted(async () => {
    observer = new ResizeObserver(() => {
        const height = root.value?.offsetHeight ?? 0;
        page.tlHeight = height;
        document.documentElement.style.setProperty('--tl-h', `${height}px`);
    });
    if (root.value) {
        observer.observe(root.value);
    }
    await nextTick();
    if (track.value) {
        track.value.scrollLeft = track.value.scrollWidth; // les dernières versions d'abord
    }
});
onBeforeUnmount(() => {
    observer?.disconnect();
    document.documentElement.style.removeProperty('--tl-h');
});
</script>

<template>
    <div ref="root" class="rv-tl" role="region" aria-label="Frise des versions">
        <div ref="track" class="rv-track">
            <template v-for="(item, k) in items" :key="k">
                <div v-if="item.type === 'base'" class="rv-day">
                    <div class="rv-dlabel">base</div>
                    <div class="rv-nodes">
                        <button
                            type="button"
                            :class="['rv-v', 'base', { from: page.from === 0 }]"
                            data-i="0"
                            :title="`${dest} · cible de la PR — clic : comparer la version « à » à sa base sur ${dest}`"
                            :aria-label="`Base ${dest}`"
                            @click="page.clickVersion(0, false)"
                        >
                            <span class="tag de">de</span>
                            <span class="rv-dot" />
                            <span class="rv-vl">{{ dest }}</span>
                            <span class="rv-dl muted">&nbsp;</span>
                        </button>
                    </div>
                </div>
                <div v-else-if="item.type === 'sp'" :class="['rv-sp', { in: band(item.after) }]" />
                <div v-else-if="item.type === 'gap'" :class="['rv-gap', { in: band(item.after) }]" :title="`${item.days} jours sans push`">
                    <span>{{ item.label }}</span>
                </div>
                <div v-else-if="item.type === 'seen'" :class="['rv-seen', { in: band(item.after) }]" :title="`Ta dernière relecture : v${item.after}`">
                    <span class="lbl">✓ relu</span>
                    <span class="bar" />
                </div>
                <div v-else-if="item.type === 'fold'" :class="['rv-fold', { in: item.a > page.from && item.b <= page.to }]">
                    <button type="button" title="Déplier ces versions" @click="page.foldDisabled = true">
                        ⋯ v{{ item.a }} → v{{ item.b }} · {{ item.months }}<br>{{ foldDetail(item) }}
                    </button>
                </div>
                <div v-else class="rv-day">
                    <div class="rv-dlabel">{{ item.label || '\u00a0' }}</div>
                    <div class="rv-nodes">
                        <template v-for="node in item.nodes" :key="node.type === 'node' ? node.version.index : `h${node.list.join('-')}`">
                            <TimelineNode v-if="node.type === 'node'" :version="node.version" />
                            <button
                                v-else
                                type="button"
                                class="rv-tick"
                                :title="`${plural(node.list.length, 'version')} sans code masquée(s) : ${node.list.map((i) => `v${i}`).join(', ')} — clic pour tout afficher`"
                                @click="page.hideNoCode = false"
                            >
                                ⋯{{ node.list.length }}
                            </button>
                        </template>
                    </div>
                </div>
            </template>
        </div>
        <div class="rv-tl-foot">
            <span class="rv-readout" aria-live="polite"><b>{{ text.bold }}</b> <span class="s">{{ text.rest }}</span></span>
            <button
                v-for="p in presetList"
                :key="p.key"
                type="button"
                :class="['rv-preset', { on: p.from === page.from && p.to === page.to }]"
                :data-preset="p.key"
                @click="page.select(p.from, p.to)"
            >
                {{ p.label }}
            </button>
            <span class="rv-hint">
                <label><input id="hide-no-code" v-model="page.hideNoCode" type="checkbox"> Masquer rebases seuls et deps</label>
                <span class="rv-legend"><span class="reb">◆</span> rebase · <span class="new">●</span> nouveau pour toi</span>
            </span>
        </div>
    </div>
</template>
