import { describe, expect, it } from 'vitest';
import { diffDisplay, SKELETON_DELAY_MS } from '../../src/web/lib/loading.ts';

describe('diffDisplay', () => {
    it('keeps the diff under 200 ms', () => {
        expect(SKELETON_DELAY_MS).toBe(200);
        expect(diffDisplay({ loading: true, since: 1000, now: 1000, hasCompare: true })).toBe('progress');
        expect(diffDisplay({ loading: true, since: 1000, now: 1199, hasCompare: true })).toBe('progress');
        expect(diffDisplay({ loading: false, since: null, now: 5000, hasCompare: true })).toBe('diff');
    });

    it('shows the skeleton from 200 ms', () => {
        expect(diffDisplay({ loading: true, since: 1000, now: 1200, hasCompare: true })).toBe('skeleton');
        expect(diffDisplay({ loading: true, since: 1000, now: 4000, hasCompare: true })).toBe('skeleton');
    });

    it('shows the skeleton when nothing is loaded yet', () => {
        expect(diffDisplay({ loading: true, since: 1000, now: 1000, hasCompare: false })).toBe('skeleton');
        expect(diffDisplay({ loading: false, since: null, now: 1000, hasCompare: false })).toBe('skeleton');
    });
});
