// Global error banner (API errors), shared by the whole application.
import { readonly, ref } from 'vue';
import { errorInfo, type ApiErrorCode } from '../services/api.ts';

export interface Alert {
    id: number;
    message: string;
    code: ApiErrorCode | null;
}

const MAX_ALERTS = 3;
const list = ref<Alert[]>([]);
let nextId = 1;

/** Alerts shown (read-only; change through showError / dismissError / clearErrors). */
export const alerts = readonly(list);

export function showError(error: unknown): void {
    const { message, code } = errorInfo(error);
    if (list.value.some((a) => a.message === message)) {
        return;
    }
    list.value = [...list.value, { id: nextId++, message, code }].slice(-MAX_ALERTS);
}

export function dismissError(id: number): void {
    list.value = list.value.filter((a) => a.id !== id);
}

export function clearErrors(): void {
    list.value = [];
}
