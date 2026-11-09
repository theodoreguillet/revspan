<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { closeShortcuts, SHORTCUTS, shortcutsOpen } from '../composables/useShortcuts.ts';
import { trappedFocus } from '../lib/keyboard.ts';

const dialog = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
/** Élément qui avait le focus à l'ouverture (bouton « ? » de la barre…) : il le retrouve à la fermeture. */
let opener: HTMLElement | null = null;

// capture : l'overlay ouvert intercepte Échap et ? avant les raccourcis de la page, et garde le focus (aria-modal)
function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault();
        event.stopPropagation();
        closeShortcuts();
    } else if (event.key === 'Tab' && dialog.value) {
        const target = trappedFocus(dialog.value, document.activeElement, event.shiftKey);
        if (target) {
            event.preventDefault();
            target.focus();
        }
    }
}

watch(shortcutsOpen, async (open) => {
    if (open) {
        opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        document.addEventListener('keydown', onKey, true);
        await nextTick();
        closeButton.value?.focus();
    } else {
        document.removeEventListener('keydown', onKey, true);
        if (opener?.isConnected) {
            opener.focus();
        }
        opener = null;
    }
});

onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true));
</script>

<template>
    <div
        v-if="shortcutsOpen"
        ref="dialog"
        class="rv-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Raccourcis clavier"
        tabindex="-1"
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
