<script setup lang="ts">
import { computed, onMounted, onScopeDispose, shallowRef } from 'vue';
import type { PrState } from '../../shared/api.ts';
import { summarizeBuild } from '../../shared/build.ts';
import type { FollowedUser } from '../../shared/review-settings.ts';
import type { MessageKey } from '../i18n/index.ts';
import { useFollow } from '../composables/useFollow.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { t, tr } from '../i18n/index.ts';
import { approvalItems, approvalProgress, myActions } from '../lib/approvals.ts';
import { displayName, openedSince } from '../lib/format.ts';
import { conflictChip, firstConflictIndex, rebaseChip } from '../lib/merge-conflicts.ts';
import { api } from '../services/api.ts';
import { copyText } from '../services/host.ts';
import { ACTION_KEYS } from '../composables/useReviewActions.ts';
import type { PulseView } from '../composables/usePulse.ts';
import { refreshText } from '../lib/pulse.ts';
import BuildBadge from './BuildBadge.vue';

const props = defineProps<{ pulse: PulseView }>();

const STATE_LABELS = {
    OPEN: 'pr.state.open',
    MERGED: 'pr.state.merged',
    DECLINED: 'pr.state.declined',
    SUPERSEDED: 'pr.state.superseded',
} as const satisfies Record<PrState, MessageKey>;

const page = usePrPage();
const pr = computed(() => page.detail.pr);
// An open draft shows "Draft" in place of "Open" (grey: it asks no review yet); the other states keep their own.
const isDraft = computed(() => pr.value.state === 'OPEN' && pr.value.draft);
const stateLabel = computed(() => (isDraft.value ? t('pr.state.draft') : t(STATE_LABELS[pr.value.state])));

const COPY_FEEDBACK_MS = 1500;
const copyResult = shallowRef<'copied' | 'failed' | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | undefined;
const copyStatus = computed(() => (copyResult.value === 'copied' ? t('pr.linkCopied') : copyResult.value === 'failed' ? t('pr.copyFailed') : ''));

/** Copies the PR link; the result is shown (and announced) for a moment. */
async function copyLink(): Promise<void> {
    copyResult.value = (await copyText(pr.value.url)) ? 'copied' : 'failed';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
        copyResult.value = null;
    }, COPY_FEEDBACK_MS);
}
onScopeDispose(() => clearTimeout(copyTimer));
const n = computed(() => page.n);
const approvals = computed(() => approvalItems(tr(), page.detail, page.sums, !!page.summary));
const progress = computed(() => approvalProgress(page.detail));
const mine = computed(() => myActions(page.detail, page.sums, !!page.summary));
const hasMe = computed(() => !!page.detail.me);
const build = computed(() => (page.detail.build ? summarizeBuild(page.detail.build) : null));
const refreshStatus = computed(() => (props.pulse.status ? refreshText(tr(), props.pulse.status) : ''));
// Same chips on every open PR, mine or a colleague's: behind its destination, and the files Bitbucket cannot merge.
const rebase = computed(() => rebaseChip(tr(), pr.value, page.detail.needsRebase));
const conflictPaths = computed(() => new Set(page.detail.mergeConflicts ?? []));
const conflictTarget = computed(() => firstConflictIndex(page.compare?.files ?? [], conflictPaths.value));
const conflicts = computed(() => conflictChip(tr(), pr.value, page.detail.mergeConflicts, conflictTarget.value));

/** Opens the first conflicting file of the shown comparison in the diff. */
function gotoConflict(): void {
    page.tab = 'diff';
    void page.gotoFile(conflictTarget.value, { expand: true });
}

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
                <span :class="['rv-pill', isDraft ? 'draft' : pr.state]">{{ stateLabel }}</span>
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
                <span class="rv-link-copy">
                    <a :href="pr.url" target="_blank" rel="noopener noreferrer">{{ t('pr.onBitbucket') }}</a>
                    <button
                        type="button"
                        class="rv-copy"
                        data-copy-link
                        :aria-label="t('pr.copyLink')"
                        :title="copyStatus || t('pr.copyLink')"
                        @click="copyLink"
                    >
                        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
                            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
                            <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" fill="none" stroke="currentColor" stroke-width="1.4" />
                        </svg>
                    </button>
                    <span :class="['rv-copy-status', copyResult]" data-copy-status aria-live="polite">{{ copyStatus }}</span>
                </span>
                <template v-if="rebase">
                    · <span class="rv-nb orange" data-chip="needs-rebase" :title="rebase.title">{{ rebase.label }}</span>
                </template>
                <template v-if="conflicts">
                    ·
                    <button
                        v-if="conflictTarget >= 0"
                        type="button"
                        class="rv-nb red rv-nb-btn"
                        data-chip="merge-conflicts"
                        :title="conflicts.title"
                        @click="gotoConflict"
                    >
                        {{ conflicts.label }}
                    </button>
                    <span v-else class="rv-nb red" data-chip="merge-conflicts" :title="conflicts.title">{{ conflicts.label }}</span>
                </template>
                <BuildBadge v-if="build" :build="build" variant="header" @open="page.tab = 'builds'" />
            </div>
            <div class="rv-appr">
                <span
                    :class="['rv-appr-count', { ok: progress.met }]"
                    data-appr-count
                    :title="t('pr.approvalsRequired', { required: progress.required })"
                >{{ t('pr.approvalsOf', { count: progress.count, required: progress.required }) }}</span>
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
            <span class="rv-refresh-status" role="status">{{ refreshStatus }}</span>
            <button
                type="button"
                :class="['rv-btn', { busy: page.refreshing }]"
                data-action="refresh"
                :disabled="page.refreshing || page.acting"
                :aria-busy="page.refreshing"
                :title="t('pr.refreshTitle')"
                @click="pulse.refresh()"
            >
                {{ t('pr.refresh') }}
            </button>
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
