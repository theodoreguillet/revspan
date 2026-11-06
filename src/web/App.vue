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
    <!-- La clé = le chemin : changer de PR recrée la page, changer de plage (?from=&to=) non. -->
    <RouterView v-slot="{ Component, route }">
        <component :is="Component" :key="route.path" />
    </RouterView>
    <ErrorBanner />
    <ShortcutsOverlay />
</template>
