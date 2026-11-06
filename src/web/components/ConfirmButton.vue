<script setup lang="ts">
// Bouton d'action destructive. Sur le web : confirm() du navigateur. Dans un panneau VS Code, les boîtes de dialogue
// sont bloquées : un premier clic arme le bouton (« Confirmer ? »), un second clic dans les 4 s exécute l'action.
import { onBeforeUnmount, ref } from 'vue';
import { isVsCode } from '../services/host.ts';

const props = defineProps<{ label: string; question: string }>();
const emit = defineEmits<{ confirm: [] }>();

const ARM_DELAY_MS = 4000;
const armed = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function disarm(): void {
    armed.value = false;
    clearTimeout(timer);
}

function onClick(): void {
    if (!isVsCode) {
        if (confirm(props.question)) {
            emit('confirm');
        }
        return;
    }
    if (armed.value) {
        disarm();
        emit('confirm');
        return;
    }
    armed.value = true;
    timer = setTimeout(disarm, ARM_DELAY_MS);
}

onBeforeUnmount(disarm);
</script>

<template>
    <button type="button" :class="{ armed }" :title="question" @click="onClick">{{ armed ? 'Confirmer ?' : label }}</button>
</template>
