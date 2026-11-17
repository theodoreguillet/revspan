<script setup lang="ts">
// Go to definition: the choice between several definitions (under the click, keyboard navigable, Escape closes) and
// the notice at the bottom of the window (back chip, not found, import with "open the definition in <file>").
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { usePrPage } from '../composables/usePrPage.ts';
import { t } from '../i18n/index.ts';
import { MINUS } from '../lib/format.ts';
import { lineNumber } from '../lib/goto-definition.ts';

const page = usePrPage();
const goto = computed(() => page.goto);
const box = ref<HTMLElement | null>(null);
/** Place of the choice in the window: under the clicked row, above it when there is no room below. */
const place = ref<{ left: number; top: number } | null>(null);
const MARGIN = 8;

const items = (): HTMLElement[] => [...(box.value?.querySelectorAll<HTMLElement>('[data-goto-item]') ?? [])];

function onOutside(event: Event): void {
    if (box.value && event.target instanceof Node && !box.value.contains(event.target)) {
        page.goto.closeChoice();
    }
}

function close(): void {
    page.goto.closeChoice();
}

/**
 * Open choice: a click or a scroll by the user outside it (wheel, touch: not the page settling its own layout) or a
 * resize close it.
 */
function listen(on: boolean): void {
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('mousedown', onOutside, true);
    window[method]('wheel', onOutside, { passive: true } as AddEventListenerOptions);
    window[method]('touchmove', onOutside, { passive: true } as AddEventListenerOptions);
    window[method]('resize', close);
}

watch(() => page.goto.choice, async (choice, previous) => {
    if (!choice) {
        place.value = null;
        if (previous) {
            listen(false);
        }
        return;
    }
    if (!previous) {
        listen(true);
    }
    place.value = { left: choice.x, top: choice.bottom + 2 };
    await nextTick();
    const rect = box.value?.getBoundingClientRect();
    if (!rect) {
        return;
    }
    const left = Math.max(MARGIN, Math.min(choice.x - 12, window.innerWidth - rect.width - MARGIN));
    const below = choice.bottom + 2;
    const top = below + rect.height <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, choice.top - rect.height - 2);
    place.value = { left, top };
    items()[0]?.focus();
});

onBeforeUnmount(() => {
    if (page.goto.choice) {
        listen(false);
        page.goto.closeChoice();
    }
});

/** ↑ ↓ Home End move between the definitions; Escape closes; Tab leaves (and closes). */
function onKey(event: KeyboardEvent): void {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[event.key];
    if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') {
            event.preventDefault();
        }
        event.stopPropagation();
        close();
    } else if (next !== undefined && list.length) {
        event.preventDefault();
        event.stopPropagation();
        list[(next + list.length) % list.length]?.focus();
    }
}

function openOffer(event: MouseEvent): void {
    void page.goto.openOffer((event.currentTarget as HTMLElement).getBoundingClientRect());
}

const option = computed(() => t('diff.wholeFile'));
const message = computed((): string => {
    const notice = page.goto.notice;
    switch (notice?.message) {
        case 'notFound':
            return notice.file ? t('goto.notFoundIn', { name: notice.name, file: notice.file }) : t('goto.notFound');
        case 'atImport':
            return t('goto.atImport', { name: notice.name });
        case 'notShown':
            return t('goto.notShown', { name: notice.name });
        default:
            return '';
    }
});
</script>

<template>
    <div
        v-if="goto.choice && place"
        ref="box"
        class="rv-goto-pop"
        role="menu"
        data-goto-choice
        :aria-label="t('goto.choose', { name: goto.choice.name })"
        :style="{ left: `${place.left}px`, top: `${place.top}px` }"
        @keydown="onKey"
    >
        <div class="hd">{{ t('goto.choose', { name: goto.choice.name }) }}</div>
        <button
            v-for="(item, k) in goto.choice.targets"
            :key="k"
            type="button"
            role="menuitem"
            class="it"
            :data-goto-item="k"
            :data-path="item.path"
            :data-line="lineNumber(item)"
            :title="item.side === 'old' ? t('goto.removedLine') : undefined"
            @click="page.goto.choose(item)"
        >
            <span class="loc">{{ item.path }}:{{ item.side === 'old' ? MINUS : '' }}{{ lineNumber(item) }}</span>
            <code class="txt">{{ item.line.text.trim() }}</code>
        </button>
    </div>
    <div
        v-if="goto.notice"
        class="rv-goto-bar"
        role="status"
        data-goto-notice
        @mouseenter="page.goto.holdNotice(true)"
        @mouseleave="page.goto.holdNotice(false)"
    >
        <span v-if="message" class="msg">{{ message }}</span>
        <span v-if="goto.notice.hint" class="hint">{{ t('goto.wholeFileHint', { option }) }}</span>
        <button
            v-if="goto.notice.offer"
            type="button"
            class="rv-btn rv-btn-sm"
            data-goto-offer
            :title="t('goto.openInTitle', { option, name: goto.notice.offer.name, file: goto.notice.offer.file })"
            @click="openOffer"
        >
            {{ t('goto.openIn', { file: goto.notice.offer.file }) }}
        </button>
        <button v-if="goto.notice.back" type="button" class="rv-btn rv-btn-sm" data-goto-back :title="t('goto.backTitle')" @click="page.goto.back()">
            {{ t('goto.back') }}
        </button>
    </div>
</template>
