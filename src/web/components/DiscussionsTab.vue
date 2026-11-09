<script setup lang="ts">
import { computed } from 'vue';
import { usePrPage } from '../composables/usePrPage.ts';
import { t } from '../i18n/index.ts';
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
            <div class="rv-dgrp" data-group="new">{{ t('disc.new', { count: groups.fresh.length }) }}</div>
            <DiscussionItem v-for="thread in groups.fresh" :key="thread.id" :thread="thread" />
        </template>
        <template v-if="groups.open.length">
            <div class="rv-dgrp" data-group="open">{{ t('disc.open', { count: groups.open.length }) }}</div>
            <DiscussionItem v-for="thread in groups.open" :key="thread.id" :thread="thread" />
        </template>
        <details v-if="groups.resolved.length" data-group="resolved">
            <summary class="rv-dgrp">{{ t('disc.resolved', { count: groups.resolved.length }) }}</summary>
            <DiscussionItem v-for="thread in groups.resolved" :key="thread.id" :thread="thread" />
        </details>
        <div v-if="!total" class="rv-empty">{{ t('disc.empty') }}</div>
        <p class="note">{{ t('disc.total', { count: total }) }}</p>
    </div>
</template>

<style scoped>
.note { color: var(--text-secondary); font-size: 11.5px; margin-top: 18px; }
</style>
