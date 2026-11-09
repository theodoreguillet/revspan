import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrDetail } from '../../src/shared/api.ts';
import { usePrLoad } from '../../src/web/composables/usePrLoad.ts';
import { prLong } from './fixtures.ts';

const { api, showError } = vi.hoisted(() => ({
    api: { pr: vi.fn(), approve: vi.fn() },
    showError: vi.fn(),
}));
vi.mock('../../src/web/services/api.ts', () => ({ api }));
vi.mock('../../src/web/composables/useErrors.ts', () => ({ showError }));

const ref = { workspace: 'acme', repo: 'records-api', id: 212 };

/** Promesse résolue ou rejetée à la main (écriture Bitbucket lente). */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((ok, ko) => {
        resolve = ok;
        reject = ko;
    });
    return { promise, resolve, reject };
}

describe('actions de la page PR : indicateur de chargement', () => {
    let detail: PrDetail;

    beforeEach(() => {
        vi.clearAllMocks();
        detail = prLong().data;
        api.pr.mockResolvedValue(detail);
    });

    it('bouton « en cours » pendant l\'écriture et le rechargement, une seule action à la fois', async () => {
        const load = usePrLoad(ref, detail);
        const write = deferred();
        api.approve.mockReturnValue(write.promise);

        const running = load.act(() => api.approve(ref, true), { key: 'approve' });
        expect(load.pendingAction.value).toBe('approve');
        expect(load.busy('approve')).toBe(true);
        expect(load.busy('request-changes')).toBe(false);
        expect(load.acting.value).toBe(true);
        expect(await load.act(() => api.approve(ref, false), { key: 'approve' })).toBe(false);

        write.resolve();
        expect(await running).toBe(true);
        expect(api.pr).toHaveBeenCalledTimes(1);
        expect(load.acting.value).toBe(false);
    });

    it('écriture refusée : erreur affichée, bouton libéré, pas de rechargement', async () => {
        const load = usePrLoad(ref, detail);
        const write = deferred();
        const running = load.act(() => write.promise, { key: 'resolve:1' });
        write.reject(new Error('boom'));
        expect(await running).toBe(false);
        expect(showError).toHaveBeenCalledOnce();
        expect(api.pr).not.toHaveBeenCalled();
        expect(load.pendingAction.value).toBeNull();
    });
});
