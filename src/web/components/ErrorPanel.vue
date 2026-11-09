<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { t } from '../i18n/index.ts';
import { AUTH_CODES, errorInfo } from '../services/api.ts';

const props = withDefaults(defineProps<{ error: unknown; homeLink?: boolean }>(), { homeLink: false });
const info = computed(() => errorInfo(props.error));
const auth = computed(() => !!info.value.code && AUTH_CODES.has(info.value.code));
</script>

<template>
    <div class="rv-panel-msg">
        <h2>{{ auth ? t('error.authTitle') : t('error.title') }}</h2>
        <p>{{ info.message }}</p>
        <p v-if="auth"><RouterLink to="/settings">{{ t('common.openSettings') }}</RouterLink></p>
        <p v-if="homeLink"><RouterLink to="/">{{ t('error.backHome') }}</RouterLink></p>
    </div>
</template>
