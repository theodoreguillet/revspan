<script setup lang="ts">
// News found on Bitbucket by the periodic check: the page never changes by itself, the button refreshes it.
import { computed } from 'vue';
import type { PulseView } from '../composables/usePulse.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { t, tr } from '../i18n/index.ts';
import { pulseText } from '../lib/pulse.ts';

const props = defineProps<{ pulse: PulseView }>();
const page = usePrPage();
const text = computed(() => (props.pulse.news ? pulseText(tr(), props.pulse.news) : ''));
</script>

<template>
    <div class="rv-pulse-live" aria-live="polite">
        <div v-if="pulse.news" class="rv-pulse" data-banner="pulse">
            <span class="msg">{{ text }}</span>
            <button
                type="button"
                :class="['rv-btn', { busy: page.refreshing }]"
                data-action="pulse-refresh"
                :disabled="page.refreshing"
                :aria-busy="page.refreshing"
                @click="pulse.refresh()"
            >
                {{ t('pulse.refresh') }}
            </button>
            <button type="button" class="x" data-action="pulse-dismiss" :title="t('pulse.dismiss')" :aria-label="t('pulse.dismiss')" @click="pulse.dismiss()">✕</button>
        </div>
    </div>
</template>
