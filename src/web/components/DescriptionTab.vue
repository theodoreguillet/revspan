<script setup lang="ts">
// Description tab: the PR description as Bitbucket renders it, sanitized like a comment body.
import { usePrPage } from '../composables/usePrPage.ts';
import { t } from '../i18n/index.ts';
import SafeHtml from './SafeHtml.vue';

const page = usePrPage();
</script>

<template>
    <div class="rv-description">
        <p v-if="!page.detail.pr.descriptionHtml.trim()" class="muted" data-description="empty">{{ t('description.empty') }}</p>
        <SafeHtml v-else :html="page.detail.pr.descriptionHtml" />
    </div>
</template>
