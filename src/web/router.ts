// Hash routing: #/ home, #/pr/:ws/:repo/:id?from=&to=, #/settings.
// The hash is kept in VS Code too: "#/..." links stay internal there (otherwise the panel opens them in the browser).
import { createRouter, createWebHashHistory } from 'vue-router';
import { clearErrors } from './composables/useErrors.ts';
import { isVsCode, onHostMessage, readInitialRoute, rememberRoute } from './services/host.ts';
import HomeView from './views/HomeView.vue';
import PrView from './views/PrView.vue';
import SettingsView from './views/SettingsView.vue';

const history = createWebHashHistory();

// Initial route given by the extension (<meta> tag), if the address does not already impose one.
const initialRoute = readInitialRoute(document);
if (initialRoute && (isVsCode || location.hash.replace(/^#\/?/, '') === '')) {
    history.replace(initialRoute);
}

export const router = createRouter({
    history,
    routes: [
        { path: '/', name: 'home', component: HomeView },
        { path: '/pr/:ws/:repo/:id(\\d+)', name: 'pr', component: PrView },
        { path: '/settings', name: 'settings', component: SettingsView },
        { path: '/:pathMatch(.*)*', redirect: '/' },
    ],
});

// Changing screen clears the previous screen's errors (not a mere range change).
// In VS Code, the displayed route is kept in the panel state (reopened on it after a reload).
router.afterEach((to, from, failure) => {
    if (!failure) {
        rememberRoute(to.fullPath);
    }
    if (to.path !== from.path) {
        clearErrors();
        window.scrollTo(0, 0);
    }
});

// The extension can ask to show another PR ("Open a PR" command, clicked link...).
if (isVsCode) {
    onHostMessage((message) => {
        if (message.type === 'navigate') {
            void router.push(message.route);
        }
    });
}
