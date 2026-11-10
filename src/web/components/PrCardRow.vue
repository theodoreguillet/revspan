<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { PrCard, User } from '../../shared/api.ts';
import { t, tr } from '../i18n/index.ts';
import { cardBadges, cardSubtitle } from '../lib/home.ts';
import { prRoute } from '../lib/prUrl.ts';
import BuildBadge from './BuildBadge.vue';

const props = defineProps<{ card: PrCard; me: User | null; followBusy?: boolean }>();
const emit = defineEmits<{ follow: [user: User, follow: boolean] }>();

const badges = computed(() => cardBadges(tr(), props.card, props.me));
const subtitle = computed(() => cardSubtitle(tr(), props.card, props.me));
const prKey = computed(() => `${props.card.workspace}/${props.card.repo}/${props.card.id}`);
/** Author one can follow: known, and not me. */
const author = computed(() => (props.card.author && props.card.author.uuid !== props.me?.uuid ? props.card.author : null));

// Row menu: fixed position under its button, so the rounded list (overflow hidden) does not clip it.
const root = ref<HTMLElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const menu = ref<{ top: number; right: number } | null>(null);
const item = ref<HTMLButtonElement | null>(null);

function onOutside(event: Event): void {
    if (!(event.target instanceof Node) || !root.value?.contains(event.target)) {
        closeMenu();
    }
}

function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
        closeMenu();
        button.value?.focus();
    }
}

function listen(on: boolean): void {
    if (on) {
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', closeMenu, true);
        window.addEventListener('resize', closeMenu);
    } else {
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', closeMenu, true);
        window.removeEventListener('resize', closeMenu);
    }
}

function closeMenu(): void {
    if (menu.value) {
        menu.value = null;
        listen(false);
    }
}

function toggleMenu(): void {
    if (menu.value) {
        closeMenu();
        return;
    }
    const rect = button.value?.getBoundingClientRect();
    if (!rect) {
        return;
    }
    menu.value = { top: rect.bottom + 4, right: window.innerWidth - rect.right };
    listen(true);
    void nextTick(() => item.value?.focus());
}

function pick(): void {
    closeMenu();
    if (author.value) {
        emit('follow', author.value, !props.card.followed);
    }
}

onBeforeUnmount(closeMenu);
</script>

<template>
    <div ref="root" :class="['rv-roww', { 'has-menu': author }]" :data-row="prKey">
        <RouterLink class="rv-row" :to="prRoute(card)" :data-pr="prKey">
            <div class="t">
                <div class="ti" :title="`${card.repo} #${card.id} · ${card.title}`">
                    <span v-if="card.followed" class="rv-star" :title="t('home.followedMark')">★</span><span class="ref">{{ card.repo }} #{{ card.id }}</span>{{ card.title }}
                </div>
                <div class="su">{{ subtitle }}</div>
                <div v-if="card.approvalHolds" class="su hold">{{ t('home.approvalHolds') }}</div>
            </div>
            <div class="badges">
                <span v-if="card.needsRebase" class="rv-nb orange" data-chip="needs-rebase">{{ t('home.needsRebase') }}</span>
                <span v-if="card.designatedReviewer" class="rv-nb" data-chip="designated">{{ t('home.designated') }}</span>
                <span v-for="badge in badges" :key="badge.text" :class="['rv-nb', badge.tone]">{{ badge.text }}</span>
                <BuildBadge v-if="card.build" :build="card.build" variant="row" />
            </div>
        </RouterLink>
        <template v-if="author">
            <button
                ref="button"
                type="button"
                class="rv-row-more"
                aria-haspopup="menu"
                :aria-expanded="!!menu"
                :aria-label="t('home.rowMenu')"
                :title="t('home.rowMenu')"
                @click="toggleMenu"
            >
                ⋯
            </button>
            <div v-if="menu" class="rv-menu" role="menu" :style="{ top: `${menu.top}px`, right: `${menu.right}px` }">
                <button ref="item" type="button" role="menuitem" data-action="follow" :disabled="followBusy" @click="pick">
                    {{ card.followed ? t('home.unfollow', { name: author.displayName }) : t('home.follow', { name: author.displayName }) }}
                </button>
            </div>
        </template>
    </div>
</template>
