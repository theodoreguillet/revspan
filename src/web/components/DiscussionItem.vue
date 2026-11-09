<script setup lang="ts">
import { computed } from 'vue';
import type { Thread } from '../../shared/api.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { t, tr } from '../i18n/index.ts';
import { relTime } from '../lib/format.ts';
import { lastActivity } from '../lib/threads.ts';
import ThreadCard from './ThreadCard.vue';

const props = defineProps<{ thread: Thread }>();
const page = usePrPage();

const placement = computed(() => page.placementOf(props.thread.id));
const last = computed(() => lastActivity(props.thread));
const location = computed(() => {
    const line = props.thread.anchor?.to ?? props.thread.anchor?.from;
    return `${props.thread.path}${line != null ? `:${line}` : ''}`;
});
</script>

<template>
    <div class="rv-ditem" :data-thread="thread.id">
        <div class="loc">
            <span v-if="thread.path" class="p">{{ location }}</span>
            <b v-else>{{ t('disc.general') }}</b>
            <span>{{ t('disc.onVersion', { version: thread.version }) }}</span>
            <span v-if="last">{{ t('disc.lastActivity', { when: relTime(tr(), last) }) }}</span>
            <button v-if="placement" type="button" class="rv-link" data-action="show-in-diff" @click="page.showInDiff(thread.id)">{{ t('disc.showInDiff') }}</button>
        </div>
        <ThreadCard :thread="thread" :placement="placement" context="disc" />
    </div>
</template>
