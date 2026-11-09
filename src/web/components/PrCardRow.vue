<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { HomeGroupKey, PrCard, User } from '../../shared/api.ts';
import { tr } from '../i18n/index.ts';
import { cardBadges, cardSubtitle } from '../lib/home.ts';
import { prRoute } from '../lib/prUrl.ts';

const props = defineProps<{ card: PrCard; groupKey: HomeGroupKey; me: User | null }>();

const badges = computed(() => cardBadges(tr(), props.card, props.groupKey, props.me));
const subtitle = computed(() => cardSubtitle(tr(), props.card, props.me));
</script>

<template>
    <RouterLink class="rv-row" :to="prRoute(card)" :data-pr="`${card.workspace}/${card.repo}/${card.id}`">
        <div class="t">
            <div class="ti" :title="`${card.repo} #${card.id} · ${card.title}`"><span class="ref">{{ card.repo }} #{{ card.id }}</span>{{ card.title }}</div>
            <div class="su">{{ subtitle }}</div>
        </div>
        <div class="badges">
            <span v-for="badge in badges" :key="badge.text" :class="['rv-nb', badge.tone]">{{ badge.text }}</span>
        </div>
    </RouterLink>
</template>
