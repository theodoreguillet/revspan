<script setup lang="ts">
import { RouterLink } from 'vue-router';
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
        <RouterLink class="home" to="/">Strata</RouterLink>
        <template v-for="crumb in crumbs" :key="crumb.text">
            <span aria-hidden="true">›</span>
            <span :class="['crumb', { cur: crumb.cur }]">{{ crumb.text }}</span>
        </template>
        <span class="sp" />
        <UrlInput />
        <button class="rv-ic" type="button" title="Raccourcis clavier (?)" aria-label="Raccourcis clavier" @click="openShortcuts()">?</button>
        <RouterLink class="rv-ic" to="/settings" title="Réglages" aria-label="Réglages">⚙</RouterLink>
    </nav>
</template>
