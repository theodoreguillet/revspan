import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, effectScope, nextTick, shallowRef, type EffectScope } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { PrDetail } from '../../src/shared/api.ts';
import { useRangeSelection } from '../../src/web/composables/useRangeSelection.ts';
import { makeVersions, prLong, type VersionOptions } from './fixtures.ts';

const prRef = { workspace: 'acme', repo: 'demo-repo', id: 48 };
const Blank = defineComponent({ render: () => null });
let scope: EffectScope | null = null;

afterEach(() => {
    scope?.stop();
    scope = null;
});

function prWith(count: number, lastReviewed: number | null, options: VersionOptions = {}): PrDetail {
    const { data } = prLong();
    return { ...data, versions: makeVersions(count, options), review: { ...data.review, lastReviewed } };
}

/** PR page range on a real router (in-memory history), as under PrLoaded. */
async function setup(initial: PrDetail, query = '') {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/pr/:ws/:repo/:id', name: 'pr', component: Blank }],
    });
    await router.push(`/pr/${prRef.workspace}/${prRef.repo}/${prRef.id}${query}`);
    const app = createApp(Blank).use(router);
    const detail = shallowRef(initial);
    scope = effectScope();
    const range = app.runWithContext(() => scope?.run(() => useRangeSelection(prRef, detail)));
    if (!range) {
        throw new Error('range not created');
    }
    const current = (): [number, number] => [range.from.value, range.to.value];
    const query$ = (): unknown => router.currentRoute.value.query;
    return { router, detail, range, current, query: query$ };
}

describe('PR page version range', () => {
    it('Versions tab: single version = since the last readable one before it (v1 erased: since the base)', async () => {
        const { range, current, query } = await setup(prWith(3, 1, { unavailable: [1] }));
        expect(current()).toEqual([0, 3]);
        range.selectVersion(2);
        expect(current()).toEqual([0, 2]);
        await vi.waitFor(() => expect(query()).toEqual({ from: '0', to: '2' }));
        range.selectVersion(3);
        expect(current()).toEqual([2, 3]);
    });

    it('version discovered erased afterwards (detail reloaded): "from" moves back to the last readable one, URL replaced', async () => {
        const { detail, current, query, router } = await setup(prWith(3, 1));
        expect(current()).toEqual([1, 3]);
        const push = vi.spyOn(router, 'push');
        const replace = vi.spyOn(router, 'replace');
        detail.value = prWith(3, 1, { unavailable: [1] });
        await nextTick();
        expect(current()).toEqual([0, 3]);
        await vi.waitFor(() => expect(query()).toEqual({ from: '0', to: '3' }));
        expect(replace).toHaveBeenCalledOnce();
        expect(push).not.toHaveBeenCalled();
    });

    it('displayed version erased: default range', async () => {
        const { detail, current } = await setup(prWith(6, 3), '?from=1&to=3');
        expect(current()).toEqual([1, 3]);
        detail.value = prWith(6, 3, { unavailable: [3] });
        await nextTick();
        expect(current()).toEqual([2, 6]);
    });

    it('new version pushed: range kept', async () => {
        const { detail, current } = await setup(prWith(3, 1));
        detail.value = prWith(4, 1);
        await nextTick();
        expect(current()).toEqual([1, 3]);
    });
});
