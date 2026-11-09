import { createApp } from 'vue';
import App from './App.vue';
import { detectLocale, setLocale } from './i18n/index.ts';
import { router } from './router.ts';
import { readInitialLocale } from './services/host.ts';
import './styles/app.css';

// Language imposed by the host (VS Code) first, otherwise the browser's preferred language.
setLocale(detectLocale({ host: readInitialLocale(document), browser: navigator.languages?.length ? navigator.languages : [navigator.language] }));

createApp(App).use(router).mount('#app');
