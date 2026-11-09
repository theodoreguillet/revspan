<script setup lang="ts">
import { computed } from 'vue';
import type { PrState } from '../../shared/api.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { approvalItems, myActions } from '../lib/approvals.ts';
import { displayName, openedSince } from '../lib/format.ts';
import { ACTION_KEYS } from '../composables/useReviewActions.ts';

const STATE_LABELS: Record<PrState, string> = { OPEN: '● Ouverte', MERGED: 'Fusionnée', DECLINED: 'Refusée', SUPERSEDED: 'Remplacée' };

const page = usePrPage();
const pr = computed(() => page.detail.pr);
const n = computed(() => page.n);
const approvals = computed(() => approvalItems(page.detail, page.sums, !!page.summary));
const mine = computed(() => myActions(page.detail));
const hasMe = computed(() => !!page.detail.me);
</script>

<template>
    <header class="rv-head">
        <div class="main">
            <div class="rv-title">{{ pr.title }} <span>#{{ pr.id }}</span></div>
            <div class="rv-meta">
                <span :class="['rv-pill', pr.state]">{{ STATE_LABELS[pr.state] }}</span>
                <span>{{ displayName(pr.author) }}</span> ·
                <span class="rv-mono">{{ pr.sourceBranch }}</span> → <span class="rv-mono">{{ pr.destBranch }}</span> ·
                <span>{{ openedSince(pr.createdOn) }}</span> ·
                <a :href="pr.url" target="_blank" rel="noopener noreferrer">Bitbucket ↗</a>
            </div>
            <div v-if="approvals.length" class="rv-appr">
                <template v-for="item in approvals" :key="item.name">
                    <span v-if="item.kind === 'approved'" :class="{ stale: item.stale }" :title="item.title">
                        <b>✓</b> {{ item.name }}<template v-if="item.version != null"> · sur v{{ item.version }}</template>
                        <template v-if="item.stale"> · <i>périmée ({{ item.stale.text }})</i></template>
                    </span>
                    <span v-else-if="item.kind === 'changes'" class="chg" :title="item.title">
                        <b>✕</b> {{ item.name }} · modifs demandées<template v-if="item.version != null"> sur v{{ item.version }}</template>
                    </span>
                    <span v-else :title="item.title">○ {{ item.name }}</span>
                </template>
            </div>
        </div>
        <div class="acts">
            <span v-if="mine.mine" class="own">Ta PR</span>
            <template v-else-if="hasMe">
                <button
                    type="button"
                    :class="['rv-btn', { 'rv-btn-active': mine.changesActive, busy: page.busy(ACTION_KEYS.requestChanges) }]"
                    data-action="request-changes"
                    :disabled="mine.closed || page.acting"
                    :aria-busy="page.busy(ACTION_KEYS.requestChanges)"
                    :title="mine.changesActive ? 'Retirer la demande de modifications' : 'Demander des modifications à l\'auteur'"
                    @click="page.toggleRequestChanges(!mine.changesActive)"
                >
                    {{ mine.changesActive ? 'Modifs demandées ✕' : 'Demander des modifs' }}
                </button>
                <button
                    v-if="mine.approvedLatest"
                    type="button"
                    :class="['rv-btn', { busy: page.busy(ACTION_KEYS.approve) }]"
                    data-action="unapprove"
                    :disabled="mine.closed || page.acting"
                    :aria-busy="page.busy(ACTION_KEYS.approve)"
                    @click="page.setApproved(false)"
                >
                    Retirer l'approbation
                </button>
                <button
                    v-else
                    type="button"
                    :class="['rv-btn rv-btn-ok', { busy: page.busy(ACTION_KEYS.approve) }]"
                    data-action="approve"
                    :disabled="mine.closed || page.acting"
                    :aria-busy="page.busy(ACTION_KEYS.approve)"
                    :title="`Approuver la version ${n} (marque aussi v${n} comme relue)`"
                    @click="page.setApproved(true)"
                >
                    {{ mine.reapprove ? `✓ Réapprouver v${n}` : `✓ Approuver v${n}` }}
                </button>
            </template>
        </div>
    </header>
</template>
