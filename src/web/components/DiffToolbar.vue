<script setup lang="ts">
import { usePrPage } from '../composables/usePrPage.ts';
import { t } from '../i18n/index.ts';

const page = usePrPage();

const VIEWS = [['unified', 'diff.unified'], ['split', 'diff.split']] as const;
</script>

<template>
    <div class="rv-dtb">
        <span class="rv-seg" role="group" :aria-label="t('diff.views')">
            <button
                v-for="[key, label] in VIEWS"
                :key="key"
                type="button"
                :class="{ on: page.view === key }"
                :aria-pressed="page.view === key"
                :data-seg="key"
                @click="page.view = key"
            >
                {{ t(label) }}
            </button>
        </span>
        <span>{{ t('diff.context') }}</span>
        <span class="rv-seg" role="group" :aria-label="t('diff.contextLabel')">
            <button type="button" :class="{ on: !page.fullContext }" :aria-pressed="!page.fullContext" data-seg="3" @click="page.fullContext = false">{{ t('diff.contextLines') }}</button>
            <button type="button" :class="{ on: page.fullContext }" :aria-pressed="page.fullContext" data-seg="full" @click="page.fullContext = true">{{ t('diff.wholeFile') }}</button>
        </span>
        <label><input id="show-resolved" v-model="page.showResolved" type="checkbox"> {{ t('diff.showResolved') }}</label>
        <span v-if="!page.canInlineComment" class="note">
            {{ page.detail.pr.state === 'OPEN' ? t('diff.inlineLatestOnly') : t('diff.inlineClosed') }}
        </span>
    </div>
</template>
