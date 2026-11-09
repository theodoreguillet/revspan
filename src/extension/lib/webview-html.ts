// HTML du panneau : la page construite (dist/web/index.html) + politique de sécurité et route initiale.
// Les fichiers de la page (./assets/…) sont réécrits en adresses du panneau. Pas de balise <base> : elle changerait
// l'adresse de résolution du document, et le routeur (historique par hash) tenterait d'écrire une URL d'une autre origine.
import { INITIAL_LOCALE_META, INITIAL_ROUTE_META } from '../../shared/webview-protocol.ts';
import type { PageLocale } from './l10n.ts';

export interface WebviewHtmlOptions {
    /** URI webview du dossier dist/web. */
    assetsBaseUri: string;
    /** Source autorisée pour les fichiers de l'extension (webview.cspSource). */
    cspSource: string;
    /** Route à afficher au chargement (ex. « /pr/ws/repo/42 »). */
    initialRoute: string;
    /** Page language, from VS Code's display language (the page uses it before the browser's). */
    locale: PageLocale;
}

const escapeAttribute = (value: string): string => value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Aucun script en ligne, aucun accès réseau depuis la page : tout passe par les messages vers l'extension. */
export function contentSecurityPolicy(cspSource: string): string {
    return [
        "default-src 'none'",
        `img-src ${cspSource} https: data:`,
        `script-src ${cspSource}`,
        `style-src ${cspSource} 'unsafe-inline'`,
        `font-src ${cspSource}`,
        "connect-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

export function buildWebviewHtml(indexHtml: string, { assetsBaseUri, cspSource, initialRoute, locale }: WebviewHtmlOptions): string {
    if (!/<head[^>]*>/i.test(indexHtml)) {
        throw new Error('Invalid built page: no <head> tag.');
    }
    const base = assetsBaseUri.replace(/\/+$/, '');
    const head = [
        `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(contentSecurityPolicy(cspSource))}">`,
        `<meta name="${INITIAL_ROUTE_META}" content="${escapeAttribute(initialRoute)}">`,
        `<meta name="${INITIAL_LOCALE_META}" content="${locale}">`,
    ].join('\n    ');
    return indexHtml
        .replace(/\b(src|href)="\.\/([^"]*)"/g, (_match, attribute: string, file: string) => `${attribute}="${escapeAttribute(`${base}/${file}`)}"`)
        .replace(/<head[^>]*>/i, (tag) => `${tag}\n    ${head}`);
}
