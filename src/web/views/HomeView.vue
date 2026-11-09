<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import type { Home } from '../../shared/api.ts';
import { api, ApiError } from '../services/api.ts';
import ErrorPanel from '../components/ErrorPanel.vue';
import PrCardRow from '../components/PrCardRow.vue';
import TopNav from '../components/TopNav.vue';
import UrlInput from '../components/UrlInput.vue';

const router = useRouter();
const home = shallowRef<Home | null>(null);
const error = shallowRef<unknown>(null);
const loading = ref(false);

document.title = 'Mes PR · Strata';

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
            <h1>Mes PR</h1>
            <UrlInput />
            <button :class="['rv-btn', { busy: loading }]" type="button" title="Recharger la liste" :disabled="loading" :aria-busy="loading" @click="load()">
                {{ loading ? 'Actualiser' : '↻ Actualiser' }}
            </button>
        </div>

        <ErrorPanel v-if="error" :error="error" />
        <div v-else-if="!home" class="rv-list" aria-busy="true">
            <div class="rv-lgrp">Chargement des PR…</div>
            <div v-for="k in 4" :key="k" class="rv-skel-row">
                <div class="rv-skel l1" />
                <div class="rv-skel l2" />
            </div>
        </div>
        <template v-else>
            <div v-if="home.errors.length" class="rv-errs">
                <b>Certains dépôts n'ont pas pu être lus :</b>
                <ul>
                    <li v-for="e in home.errors" :key="e.repo"><span class="r">{{ e.repo }}</span> — {{ e.message }}</li>
                </ul>
            </div>
            <p v-if="!home.me" class="rv-notice" data-testid="no-profile">
                Le jeton ne permet pas de savoir qui tu es : tes PR et tes relectures ne peuvent pas être repérées.
                Ajoute le droit <code>read:user:bitbucket</code> au jeton (<RouterLink to="/settings">réglages</RouterLink>).
            </p>
            <template v-for="group in visibleGroups" :key="group.key">
                <details v-if="group.key === 'others'" class="rv-list" :data-group="group.key" :open="!home.me">
                    <summary class="rv-lgrp">{{ group.title }} <span class="cnt">· {{ group.prs.length }}</span></summary>
                    <PrCardRow v-for="card in group.prs" :key="`${card.workspace}/${card.repo}/${card.id}`" :card="card" :group-key="group.key" :me="home.me" />
                </details>
                <section v-else class="rv-list" :data-group="group.key">
                    <div class="rv-lgrp">{{ group.title }} <span class="cnt">· {{ group.prs.length }}</span></div>
                    <PrCardRow v-for="card in group.prs" :key="`${card.workspace}/${card.repo}/${card.id}`" :card="card" :group-key="group.key" :me="home.me" />
                </section>
            </template>
            <div v-if="!home.repos.length" class="rv-panel-msg" data-testid="no-repos">
                <h2>Aucun dépôt suivi</h2>
                <p>Choisis les dépôts Bitbucket dont les PR ouvertes apparaîtront ici : <RouterLink to="/settings">réglages</RouterLink>.</p>
            </div>
            <div v-else-if="!visibleGroups.length" class="rv-panel-msg">
                <h2>Aucune PR ouverte</h2>
                <p>Aucune PR ouverte sur les dépôts configurés. <RouterLink to="/settings">Modifier la liste des dépôts</RouterLink>.</p>
            </div>
        </template>
    </main>
</template>
