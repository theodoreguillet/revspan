<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watchEffect } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import type { Home } from '../../shared/api.ts';
import { t, tr } from '../i18n/index.ts';
import { errorText } from '../lib/errors.ts';
import { GROUP_TITLES } from '../lib/home.ts';
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

const visibleGroups = computed(() => home.value?.groups.filter((g) => g.prs.length > 0) ?? []);

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
            <p v-if="!home.me" class="rv-notice" data-testid="no-profile">
                {{ t('home.noProfile') }}
                <I18nText k="home.noProfileFix">
                    <template #scope><code>read:user:bitbucket</code></template>
                    <template #settings><RouterLink to="/settings">{{ t('home.settingsLink') }}</RouterLink></template>
                </I18nText>
            </p>
            <template v-for="group in visibleGroups" :key="group.key">
                <details v-if="group.key === 'others'" class="rv-list" :data-group="group.key" :open="!home.me">
                    <summary class="rv-lgrp">{{ t(GROUP_TITLES[group.key]) }} <span class="cnt">· {{ group.prs.length }}</span></summary>
                    <PrCardRow v-for="card in group.prs" :key="`${card.workspace}/${card.repo}/${card.id}`" :card="card" :group-key="group.key" :me="home.me" />
                </details>
                <section v-else class="rv-list" :data-group="group.key">
                    <div class="rv-lgrp">{{ t(GROUP_TITLES[group.key]) }} <span class="cnt">· {{ group.prs.length }}</span></div>
                    <PrCardRow v-for="card in group.prs" :key="`${card.workspace}/${card.repo}/${card.id}`" :card="card" :group-key="group.key" :me="home.me" />
                </section>
            </template>
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
