import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { PrDetail } from '../../src/shared/api.ts';
import { locale, setLocale } from '../../src/web/i18n/index.ts';
import { providePrPage } from '../../src/web/composables/usePrPage.ts';
import PrHeader from '../../src/web/components/PrHeader.vue';
import { prLong } from './fixtures.ts';

const { api, copyText } = vi.hoisted(() => ({
    api: { pr: vi.fn(), summary: vi.fn(), compare: vi.fn(), followed: vi.fn() },
    copyText: vi.fn(),
}));
vi.mock('../../src/web/services/api.ts', async (importOriginal) => ({ ...await importOriginal<object>(), api }));
vi.mock('../../src/web/services/host.ts', async (importOriginal) => ({ ...await importOriginal<object>(), copyText }));
vi.mock('../../src/web/composables/useErrors.ts', () => ({ showError: vi.fn() }));

const ref = { workspace: 'acme', repo: 'records-api', id: 212 };
const pulse = { news: null, status: null, refresh: vi.fn(), dismiss: vi.fn() };
const initialLocale = locale.value;

describe('PR header: draft chip and copy-link button', () => {
    let unmount: () => void = () => undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        api.summary.mockReturnValue(new Promise(() => undefined));
        api.pr.mockReturnValue(new Promise(() => undefined));
        api.compare.mockReturnValue(new Promise(() => undefined));
        api.followed.mockReturnValue(new Promise(() => undefined));
    });

    afterEach(() => {
        unmount();
        vi.useRealTimers();
        setLocale(initialLocale);
    });

    async function mountHeader(patch: Partial<PrDetail['pr']>): Promise<HTMLElement> {
        const base: PrDetail = prLong().data;
        const detail: PrDetail = { ...base, pr: { ...base.pr, ...patch } };
        const Root = defineComponent({
            setup() {
                providePrPage(ref, detail);
                return () => h(PrHeader, { pulse });
            },
        });
        const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/pr/:ws/:repo/:id', name: 'pr', component: Root }] });
        await router.push(`/pr/${ref.workspace}/${ref.repo}/${ref.id}`);
        const root = document.createElement('div');
        const app = createApp(Root).use(router);
        app.mount(root);
        unmount = () => app.unmount();
        await nextTick();
        return root;
    }

    const pill = (root: HTMLElement): HTMLElement => root.querySelector('.rv-pill') as HTMLElement;

    it('an open draft shows "Brouillon" with the draft class instead of "Ouverte"', async () => {
        setLocale('fr');
        const root = await mountHeader({ state: 'OPEN', draft: true });
        expect(pill(root).textContent?.trim()).toBe('Brouillon');
        expect(pill(root).classList.contains('draft')).toBe(true);
        expect(pill(root).classList.contains('OPEN')).toBe(false);
        unmount();
        setLocale('en');
        const en = await mountHeader({ state: 'OPEN', draft: true });
        expect(pill(en).textContent?.trim()).toBe('Draft');
    });

    it('a non-draft open PR and the closed states are unchanged', async () => {
        setLocale('fr');
        const open = await mountHeader({ state: 'OPEN', draft: false });
        expect(pill(open).textContent?.trim()).toBe('● Ouverte');
        expect(pill(open).classList.contains('OPEN')).toBe(true);
        unmount();
        const merged = await mountHeader({ state: 'MERGED', draft: true });
        expect(pill(merged).textContent?.trim()).toBe('Fusionnée');
        expect(pill(merged).classList.contains('draft')).toBe(false);
    });

    it('the copy button copies the PR URL and says so for 1.5 s', async () => {
        setLocale('fr');
        copyText.mockResolvedValue(true);
        const root = await mountHeader({ url: 'https://bitbucket.org/acme/records-api/pull-requests/212' });
        const button = root.querySelector('[data-copy-link]') as HTMLButtonElement;
        expect(button.getAttribute('aria-label')).toBe('Copier le lien de la PR');
        const status = root.querySelector('[data-copy-status]') as HTMLElement;
        expect(status.getAttribute('aria-live')).toBe('polite');
        expect(status.textContent?.trim()).toBe('');
        button.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(copyText).toHaveBeenCalledWith('https://bitbucket.org/acme/records-api/pull-requests/212');
        expect(status.textContent?.trim()).toBe('Lien copié');
        expect(button.title).toBe('Lien copié');
        await vi.advanceTimersByTimeAsync(1499);
        expect(status.textContent?.trim()).toBe('Lien copié');
        await vi.advanceTimersByTimeAsync(2);
        expect(status.textContent?.trim()).toBe('');
        expect(button.title).toBe('Copier le lien de la PR');
    });

    it('a failed copy says "Copie impossible" (English: "Could not copy")', async () => {
        setLocale('en');
        copyText.mockResolvedValue(false);
        const root = await mountHeader({});
        (root.querySelector('[data-copy-link]') as HTMLButtonElement).click();
        await vi.advanceTimersByTimeAsync(0);
        expect(root.querySelector('[data-copy-status]')?.textContent?.trim()).toBe('Could not copy');
        expect(root.querySelector('[data-copy-link]')?.getAttribute('aria-label')).toBe('Copy the PR link');
    });
});
