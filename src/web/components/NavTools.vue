<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { t } from '../i18n/index.ts';
import { openShortcuts } from '../composables/useShortcuts.ts';
</script>

<template>
    <button class="rv-ic" type="button" :title="t('nav.shortcutsTitle')" :aria-label="t('nav.shortcuts')" @click="openShortcuts()">?</button>
    <RouterLink class="rv-ic" to="/settings" :title="t('common.settings')" :aria-label="t('common.settings')">⚙</RouterLink>
</template>
