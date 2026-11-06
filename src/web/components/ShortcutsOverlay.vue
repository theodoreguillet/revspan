<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { closeShortcuts, SHORTCUTS, shortcutsOpen } from '../composables/useShortcuts.ts';

const closeButton = ref<HTMLButtonElement | null>(null);

// capture : l'overlay ouvert intercepte Échap et ? avant les raccourcis de la page
function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault();
        event.stopPropagation();
        closeShortcuts();
    }
}

watch(shortcutsOpen, async (open) => {
    if (open) {
        document.addEventListener('keydown', onKey, true);
        await nextTick();
        closeButton.value?.focus();
    } else {
        document.removeEventListener('keydown', onKey, true);
    }
});

onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true));
</script>

<template>
    <div
        v-if="shortcutsOpen"
        class="rv-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Raccourcis clavier"
        @click.self="closeShortcuts()"
    >
        <div class="box">
            <h2>Raccourcis clavier</h2>
            <table>
                <tbody>
                    <tr v-for="[keys, label] in SHORTCUTS" :key="keys">
                        <td>
                            <template v-for="(k, i) in keys.split(' / ')" :key="k">
                                <template v-if="i">{{ ' / ' }}</template><kbd>{{ k }}</kbd>
                            </template>
                        </td>
                        <td>{{ label }}</td>
                    </tr>
                </tbody>
            </table>
            <div class="foot">
                <button ref="closeButton" class="rv-btn" type="button" @click="closeShortcuts()">Fermer</button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.foot { text-align: right; margin-top: 10px; }
</style>
