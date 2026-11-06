// Routage par hash : #/ accueil, #/pr/:ws/:repo/:id?from=&to=, #/settings.
// Le hash est gardé aussi dans VS Code : les liens « #/… » y restent internes (sinon le panneau les ouvre dans le navigateur).
import { createRouter, createWebHashHistory } from 'vue-router';
import { clearErrors } from './composables/useErrors.ts';
import { isVsCode, onHostMessage, readInitialRoute } from './services/host.ts';
import HomeView from './views/HomeView.vue';
import PrView from './views/PrView.vue';
import SettingsView from './views/SettingsView.vue';

const history = createWebHashHistory();

// Route initiale donnée par l'extension (balise <meta>), si l'adresse n'en impose pas déjà une.
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

// Changer d'écran efface les erreurs de l'écran précédent (pas un simple changement de plage).
router.afterEach((to, from) => {
    if (to.path !== from.path) {
        clearErrors();
        window.scrollTo(0, 0);
    }
});

// L'extension peut demander d'afficher une autre PR (commande « Ouvrir une PR », lien cliqué…).
if (isVsCode) {
    onHostMessage((message) => {
        if (message.type === 'navigate') {
            void router.push(message.route);
        }
    });
}
