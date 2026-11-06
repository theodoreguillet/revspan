<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue';
import type { Settings } from '../../shared/api.ts';
import { api } from '../services/api.ts';
import ErrorPanel from '../components/ErrorPanel.vue';
import TopNav from '../components/TopNav.vue';
import { showError } from '../composables/useErrors.ts';
import { parseRepoList } from '../../shared/repos.ts';
import { TOKEN_STORE_LABELS, tokenStorageHelp } from '../lib/settings.ts';
import ConfirmButton from '../components/ConfirmButton.vue';

const SCOPES = ['read:user:bitbucket', 'read:repository:bitbucket', 'read:pullrequest:bitbucket', 'write:pullrequest:bitbucket'];

const loaded = shallowRef<Settings | null>(null);
const loadError = shallowRef<unknown>(null);
const email = ref('');
const token = ref('');
const repos = ref('');
const status = ref<{ text: string; tone: '' | 'ok' | 'err' }>({ text: '', tone: '' });
const saving = ref(false);
const testing = ref(false);

document.title = 'Réglages · Strata';

const tokenPlaceholder = computed(() => (loaded.value?.hasToken
    ? `Jeton enregistré (${TOKEN_STORE_LABELS[loaded.value.tokenStore]})`
    : 'Colle ici ton jeton API Atlassian'));

function fill(settings: Settings): void {
    loaded.value = settings;
    email.value = settings.email;
    token.value = '';
    repos.value = settings.repos.join('\n');
}

function setStatus(text: string, tone: '' | 'ok' | 'err' = ''): void {
    status.value = { text, tone };
}

function isDirty(): boolean {
    const s = loaded.value;
    if (!s) {
        return false;
    }
    return email.value.trim() !== s.email || token.value !== '' || parseRepoList(repos.value.split('\n')).repos.join('\n') !== s.repos.join('\n');
}

async function save(): Promise<boolean> {
    const parsed = parseRepoList(repos.value.split('\n'));
    if (parsed.bad.length) {
        setStatus(`Dépôt(s) invalide(s) : ${parsed.bad.join(', ')} — format attendu « workspace/dépôt ».`, 'err');
        return false;
    }
    const body: { email: string; repos: string[]; token?: string } = { email: email.value.trim(), repos: parsed.repos };
    if (token.value.trim()) {
        body.token = token.value.trim();
    }
    saving.value = true;
    setStatus('Enregistrement…');
    try {
        fill(await api.saveSettings(body));
        setStatus('Réglages enregistrés.', 'ok');
        return true;
    } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), 'err');
        return false;
    } finally {
        saving.value = false;
    }
}

// la confirmation est demandée par le bouton (ConfirmButton)
async function deleteToken(): Promise<void> {
    try {
        fill(await api.saveSettings({ token: '' }));
        setStatus('Jeton supprimé.', 'ok');
    } catch (error) {
        showError(error);
    }
}

// POST /settings/test vérifie les réglages enregistrés : on enregistre d'abord une saisie en cours.
async function test(): Promise<void> {
    testing.value = true;
    try {
        if (isDirty() && !(await save())) {
            return;
        }
        setStatus('Test de la connexion…');
        const result = await api.testConnection();
        if (result.ok) {
            setStatus(`Connecté en tant que ${result.me.displayName}${result.me.nickname ? ` (${result.me.nickname})` : ''}.`, 'ok');
        } else {
            setStatus(`Échec : ${result.error.message}`, 'err');
        }
    } catch (error) {
        setStatus(`Échec : ${error instanceof Error ? error.message : String(error)}`, 'err');
    } finally {
        testing.value = false;
    }
}

onMounted(async () => {
    try {
        fill(await api.settings());
    } catch (error) {
        loadError.value = error;
    }
});
</script>

<template>
    <TopNav :crumbs="[{ text: 'Réglages', cur: true }]" />
    <main class="rv-settings">
        <ErrorPanel v-if="loadError" :error="loadError" />
        <div v-else-if="!loaded" class="rv-loading">Chargement des réglages…</div>
        <template v-else>
            <h1>Réglages</h1>
            <form @submit.prevent="save()">
                <div class="rv-helpbox">
                    Crée un jeton API Atlassian sur
                    <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">id.atlassian.com/manage-profile/security/api-tokens</a>
                    (« Créer un jeton API avec des portées », application Bitbucket) avec les portées
                    <template v-for="(scope, i) in SCOPES" :key="scope"><code>{{ scope }}</code><template v-if="i < SCOPES.length - 1">, </template></template>.
                    {{ tokenStorageHelp(loaded.tokenStore) }}
                </div>
                <div class="rv-field">
                    <label for="set-email">E-mail Atlassian</label>
                    <input id="set-email" v-model="email" type="email" autocomplete="username" spellcheck="false" placeholder="prenom.nom@exemple.com">
                    <div class="help">L'e-mail de ton compte Atlassian, utilisé avec le jeton (authentification Basic).</div>
                </div>
                <div class="rv-field">
                    <label for="set-token">Jeton API</label>
                    <div class="inline">
                        <input id="set-token" v-model="token" type="password" autocomplete="new-password" spellcheck="false" :placeholder="tokenPlaceholder">
                        <ConfirmButton
                            v-if="loaded.hasToken"
                            class="rv-btn"
                            label="Supprimer le jeton"
                            question="Supprimer le jeton enregistré ? Strata ne pourra plus lire Bitbucket."
                            @confirm="deleteToken()"
                        />
                    </div>
                    <div class="help">
                        {{ loaded.hasToken ? 'Laisser vide pour garder le jeton enregistré.' : 'Aucun jeton enregistré : Strata ne peut pas lire Bitbucket.' }}
                    </div>
                </div>
                <div class="rv-field">
                    <label for="set-repos">Dépôts suivis</label>
                    <textarea id="set-repos" v-model="repos" spellcheck="false" placeholder="mon-workspace/mon-depot&#10;mon-workspace/autre-depot" />
                    <div class="help">Un « workspace/dépôt » par ligne, ou l'adresse Bitbucket du dépôt. Leurs PR ouvertes apparaissent sur l'accueil.</div>
                </div>
                <div class="rv-form-acts">
                    <button class="rv-btn rv-btn-primary" type="submit" :disabled="saving">Enregistrer</button>
                    <button class="rv-btn" type="button" :disabled="testing" @click="test()">Tester la connexion</button>
                    <div :class="['rv-status', status.tone]" role="status" aria-live="polite">{{ status.text }}</div>
                </div>
            </form>
        </template>
    </main>
</template>
