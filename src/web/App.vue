<script setup lang="ts">
import { RouterView } from 'vue-router';
import ErrorBanner from './components/ErrorBanner.vue';
import ShortcutsOverlay from './components/ShortcutsOverlay.vue';
import { useKeyboard } from './composables/useKeyboard.ts';
import { openShortcuts } from './composables/useShortcuts.ts';

useKeyboard((key) => {
    if (key === '?') {
        openShortcuts();
        return true;
    }
    return false;
});
</script>

<template>
    <!-- The key = the path: changing PR recreates the page, changing the range (?from=&to=) does not. -->
    <RouterView v-slot="{ Component, route }">
        <component :is="Component" :key="route.path" />
    </RouterView>
    <ErrorBanner />
    <ShortcutsOverlay />
</template>
