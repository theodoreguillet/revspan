<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watchEffect } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import type { Home, HomeGroupKey, User } from '../../shared/api.ts';
import { useFollow } from '../composables/useFollow.ts';
import { useLocalPref } from '../composables/useLocalPref.ts';
import { t, tr, type MessageKey } from '../i18n/index.ts';
import { errorText } from '../lib/errors.ts';
import { withFollowedCards } from '../../shared/follow.ts';
import { GROUP_TITLES, truncatedNotice } from '../lib/home.ts';
import { GROUPINGS, groupCards, groupingFor, isGrouping, type Grouping } from '../../shared/home-grouping.ts';
import { api, ApiError } from '../services/api.ts';
import ErrorPanel from '../components/ErrorPanel.vue';
import I18nText from '../components/I18nText.vue';
import PrCardRow from '../components/PrCardRow.vue';
import TopNav from '../components/TopNav.vue';
import UrlInput from '../components/UrlInput.vue';

const router = useRouter();
const home = shallowRef<Home | null>(null);
const error = shallowRef<unknown>(null);
const loading = ref(false);

watchEffect(() => {
    document.title = t('home.docTitle');
});

async function load(): Promise<void> {
    if (loading.value) {
        return;
    }
    loading.value = true;
    error.value = null;
    home.value = null;
    try {
        home.value = await api.home();
    } catch (e) {
        if (e instanceof ApiError && e.code === 'NO_TOKEN') {
            void router.push('/settings');
            return;
        }
        error.value = e;
    } finally {
        loading.value = false;
    }
}

const GROUPING_LABELS = {
    repository: 'home.grouping.repository',
    contributor: 'home.grouping.contributor',
    none: 'home.grouping.none',
} as const satisfies Record<Grouping, MessageKey>;

const GROUP_DESCRIPTIONS: Partial<Record<HomeGroupKey, 'home.groupDesc.toDo' | 'home.groupDesc.waiting'>> = {
    'to-do': 'home.groupDesc.toDo',
    waiting: 'home.groupDesc.waiting',
};

const grouping = useLocalPref<Grouping>('home.grouping', 'repository', isGrouping);

const visibleGroups = computed(() => (home.value?.groups.filter((g) => g.prs.length > 0) ?? []).map((group) => {
    const mode = groupingFor(group.key, grouping.value);
    return { ...group, mode, description: GROUP_DESCRIPTIONS[group.key] ?? null, subgroups: groupCards(group.prs, mode) };
}));

// Follow from a row: the cards are marked from the saved list at once, without reloading the PRs.
const { busy: followBusy, setFollow } = useFollow((list) => {
    if (home.value) {
        home.value = withFollowedCards(home.value, list);
    }
});

function onFollow(user: User, follow: boolean): void {
    void setFollow(user, follow);
}

onMounted(load);
</script>

<template>
    <TopNav />
    <main class="rv-home">
        <div class="rv-home-top">
            <h1>{{ t('home.title') }}</h1>
            <UrlInput />
            <button :class="['rv-btn', { busy: loading }]" type="button" :title="t('home.reloadTitle')" :disabled="loading" :aria-busy="loading" @click="load()">
                {{ loading ? t('home.refresh') : `↻ ${t('home.refresh')}` }}
            </button>
        </div>

        <ErrorPanel v-if="error" :error="error" />
        <div v-else-if="!home" class="rv-list" aria-busy="true">
            <div class="rv-lgrp">{{ t('home.loading') }}</div>
            <div v-for="k in 4" :key="k" class="rv-skel-row">
                <div class="rv-skel l1" />
                <div class="rv-skel l2" />
            </div>
        </div>
        <template v-else>
            <div v-if="home.errors.length" class="rv-errs">
                <b>{{ t('home.repoErrors') }}</b>
                <ul>
                    <li v-for="e in home.errors" :key="e.repo"><span class="r">{{ e.repo }}</span> — {{ errorText(tr(), e) }}</li>
                </ul>
            </div>
            <p v-for="cut in home.truncated" :key="cut.repo" class="rv-notice" data-testid="truncated">{{ truncatedNotice(tr(), cut) }}</p>
            <p v-if="!home.me" class="rv-notice" data-testid="no-profile">
                {{ t('home.noProfile') }}
                <I18nText k="home.noProfileFix">
                    <template #scope><code>read:user:bitbucket</code></template>
                    <template #settings><RouterLink to="/settings">{{ t('home.settingsLink') }}</RouterLink></template>
                </I18nText>
            </p>
            <div v-if="visibleGroups.length" class="rv-home-bar">
                <span>{{ t('home.groupBy') }}</span>
                <span class="rv-seg" role="group" :aria-label="t('home.groupBy')">
                    <button
                        v-for="mode in GROUPINGS"
                        :key="mode"
                        type="button"
                        :class="{ on: grouping === mode }"
                        :data-grouping="mode"
                        :aria-pressed="grouping === mode"
                        @click="grouping = mode"
                    >
                        {{ t(GROUPING_LABELS[mode]) }}
                    </button>
                </span>
            </div>
            <component
                :is="group.key === 'others' ? 'details' : 'section'"
                v-for="group in visibleGroups"
                :key="group.key"
                class="rv-list"
                :data-group="group.key"
                :open="group.key === 'others' ? !home.me : undefined"
            >
                <component :is="group.key === 'others' ? 'summary' : 'div'" class="rv-lgrp">
                    {{ t(GROUP_TITLES[group.key]) }} <span class="cnt">· {{ group.prs.length }}</span>
                    <span v-if="group.description" class="desc">{{ t(group.description) }}</span>
                </component>
                <template v-for="sub in group.subgroups" :key="sub.key">
                    <div v-if="group.mode !== 'none'" class="rv-sg" :data-subgroup="sub.key">
                        <span v-if="group.mode === 'contributor' && sub.cards[0]?.followed" class="rv-star" :title="t('home.followedMark')">★</span>
                        {{ sub.label || t('home.unknownAuthor') }} <span class="cnt">· {{ sub.cards.length }}</span>
                    </div>
                    <PrCardRow
                        v-for="card in sub.cards"
                        :key="`${card.workspace}/${card.repo}/${card.id}`"
                        :card="card"
                        :me="home.me"
                        :follow-busy="followBusy"
                        @follow="onFollow"
                    />
                </template>
            </component>
            <div v-if="!home.repos.length" class="rv-panel-msg" data-testid="no-repos">
                <h2>{{ t('home.noRepos') }}</h2>
                <p>
                    <I18nText k="home.noReposHelp">
                        <template #settings><RouterLink to="/settings">{{ t('home.settingsLink') }}</RouterLink></template>
                    </I18nText>
                </p>
            </div>
            <div v-else-if="!visibleGroups.length" class="rv-panel-msg">
                <h2>{{ t('home.noOpenPrs') }}</h2>
                <p>{{ t('home.noOpenPrsHelp') }} <RouterLink to="/settings">{{ t('home.editRepos') }}</RouterLink>.</p>
            </div>
        </template>
    </main>
</template>
