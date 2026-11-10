<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue';
import type { PrState } from '../../shared/api.ts';
import { summarizeBuild } from '../../shared/build.ts';
import type { FollowedUser } from '../../shared/review-settings.ts';
import type { MessageKey } from '../i18n/index.ts';
import { useFollow } from '../composables/useFollow.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { t, tr } from '../i18n/index.ts';
import { approvalItems, myActions } from '../lib/approvals.ts';
import { displayName, openedSince } from '../lib/format.ts';
import { api } from '../services/api.ts';
import { ACTION_KEYS } from '../composables/useReviewActions.ts';
import BuildBadge from './BuildBadge.vue';

const STATE_LABELS = {
    OPEN: 'pr.state.open',
    MERGED: 'pr.state.merged',
    DECLINED: 'pr.state.declined',
    SUPERSEDED: 'pr.state.superseded',
} as const satisfies Record<PrState, MessageKey>;

const page = usePrPage();
const pr = computed(() => page.detail.pr);
const n = computed(() => page.n);
const approvals = computed(() => approvalItems(tr(), page.detail, page.sums, !!page.summary));
const mine = computed(() => myActions(page.detail, page.sums, !!page.summary));
const hasMe = computed(() => !!page.detail.me);
const build = computed(() => (page.detail.build ? summarizeBuild(page.detail.build) : null));

// Followed contributors, read from the settings: until they are known, the follow toggle stays hidden.
const followed = shallowRef<FollowedUser[] | null>(null);
const { busy: followBusy, setFollow } = useFollow((list) => {
    followed.value = list;
});
const author = computed(() => (mine.value.mine ? null : pr.value.author));
const authorFollowed = computed(() => !!author.value && !!followed.value?.some((u) => u.uuid === author.value?.uuid));

function toggleFollow(): void {
    if (author.value) {
        void setFollow(author.value, !authorFollowed.value);
    }
}

onMounted(async () => {
    try {
        followed.value = (await api.followed()).followed;
    } catch {
        // settings unreadable: no follow toggle (the PR itself loaded, so nothing else to report)
    }
});
</script>

<template>
    <header class="rv-head">
        <div class="main">
            <div class="rv-title">{{ pr.title }} <span>#{{ pr.id }}</span></div>
            <div class="rv-meta">
                <span :class="['rv-pill', pr.state]">{{ t(STATE_LABELS[pr.state]) }}</span>
                <span>{{ displayName(pr.author) }}</span>
                <button
                    v-if="author && followed"
                    type="button"
                    :class="['rv-fol', { on: authorFollowed, busy: followBusy }]"
                    data-action="follow"
                    :aria-pressed="authorFollowed"
                    :disabled="followBusy"
                    :title="authorFollowed ? t('home.unfollow', { name: author.displayName }) : t('home.follow', { name: author.displayName })"
                    @click="toggleFollow"
                >
                    {{ authorFollowed ? t('pr.following') : t('pr.follow') }}
                </button> ·
                <span class="rv-mono">{{ pr.sourceBranch }}</span> → <span class="rv-mono">{{ pr.destBranch }}</span> ·
                <span>{{ openedSince(tr(), pr.createdOn) }}</span> ·
                <a :href="pr.url" target="_blank" rel="noopener noreferrer">{{ t('pr.onBitbucket') }}</a>
                <template v-if="page.detail.needsRebase">
                    · <span class="rv-nb orange" data-chip="needs-rebase">{{ t('home.needsRebase') }}</span>
                    <span>{{ t('home.needsRebaseTitle', { branch: pr.destBranch }) }}</span>
                </template>
                <BuildBadge v-if="build" :build="build" variant="header" @open="page.tab = 'builds'" />
            </div>
            <div v-if="approvals.length" class="rv-appr">
                <template v-for="item in approvals" :key="item.name">
                    <span v-if="item.kind === 'approved'" :class="{ stale: item.stale }" :title="item.title">
                        <b>✓</b> {{ item.name }}<template v-if="item.version != null"> · {{ t('pr.onVersion', { version: item.version }) }}</template>
                        <template v-if="item.stale"> · <i>{{ t('pr.stale', { reason: item.stale.text }) }}</i></template>
                    </span>
                    <span v-else-if="item.kind === 'changes'" class="chg" :title="item.title">
                        <b>✕</b> {{ item.name }} · {{ item.version != null ? t('pr.changesRequestedOn', { version: item.version }) : t('pr.changesRequested') }}
                    </span>
                    <span v-else :title="item.title">○ {{ item.name }}</span>
                </template>
            </div>
        </div>
        <div class="acts">
            <span v-if="mine.mine" class="own">{{ t('pr.yourPr') }}</span>
            <template v-else-if="hasMe">
                <button
                    type="button"
                    :class="['rv-btn', { 'rv-btn-active': mine.changesActive, busy: page.busy(ACTION_KEYS.requestChanges) }]"
                    data-action="request-changes"
                    :disabled="mine.closed || page.acting"
                    :aria-busy="page.busy(ACTION_KEYS.requestChanges)"
                    :title="mine.changesActive ? t('pr.withdrawChangesTitle') : t('pr.requestChangesTitle')"
                    @click="page.toggleRequestChanges(!mine.changesActive)"
                >
                    {{ mine.changesActive ? t('pr.changesRequestedButton') : t('pr.requestChanges') }}
                </button>
                <button
                    v-if="mine.approvalHolds"
                    type="button"
                    :class="['rv-btn', { busy: page.busy(ACTION_KEYS.approve) }]"
                    data-action="unapprove"
                    :disabled="mine.closed || page.acting"
                    :aria-busy="page.busy(ACTION_KEYS.approve)"
                    @click="page.setApproved(false)"
                >
                    {{ t('pr.unapprove') }}
                </button>
                <button
                    v-else
                    type="button"
                    :class="['rv-btn rv-btn-ok', { busy: page.busy(ACTION_KEYS.approve) }]"
                    data-action="approve"
                    :disabled="mine.closed || page.acting"
                    :aria-busy="page.busy(ACTION_KEYS.approve)"
                    :title="t('pr.approveTitle', { version: n })"
                    @click="page.setApproved(true)"
                >
                    {{ mine.reapprove ? t('pr.reapprove', { version: n }) : t('pr.approve', { version: n }) }}
                </button>
            </template>
        </div>
    </header>
</template>
