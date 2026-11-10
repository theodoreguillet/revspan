<script setup lang="ts">
// Build state of a PR: a pill on the home rows, or the compact header button that opens the Builds tab.
import { computed } from 'vue';
import type { BuildSummary } from '../../shared/api.ts';
import { t, tr } from '../i18n/index.ts';
import { buildHeaderText, buildRowText } from '../lib/build.ts';

const props = defineProps<{ build: BuildSummary; variant: 'row' | 'header' }>();
defineEmits<{ open: [] }>();

const text = computed(() => (props.variant === 'header' ? buildHeaderText(tr(), props.build) : buildRowText(tr(), props.build)));
</script>

<template>
    <template v-if="build.state !== 'none'">
        <button
            v-if="variant === 'header'"
            type="button"
            :class="['rv-bbadge', build.state]"
            :data-build="build.state"
            :title="t('build.headTitle')"
            @click="$emit('open')"
        >
            <span v-if="build.state === 'running'" class="rv-spin" aria-hidden="true" />{{ text }}
        </button>
        <span v-else :class="['rv-build', build.state]" :data-build="build.state">
            <span v-if="build.state === 'running'" class="rv-spin" aria-hidden="true" />{{ text }}
        </span>
    </template>
</template>
