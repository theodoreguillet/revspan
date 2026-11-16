import { describe, expect, it } from 'vitest';
import { roleOfRoute } from '../../src/shared/panel-role.ts';

describe('roleOfRoute (one VS Code tab per PR)', () => {
    it('home and settings belong to the Revspan tab', () => {
        expect(roleOfRoute('/')).toBe('home');
        expect(roleOfRoute('/settings')).toBe('home');
        expect(roleOfRoute('/unknown/page')).toBe('home');
    });

    it('a PR route belongs to the tab of that PR, whatever its range', () => {
        expect(roleOfRoute('/pr/acme/demo-repo/42')).toBe('pr:acme/demo-repo/42');
        expect(roleOfRoute('/pr/acme/demo-repo/42?from=1&to=3')).toBe('pr:acme/demo-repo/42');
        expect(roleOfRoute('/pr/acme/demo-repo/42/')).toBe('pr:acme/demo-repo/42');
        expect(roleOfRoute('/pr/acme/demo-repo/43')).toBe('pr:acme/demo-repo/43');
    });

    it('encoded segments decoded: the same PR whoever built the route', () => {
        expect(roleOfRoute('/pr/acme%20team/demo%2Brepo/42')).toBe('pr:acme team/demo+repo/42');
        expect(roleOfRoute('/pr/acme%20team/demo+repo/42')).toBe(roleOfRoute('/pr/acme%20team/demo%2Brepo/42'));
    });

    it('not a PR page (the router sends it home): home', () => {
        expect(roleOfRoute('/pr/acme/demo-repo/abc')).toBe('home');
        expect(roleOfRoute('/pr/acme/demo-repo/42abc')).toBe('home');
        expect(roleOfRoute('/pr/acme/demo-repo')).toBe('home');
        expect(roleOfRoute('/pr/acme/demo-repo/42/compare')).toBe('home');
    });

    it('malformed encoding: the raw segment, no exception', () => {
        expect(roleOfRoute('/pr/acme%zz/demo-repo/42')).toBe('pr:acme%zz/demo-repo/42');
    });
});
