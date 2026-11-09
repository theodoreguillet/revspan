import { describe, expect, it } from 'vitest';
import { safeHref, safeImgSrc, sanitizeHtml } from '../../src/web/lib/sanitize.ts';

function render(html: string): string {
    const box = document.createElement('div');
    box.append(sanitizeHtml(html));
    return box.innerHTML;
}

describe('sanitizeHtml', () => {
    it('keeps the allowed markup (tables, code, lists)', () => {
        const html = '<h2>Titre</h2><p>a <strong>b</strong> <code>c</code></p><table><thead><tr><th>x</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><ul><li>i</li></ul>';
        expect(render(html)).toBe(html);
    });

    it('removes scripts, styles, iframes and forms with their content', () => {
        const out = render('<p>ok</p><script>alert(1)</script><style>p{}</style><iframe title="x"></iframe><svg><text>s</text></svg><form><input value="x"></form>');
        expect(out).toBe('<p>ok</p>');
    });

    it('removes all event and style attributes', () => {
        const out = render('<p onclick="x()" style="color:red" class="k" id="i">texte</p><table style="border:1px"><tbody><tr><td onmouseover="y()">c</td></tr></tbody></table>');
        expect(out).toBe('<p>texte</p><table><tbody><tr><td>c</td></tr></tbody></table>');
    });

    it('unknown elements: content kept (sanitized), tag removed', () => {
        expect(render('<div style="x">texte <b>gras</b><marquee onstart="z()">m</marquee></div>')).toBe('texte <b>gras</b>m');
    });

    it('links: http/https/mailto only, with rel and target; "/..." resolved against bitbucket.org', () => {
        expect(render('<a href="https://e.x/a" onclick="x()">l</a>')).toBe('<a href="https://e.x/a" rel="noopener noreferrer" target="_blank">l</a>');
        expect(render('<a href="javascript:alert(1)">js</a>')).toBe('<a>js</a>');
        expect(render('<a href=" JaVaScRiPt:alert(1)">js</a>')).toBe('<a>js</a>');
        expect(render('<a href="/acme/records-api">r</a>')).toContain('href="https://bitbucket.org/acme/records-api"');
        expect(render('<a href="mailto:a@b.c">m</a>')).toContain('href="mailto:a@b.c"');
    });

    it('images: https only (otherwise the alt text)', () => {
        expect(render('<img src="https://e.x/i.png" onerror="x()" alt="i">')).toBe('<img src="https://e.x/i.png" alt="i" loading="lazy" referrerpolicy="no-referrer">');
        expect(render('<img src=x onerror="alert(1)">')).toBe('');
        expect(render('<img src="http://e.x/i.png" alt="capture">')).toBe('capture');
        expect(render('<img src="data:image/png;base64,AAAA">')).toBe('');
    });

    it('empty or missing input', () => {
        expect(render('')).toBe('');
        expect(sanitizeHtml(null).childNodes.length).toBe(0);
    });

    it('very deep nesting: text only beyond the limit', () => {
        const deep = `${'<b>'.repeat(80)}x${'</b>'.repeat(80)}`;
        const out = render(deep);
        expect(out).toContain('x');
        expect((out.match(/<b>/g) ?? []).length).toBeLessThanOrEqual(66);
    });
});

describe('safeHref / safeImgSrc', () => {
    it('allowed protocols', () => {
        expect(safeHref('https://e.x/')).toBe('https://e.x/');
        expect(safeHref('ftp://e.x/')).toBeNull();
        expect(safeHref('//evil.example/x')).toBeNull();
        expect(safeHref(null)).toBeNull();
        expect(safeImgSrc('https://e.x/i.png')).toBe('https://e.x/i.png');
        expect(safeImgSrc('http://e.x/i.png')).toBeNull();
    });
});
