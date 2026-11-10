import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../src/web/i18n/translator.ts';
import { errorText } from '../../src/web/lib/errors.ts';

const fr = createTranslator('fr');
const en = createTranslator('en');

describe('error messages translated from the code and its parameters', () => {
    it('token and permission errors', () => {
        expect(errorText(fr, { code: 'NO_TOKEN', message: 'No Bitbucket token is configured.' }))
            .toBe('Aucun jeton Bitbucket configuré. Ouvre les réglages pour en ajouter un.');
        expect(errorText(en, { code: 'BB_UNAUTHORIZED', message: 'x' })).toBe('Bitbucket rejected the token (invalid or expired). Renew it in the settings.');
        expect(errorText(fr, { code: 'BB_FORBIDDEN', message: 'x' })).toBe('Droit manquant sur Bitbucket pour cette action.');
        expect(errorText(fr, { code: 'BB_FORBIDDEN', message: 'x', params: { detail: 'Your credentials lack one or more required privilege scopes.' } }))
            .toBe('Droit manquant sur Bitbucket pour cette action : Your credentials lack one or more required privilege scopes.');
        expect(errorText(en, { code: 'BB_FORBIDDEN', message: 'x', params: { reason: 'profile-unreadable' } }))
            .toBe('Connected, but the profile can’t be read: add the read:user:bitbucket scope to the token.');
    });

    it('Bitbucket texts (detail, path) are shown as is inside the translated message', () => {
        expect(errorText(fr, { code: 'BB_NOT_FOUND', message: 'x', params: { path: '/repositories/acme/x' } })).toBe('Introuvable sur Bitbucket : /repositories/acme/x');
        expect(errorText(fr, { code: 'BB_NOT_FOUND', message: 'x', params: { reason: 'no-versions' } })).toBe('Aucune version trouvée pour cette PR.');
        expect(errorText(en, { code: 'BB_ERROR', message: 'x', params: { status: 500, path: '/p', detail: 'Something broke' } }))
            .toBe('Bitbucket error 500 on /p: Something broke');
        expect(errorText(fr, { code: 'BB_ERROR', message: 'x', params: { status: 500, path: '/p' } })).toBe('Erreur Bitbucket 500 sur /p');
        expect(errorText(fr, { code: 'BB_UNREACHABLE', message: 'x', params: { detail: 'fetch failed' } })).toBe('Bitbucket injoignable (fetch failed)');
        expect(errorText(en, { code: 'VERSION_UNAVAILABLE', message: 'x', params: { version: 3 } })).toMatch(/^Version v3 is no longer available/);
        expect(errorText(fr, { code: 'INTERNAL', message: 'x', params: { detail: 'boom' } })).toBe('Erreur interne de Revspan : boom');
    });

    it('a setting VS Code does not know yet: reload the window', () => {
        const error = { code: 'SETTING_UNREGISTERED' as const, message: 'x', params: { setting: 'revspan.review.hideUnfollowed' } };
        expect(errorText(fr, error)).toBe('Revspan vient d’être mis à jour : recharge la fenêtre VS Code (Developer: Reload Window) pour enregistrer les réglages.');
        expect(errorText(en, error)).toBe('Revspan was just updated: reload the VS Code window (Developer: Reload Window) to save settings.');
    });

    it('settings errors', () => {
        expect(errorText(fr, { code: 'BAD_REQUEST', message: 'Invalid email address.', params: { reason: 'invalid-email' } })).toBe('Adresse e-mail invalide.');
        expect(errorText(en, { code: 'BAD_REQUEST', message: 'x', params: { reason: 'email-required' } })).toBe('Enter the Atlassian account email first.');
    });

    it('errors seen only by the page: server or extension unreachable, HTTP status without error body', () => {
        expect(errorText(fr, { code: 'NETWORK', message: 'x' })).toBe('Serveur Revspan injoignable. Est-il toujours lancé ?');
        expect(errorText(fr, { code: 'NETWORK', message: 'x', params: { via: 'extension' } })).toBe('L\'extension Revspan ne répond pas. Rouvrir le panneau peut aider.');
        expect(errorText(en, { code: 'HTTP_502', message: 'x' })).toBe('Error 502');
    });

    it('falls back to the server message for an unknown code or missing parameters', () => {
        expect(errorText(fr, { code: 'BAD_REQUEST', message: 'Invalid comparison: from 3 to 2.' })).toBe('Invalid comparison: from 3 to 2.');
        expect(errorText(fr, { code: 'BB_ERROR', message: 'Bitbucket redirect refused on /x' })).toBe('Bitbucket redirect refused on /x');
        expect(errorText(fr, { code: 'NOT_FOUND', message: 'Unknown route: GET /api/x' })).toBe('Unknown route: GET /api/x');
        expect(errorText(fr, { code: 'SOMETHING_NEW' as never, message: 'Raw message' })).toBe('Raw message');
    });
});
