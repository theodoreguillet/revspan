// Panel HTML: the built page (dist/web/index.html) + security policy and initial route.
// The page files (./assets/...) are rewritten to panel addresses. No <base> tag: it would change the
// document's resolution address, and the router (hash history) would try to write a URL from another origin.
import { INITIAL_LOCALE_META, INITIAL_ROUTE_META } from '../../shared/webview-protocol.ts';
import type { PageLocale } from './l10n.ts';

export interface WebviewHtmlOptions {
    /** Webview URI of the dist/web folder. */
    assetsBaseUri: string;
    /** Source allowed for the extension's files (webview.cspSource). */
    cspSource: string;
    /** Route to show on load (e.g. "/pr/ws/repo/42"). */
    initialRoute: string;
    /** Page language, from VS Code's display language (the page uses it before the browser's). */
    locale: PageLocale;
}

const escapeAttribute = (value: string): string => value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/** No inline script, no network access from the page: everything goes through messages to the extension. */
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
