<script setup lang="ts">
import { usePrPage } from '../composables/usePrPage.ts';

const page = usePrPage();

const VIEWS = [['unified', 'Unifié'], ['split', 'Côte à côte']] as const;
</script>

<template>
    <div class="rv-dtb">
        <span class="rv-seg" role="group" aria-label="Vue du diff">
            <button
                v-for="[key, label] in VIEWS"
                :key="key"
                type="button"
                :class="{ on: page.view === key }"
                :aria-pressed="page.view === key"
                :data-seg="key"
                @click="page.view = key"
            >
                {{ label }}
            </button>
        </span>
        <span>Contexte :</span>
        <span class="rv-seg" role="group" aria-label="Lignes de contexte">
            <button type="button" :class="{ on: !page.fullContext }" :aria-pressed="!page.fullContext" data-seg="3" @click="page.fullContext = false">3 lignes</button>
            <button type="button" :class="{ on: page.fullContext }" :aria-pressed="page.fullContext" data-seg="full" @click="page.fullContext = true">fichier entier</button>
        </span>
        <label><input id="show-resolved" v-model="page.showResolved" type="checkbox"> Afficher les fils résolus</label>
        <span v-if="!page.canInlineComment" class="note">
            {{ page.detail.pr.state === 'OPEN' ? 'Commentaires en ligne : seulement sur la dernière version' : 'PR fermée : commentaires en ligne désactivés' }}
        </span>
    </div>
</template>
