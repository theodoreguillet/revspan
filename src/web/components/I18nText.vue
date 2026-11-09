<script setup lang="ts">
// Translated sentence with embedded markup: each named slot fills the placeholder of the same name
// (« Add the {scope} scope… » with <template #scope><code>…</code></template>), in any language's word order.
import { computed, useSlots } from 'vue';
import { tr, type MessageKey } from '../i18n/index.ts';

const props = withDefaults(defineProps<{ k: MessageKey; params?: Record<string, string | number> }>(), { params: () => ({}) });
const slots = useSlots();

interface SlotRef {
    slot: string;
}

const parts = computed(() => {
    const values: Record<string, string | number | SlotRef> = { ...props.params };
    for (const name of Object.keys(slots)) {
        values[name] = { slot: name };
    }
    return tr().parts<MessageKey, SlotRef>(props.k, values as never);
});
</script>

<template>
    <template v-for="(part, i) in parts" :key="i">
        <template v-if="typeof part === 'string'">{{ part }}</template>
        <slot v-else :name="part.slot" />
    </template>
</template>
