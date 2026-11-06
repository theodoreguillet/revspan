// Préférence locale mémorisée dans localStorage (confort seulement : indisponible en navigation privée).
import { ref, watch, type Ref } from 'vue';

const PREFIX = 'strata:';

function read<T>(key: string, fallback: T, isValid: (value: unknown) => value is T): T {
    try {
        const raw = localStorage.getItem(PREFIX + key);
        if (raw == null) {
            return fallback;
        }
        const value: unknown = JSON.parse(raw);
        return isValid(value) ? value : fallback;
    } catch {
        return fallback;
    }
}

export function useLocalPref<T>(key: string, fallback: T, isValid: (value: unknown) => value is T): Ref<T> {
    const pref = ref(read(key, fallback, isValid)) as Ref<T>;
    watch(pref, (value) => {
        try {
            localStorage.setItem(PREFIX + key, JSON.stringify(value));
        } catch {
            // stockage indisponible : préférence non mémorisée
        }
    });
    return pref;
}

export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
