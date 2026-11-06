<script setup lang="ts">
import { computed } from 'vue';
import { usePrPage } from '../composables/usePrPage.ts';
import { plural } from '../lib/format.ts';
import { threadGroups } from '../lib/threads.ts';
import Composer from './Composer.vue';
import DiscussionItem from './DiscussionItem.vue';

const page = usePrPage();
const groups = computed(() => threadGroups(page.detail.threads));
const total = computed(() => page.detail.threads.length);
</script>

<template>
    <div class="rv-disc">
        <Composer />
        <template v-if="groups.fresh.length">
            <div class="rv-dgrp" data-group="new">Nouveaux · {{ groups.fresh.length }}</div>
            <DiscussionItem v-for="t in groups.fresh" :key="t.id" :thread="t" />
        </template>
        <template v-if="groups.open.length">
            <div class="rv-dgrp" data-group="open">Ouverts · {{ groups.open.length }}</div>
            <DiscussionItem v-for="t in groups.open" :key="t.id" :thread="t" />
        </template>
        <details v-if="groups.resolved.length" data-group="resolved">
            <summary class="rv-dgrp">Résolus · {{ groups.resolved.length }}</summary>
            <DiscussionItem v-for="t in groups.resolved" :key="t.id" :thread="t" />
        </details>
        <div v-if="!total" class="rv-empty">Aucune discussion sur cette PR.</div>
        <p class="note">{{ plural(total, 'fil') }} au total. Les réponses « 👍 » sont affichées comme des réactions.</p>
    </div>
</template>

<style scoped>
.note { color: var(--text-secondary); font-size: 11.5px; margin-top: 18px; }
</style>
