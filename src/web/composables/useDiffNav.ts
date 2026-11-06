// Navigation sous la frise collante : les composants déclarent leurs éléments (fichiers, onglets, fils),
// ce module fait défiler vers eux et suit le fichier courant. Aucune recherche par sélecteur CSS.
import { ref } from 'vue';

export interface ThreadEntry {
    threadId: number;
    /** Fil affiché dans le diff (et non dans l'onglet Discussions). */
    inDiff: boolean;
}

/** Fait défiler pour placer el à `offset` px du haut de la fenêtre. */
function scrollToElement(el: Element, offset: number): void {
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset });
}

/** Met brièvement en évidence un élément (fil atteint au clavier, « Voir dans le diff »). */
function flash(el: HTMLElement): void {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
}

const isVisible = (el: HTMLElement): boolean => el.offsetParent !== null;

export function useDiffNav() {
    /** Hauteur de la frise collante (mesurée par Timeline). */
    const tlHeight = ref(0);
    /** Index du fichier courant dans la liste du diff. */
    const curFile = ref(0);
    const files = new Map<string, HTMLElement>();
    const threads = new Map<HTMLElement, ThreadEntry>();
    let tabs: HTMLElement | null = null;

    function registerFile(path: string, el: HTMLElement | null): void {
        if (el) {
            files.set(path, el);
        } else {
            files.delete(path);
        }
    }

    function registerTabs(el: HTMLElement | null): void {
        tabs = el;
    }

    function registerThread(el: HTMLElement, entry: ThreadEntry): void {
        threads.set(el, entry);
    }

    function unregisterThread(el: HTMLElement): void {
        threads.delete(el);
    }

    function scrollToFile(path: string): void {
        const el = files.get(path);
        if (el) {
            scrollToElement(el, tlHeight.value + 6);
        }
    }

    /** Un fichier qu'on vient de replier ne doit pas laisser la page plus bas que lui. */
    function keepFileInView(path: string): void {
        const el = files.get(path);
        if (el && el.getBoundingClientRect().top < tlHeight.value) {
            scrollToElement(el, tlHeight.value + 6);
        }
    }

    /** Après un changement de plage : remonte en haut des onglets si on lisait plus bas. */
    function scrollToTabsIfBelow(): void {
        if (!tabs) {
            return;
        }
        const top = tabs.getBoundingClientRect().top + window.scrollY - tlHeight.value;
        if (window.scrollY > top) {
            window.scrollTo({ top });
        }
    }

    /** Index (dans `paths`) du dernier fichier dont l'en-tête est passé sous la frise. */
    function fileUnderTimeline(paths: string[]): number {
        const limit = tlHeight.value + 48;
        let cur = 0;
        paths.forEach((path, idx) => {
            const el = files.get(path);
            if (el && el.getBoundingClientRect().top <= limit) {
                cur = idx;
            }
        });
        return cur;
    }

    /** Fil suivant (1) ou précédent (-1) par rapport à la ligne de lecture, sous les en-têtes collants. */
    function nextThread(dir: 1 | -1): void {
        const y = tlHeight.value + 60;
        const ordered = [...threads.keys()]
            .filter(isVisible)
            .map((el) => ({ el, top: el.getBoundingClientRect().top }))
            .sort((a, b) => a.top - b.top);
        const target = dir > 0 ? ordered.find((t) => t.top > y + 2) : ordered.reverse().find((t) => t.top < y - 2);
        if (target) {
            window.scrollBy({ top: target.top - y });
            flash(target.el);
        }
    }

    /** Fait défiler jusqu'au fil dans le diff et le met en évidence. */
    function revealThread(threadId: number): void {
        for (const [el, entry] of threads) {
            if (entry.inDiff && entry.threadId === threadId) {
                scrollToElement(el, tlHeight.value + 60);
                flash(el);
                return;
            }
        }
    }

    return {
        tlHeight, curFile,
        registerFile, registerTabs, registerThread, unregisterThread,
        scrollToFile, keepFileInView, scrollToTabsIfBelow, fileUnderTimeline, nextThread, revealThread,
    };
}
