// Sanitizing of Bitbucket comment HTML (untrusted content) with an allowlist.
// The HTML is parsed by DOMParser (inert document: no script, no loading), then rebuilt
// element by element in the current document. Nothing is ever injected through innerHTML.

const ALLOWED = new Set([
    'p', 'br', 'a', 'strong', 'em', 'b', 'i', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'del', 'span', 'img',
]);
// Elements removed with their content (what they contain is not readable text).
const DROP_WITH_CONTENT = new Set([
    'script', 'style', 'template', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
    'svg', 'math', 'head', 'title', 'meta', 'link', 'base', 'textarea', 'select', 'option', 'button', 'input', 'form',
]);
const MAX_DEPTH = 64;
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Allowed link URL (http, https, mailto) or null. Relative links "/..." are resolved against bitbucket.org. */
export function safeHref(value: string | null): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const raw = value.trim();
    let url: URL;
    try {
        url = /^\/(?!\/)/.test(raw) ? new URL(raw, 'https://bitbucket.org') : new URL(raw);
    } catch {
        return null;
    }
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
}

/** Allowed image source (https only) or null. */
export function safeImgSrc(value: string | null): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    try {
        const url = new URL(value.trim());
        return url.protocol === 'https:' ? url.href : null;
    } catch {
        return null;
    }
}

function copyNode(node: Node, out: Node, depth: number): void {
    if (node.nodeType === TEXT_NODE) {
        out.appendChild(document.createTextNode(node.nodeValue ?? ''));
        return;
    }
    if (node.nodeType !== ELEMENT_NODE) {
        return; // comments, processing instructions...
    }
    const source = node as Element;
    const tag = source.localName;
    if (DROP_WITH_CONTENT.has(tag)) {
        return;
    }
    if (depth > MAX_DEPTH) {
        out.appendChild(document.createTextNode(source.textContent ?? ''));
        return;
    }
    if (!ALLOWED.has(tag)) {
        // unknown element: keep its (sanitized) content, not the tag
        for (const child of Array.from(source.childNodes)) {
            copyNode(child, out, depth + 1);
        }
        return;
    }
    if (tag === 'img') {
        const src = safeImgSrc(source.getAttribute('src'));
        if (!src) {
            const alt = source.getAttribute('alt');
            if (alt) {
                out.appendChild(document.createTextNode(alt));
            }
            return;
        }
        const img = document.createElement('img');
        img.setAttribute('src', src);
        img.setAttribute('alt', source.getAttribute('alt') ?? '');
        img.setAttribute('loading', 'lazy');
        img.setAttribute('referrerpolicy', 'no-referrer');
        out.appendChild(img);
        return;
    }
    const el = document.createElement(tag);
    if (tag === 'a') {
        const href = safeHref(source.getAttribute('href'));
        if (href) {
            el.setAttribute('href', href);
            el.setAttribute('rel', 'noopener noreferrer');
            el.setAttribute('target', '_blank');
        }
    }
    for (const child of Array.from(source.childNodes)) {
        copyNode(child, el, depth + 1);
    }
    out.appendChild(el);
}

/** Untrusted HTML -> DocumentFragment containing only allowed elements and attributes. */
export function sanitizeHtml(html: string | null | undefined): DocumentFragment {
    const out = document.createDocumentFragment();
    if (!html) {
        return out;
    }
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    for (const child of Array.from(doc.body.childNodes)) {
        copyNode(child, out, 0);
    }
    return out;
}
