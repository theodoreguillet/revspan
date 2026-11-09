<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { t } from '../i18n/index.ts';
import { openShortcuts } from '../composables/useShortcuts.ts';
import UrlInput from './UrlInput.vue';

export interface Crumb {
    text: string;
    cur?: boolean;
}

withDefaults(defineProps<{ crumbs?: Crumb[] }>(), { crumbs: () => [] });
</script>

<template>
    <nav class="rv-nav">
        <RouterLink class="home" to="/">Revspan</RouterLink>
        <template v-for="crumb in crumbs" :key="crumb.text">
            <span aria-hidden="true">›</span>
            <span :class="['crumb', { cur: crumb.cur }]">{{ crumb.text }}</span>
        </template>
        <span class="sp" />
        <UrlInput />
        <button class="rv-ic" type="button" :title="t('nav.shortcutsTitle')" :aria-label="t('nav.shortcuts')" @click="openShortcuts()">?</button>
        <RouterLink class="rv-ic" to="/settings" :title="t('common.settings')" :aria-label="t('common.settings')">⚙</RouterLink>
    </nav>
</template>
