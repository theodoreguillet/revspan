<script setup lang="ts">
// Destructive action button. On the web: the browser's confirm(). In a VS Code panel, dialog boxes
// are blocked: a first click arms the button ("Confirm?"), a second click within 4 s runs the action.
import { onBeforeUnmount, ref } from 'vue';
import { t } from '../i18n/index.ts';
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
    <button type="button" :class="{ armed }" :title="question" @click="onClick">{{ armed ? t('common.confirm') : label }}</button>
</template>
