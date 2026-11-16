<script setup lang="ts">
import { RouterLink } from 'vue-router';
import NavTools from './NavTools.vue';
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
        <NavTools />
    </nav>
</template>
