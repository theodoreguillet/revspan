// Local preference remembered in localStorage (comfort only: unavailable in private browsing).
import { ref, watch, type Ref } from 'vue';

const PREFIX = 'revspan:';

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
            // storage unavailable: preference not remembered
        }
    });
    return pref;
}

export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
