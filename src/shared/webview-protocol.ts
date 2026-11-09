// Messages échangés entre la page (dans un panneau VS Code) et l'extension.
// Hors de VS Code, la page parle au serveur en HTTP ; dans VS Code, elle passe par ces messages.
import type { PrRef } from './api.ts';

/** Page → extension. */
export type WebviewToHost =
    /** Appel de l'API locale (même chemin et même corps qu'en HTTP, ex. « /api/pr/ws/repo/42 »). */
    | { type: 'request'; id: number; method: string; path: string; body?: unknown }
    /** Ouvrir le fichier du dépôt cloné localement, à une ligne (1-based) ou au début. */
    | { type: 'openFile'; ref: PrRef; path: string; line: number | null }
    /** Ouvrir la comparaison d'un fichier dans l'éditeur de diff de VS Code (from = 0 : contre la base). */
    | { type: 'openDiff'; ref: PrRef; from: number; to: number; path: string; oldPath: string | null };

/** Extension → page. */
export type HostToWebview =
    /** Réponse à une requête (status HTTP, corps JSON ou null). */
    | { type: 'response'; id: number; status: number; body: unknown }
    /** Afficher une route de la page (ex. « /pr/ws/repo/42 », « /settings »). */
    | { type: 'navigate'; route: string };

/** Balise <meta> par laquelle l'extension donne la route initiale à la page. */
export const INITIAL_ROUTE_META = 'revspan-route';

/** <meta> tag through which the extension imposes the page language (VS Code display language, e.g. « fr », « en-us »). */
export const INITIAL_LOCALE_META = 'revspan-locale';

/** État du panneau enregistré par la page (vscode.setState), rendu par VS Code quand il rouvre le panneau. */
export interface PanelState {
    /** Route affichée (ex. « /pr/ws/repo/42?from=2&to=6 »). */
    route: string;
}

/** Chemin de la page (« /… »), jamais une adresse d'une autre origine (« //hôte/… », « https:… »). */
export const isPageRoute = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
