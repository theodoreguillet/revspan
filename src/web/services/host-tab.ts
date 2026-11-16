// Page in a VS Code tab: each tab keeps the role of its initial route (src/shared/panel-role.ts) and follows the
// extension's messages. Outside VS Code, nothing here is used: every screen stays in the same page.
import type { Router } from 'vue-router';
import { roleOfRoute } from '../../shared/panel-role.ts';
import { setHostVisible } from '../composables/usePageVisible.ts';
import { onHostMessage, postToHost } from './host.ts';

/**
 * Binds the router to its VS Code tab. A route of another role (a PR from the "Revspan" tab, the home page or settings
 * from a PR tab) is asked to the extension, which shows it in the tab of that role: this tab stays put. A range change
 * stays in the PR's tab. The extension can make the tab navigate within its role, and tells whether it is on screen
 * (a hidden tab pauses its background work). Returns the unbinding (the page keeps it for its lifetime).
 */
export function bindRouterToHost(router: Router, initialRoute: string | null): () => void {
    const role = roleOfRoute(initialRoute ?? '/');
    const removeGuard = router.beforeEach((to) => {
        if (roleOfRoute(to.fullPath) === role) {
            return true;
        }
        postToHost({ type: 'openRoute', route: to.fullPath });
        return false;
    });
    const stopListening = onHostMessage((message) => {
        if (message.type === 'navigate') {
            void router.push(message.route);
        } else if (message.type === 'visibility') {
            setHostVisible(message.visible);
        }
    });
    return () => {
        removeGuard();
        stopListening();
    };
}
