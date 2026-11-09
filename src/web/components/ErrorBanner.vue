<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { t } from '../i18n/index.ts';
import { AUTH_CODES } from '../services/api.ts';
import { alerts, dismissError } from '../composables/useErrors.ts';
</script>

<template>
    <div class="rv-alerts" role="alert" aria-live="assertive">
        <div v-for="alert in alerts" :key="alert.id" class="rv-alert" :data-code="alert.code ?? ''">
            <div class="msg">
                {{ alert.message }}
                <span v-if="alert.code && !AUTH_CODES.has(alert.code) && alert.code !== 'NETWORK'" class="code">{{ alert.code }}</span>
                <template v-if="alert.code && AUTH_CODES.has(alert.code)">
                    {{ ' ' }}<RouterLink to="/settings" @click="dismissError(alert.id)">{{ t('common.openSettings') }}</RouterLink>
                </template>
            </div>
            <button type="button" :title="t('common.close')" :aria-label="t('common.close')" @click="dismissError(alert.id)">✕</button>
        </div>
    </div>
</template>
