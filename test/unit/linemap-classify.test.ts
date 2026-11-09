import { describe, expect, it } from 'vitest';
import { mapLine } from '../../src/server/core/linemap.ts';
import { categoryOf, sameHash } from '../../src/server/core/classify.ts';

describe('mapLine', () => {
    it('unchanged line shifted by an addition above', () => {
        expect(mapLine(['a', 'b', 'c', 'd'], ['x', 'a', 'b', 'c', 'd'], 3)).toEqual({ line: 4, changed: false });
    });

    it('modified line: position of the new line, marked changed', () => {
        const oldLines = ['l38', 'l39', 'const id = recordData.labels?.slug;', 'l41'];
        const newLines = ['l38', 'l39', 'const id = repo.buildIdFromPayload(recordData);', 'l41'];
        expect(mapLine(oldLines, newLines, 3)).toEqual({ line: 3, changed: true });
    });

    it('deleted line without replacement: next line', () => {
        expect(mapLine(['a', 'b', 'c', 'd'], ['a', 'c', 'd'], 2)).toEqual({ line: 2, changed: true });
    });

    it('empty file or out-of-range line', () => {
        expect(mapLine(['a'], [], 1)).toEqual({ line: null, changed: true });
        expect(mapLine(['a'], ['a', 'b'], 9)).toEqual({ line: 2, changed: true });
    });
});

describe('classify', () => {
    it('categoryOf', () => {
        expect(categoryOf('package.json')).toBe('deps');
        expect(categoryOf('packages/x/package-lock.json')).toBe('deps');
        expect(categoryOf('pnpm-lock.yaml')).toBe('deps');
        expect(categoryOf('src/package.json.ts')).toBe('code');
        expect(categoryOf('coverage.config.json')).toBe('code');
    });

    it('sameHash compares abbreviated hashes', () => {
        expect(sameHash('178703a1c7dc', '178703a1c7dcaf4f26fd6d30fd1a37526e0f04c9')).toBe(true);
        expect(sameHash('178703a1c7dc', '2a2fc206db7e')).toBe(false);
        expect(sameHash('', 'abc')).toBe(false);
    });
});
