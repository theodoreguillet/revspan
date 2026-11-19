import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { PrDetail } from '../../src/shared/api.ts';
import { locale, setLocale } from '../../src/web/i18n/index.ts';
import { providePrPage } from '../../src/web/composables/usePrPage.ts';
import DescriptionTab from '../../src/web/components/DescriptionTab.vue';
import { prLong } from './fixtures.ts';

const { api } = vi.hoisted(() => ({ api: { pr: vi.fn(), summary: vi.fn(), compare: vi.fn() } }));
vi.mock('../../src/web/services/api.ts', async (importOriginal) => ({ ...await importOriginal<object>(), api }));
vi.mock('../../src/web/composables/useErrors.ts', () => ({ showError: vi.fn() }));

const ref = { workspace: 'acme', repo: 'records-api', id: 212 };

const initialLocale = locale.value;

describe('description tab', () => {
    let unmount: () => void = () => undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        api.summary.mockReturnValue(new Promise(() => undefined));
        api.pr.mockReturnValue(new Promise(() => undefined));
        api.compare.mockReturnValue(new Promise(() => undefined));
    });

    afterEach(() => {
        unmount();
        setLocale(initialLocale);
    });

    async function mountTab(descriptionHtml: string): Promise<HTMLElement> {
        const base: PrDetail = prLong().data;
        const detail: PrDetail = { ...base, pr: { ...base.pr, descriptionHtml } };
        const Root = defineComponent({
            setup() {
                providePrPage(ref, detail);
                return () => h(DescriptionTab);
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

    it('renders the sanitized HTML: script and handlers stripped, link kept with rel', async () => {
        const root = await mountTab('<p onclick="x()">Why</p><script>alert(1)</script><ul><li>one</li></ul><a href="https://e.x/a">link</a>');
        expect(root.querySelector('script')).toBeNull();
        expect(root.querySelector('[onclick]')).toBeNull();
        expect(root.querySelector('li')?.textContent).toBe('one');
        const link = root.querySelector('a');
        expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
        expect(root.querySelector('[data-description="empty"]')).toBeNull();
    });

    it('says there is no description when empty', async () => {
        setLocale('fr');
        const fr = await mountTab('');
        expect(fr.querySelector('[data-description="empty"]')?.textContent?.trim()).toBe('Pas de description.');
        unmount();
        setLocale('en');
        const en = await mountTab('   ');
        expect(en.querySelector('[data-description="empty"]')?.textContent?.trim()).toBe('No description.');
    });
});
