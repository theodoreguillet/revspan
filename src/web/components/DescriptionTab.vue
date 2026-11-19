<script setup lang="ts">
// Description tab: the PR description as Bitbucket renders it, sanitized like a comment body.
import { computed } from 'vue';
import { usePrPage } from '../composables/usePrPage.ts';
import { t } from '../i18n/index.ts';
import SafeHtml from './SafeHtml.vue';

const page = usePrPage();
// absent from a detail served by an older CLI server (still running after `git pull && npm run build`)
const html = computed(() => (page.detail.pr.descriptionHtml as string | undefined) ?? '');
</script>

<template>
    <div class="rv-description">
        <p v-if="!html.trim()" class="muted" data-description="empty">{{ t('description.empty') }}</p>
        <SafeHtml v-else :html="html" />
    </div>
</template>
