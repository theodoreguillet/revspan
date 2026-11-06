<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { AUTH_CODES, errorInfo } from '../services/api.ts';

const props = withDefaults(defineProps<{ error: unknown; homeLink?: boolean }>(), { homeLink: false });
const info = computed(() => errorInfo(props.error));
const auth = computed(() => !!info.value.code && AUTH_CODES.has(info.value.code));
</script>

<template>
    <div class="rv-panel-msg">
        <h2>{{ auth ? 'Connexion à Bitbucket impossible' : 'Impossible de charger cette page' }}</h2>
        <p>{{ info.message }}</p>
        <p v-if="auth"><RouterLink to="/settings">Ouvrir les réglages</RouterLink></p>
        <p v-if="homeLink"><RouterLink to="/">Retour à l'accueil</RouterLink></p>
    </div>
</template>
