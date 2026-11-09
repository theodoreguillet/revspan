<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watchEffect } from 'vue';
import type { Settings } from '../../shared/api.ts';
import { t, tr } from '../i18n/index.ts';
import { errorText } from '../lib/errors.ts';
import { api, errorInfo } from '../services/api.ts';
import { isVsCode } from '../services/host.ts';
import ErrorPanel from '../components/ErrorPanel.vue';
import TopNav from '../components/TopNav.vue';
import { showError } from '../composables/useErrors.ts';
import { parseRepoList } from '../../shared/repos.ts';
import { TOKEN_STORE_LABELS, tokenStorageHelp } from '../lib/settings.ts';
import ConfirmButton from '../components/ConfirmButton.vue';
import I18nText from '../components/I18nText.vue';

const SCOPES = ['read:user:bitbucket', 'read:repository:bitbucket', 'read:pullrequest:bitbucket', 'write:pullrequest:bitbucket'];

const loaded = shallowRef<Settings | null>(null);
const loadError = shallowRef<unknown>(null);
const email = ref('');
const token = ref('');
const repos = ref('');
const status = ref<{ text: string; tone: '' | 'ok' | 'err' }>({ text: '', tone: '' });
const saving = ref(false);
const testing = ref(false);

watchEffect(() => {
    document.title = t('settings.docTitle');
});

const tokenPlaceholder = computed(() => (loaded.value?.hasToken
    ? t('settings.tokenSaved', { store: t(TOKEN_STORE_LABELS[loaded.value.tokenStore]) })
    : t('settings.tokenPlaceholder')));

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
        setStatus(t('settings.invalidRepos', { count: parsed.bad.length, repos: parsed.bad.join(', ') }), 'err');
        return false;
    }
    const body: { email: string; repos: string[]; token?: string } = { email: email.value.trim(), repos: parsed.repos };
    if (token.value.trim()) {
        body.token = token.value.trim();
    }
    saving.value = true;
    setStatus(t('settings.saving'));
    try {
        fill(await api.saveSettings(body));
        setStatus(t('settings.saved'), 'ok');
        return true;
    } catch (error) {
        setStatus(errorInfo(error).message, 'err');
        return false;
    } finally {
        saving.value = false;
    }
}

// la confirmation est demandée par le bouton (ConfirmButton) ; e-mail et dépôts en cours de saisie sont gardés
async function deleteToken(): Promise<void> {
    try {
        loaded.value = await api.saveSettings({ token: '' });
        token.value = '';
        setStatus(t('settings.tokenDeleted'), 'ok');
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
        setStatus(t('settings.testing'));
        const result = await api.testConnection();
        if (result.ok) {
            const name = `${result.me.displayName}${result.me.nickname ? ` (${result.me.nickname})` : ''}`;
            setStatus(t('settings.connectedAs', { name }), 'ok');
        } else {
            setStatus(t('settings.failed', { message: errorText(tr(), result.error) }), 'err');
        }
    } catch (error) {
        setStatus(t('settings.failed', { message: errorInfo(error).message }), 'err');
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
    <TopNav :crumbs="[{ text: t('common.settings'), cur: true }]" />
    <main class="rv-settings">
        <ErrorPanel v-if="loadError" :error="loadError" />
        <div v-else-if="!loaded" class="rv-loading">{{ t('settings.loading') }}</div>
        <template v-else>
            <h1>{{ t('common.settings') }}</h1>
            <form @submit.prevent="save()">
                <div class="rv-helpbox">
                    <I18nText k="settings.help">
                        <template #link>
                            <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">id.atlassian.com/manage-profile/security/api-tokens</a>
                        </template>
                        <template #scopes>
                            <template v-for="(scope, i) in SCOPES" :key="scope"><code>{{ scope }}</code><template v-if="i < SCOPES.length - 1">, </template></template>
                        </template>
                    </I18nText>
                    {{ t(tokenStorageHelp(loaded.tokenStore)) }}
                </div>
                <div class="rv-field">
                    <label for="set-email">{{ t('settings.email') }}</label>
                    <input id="set-email" v-model="email" type="email" autocomplete="username" spellcheck="false" :placeholder="t('settings.emailPlaceholder')">
                    <div class="help">{{ t('settings.emailHelp') }}</div>
                </div>
                <div class="rv-field">
                    <label for="set-token">{{ t('settings.token') }}</label>
                    <div class="inline">
                        <input id="set-token" v-model="token" type="password" autocomplete="new-password" spellcheck="false" :placeholder="tokenPlaceholder">
                        <ConfirmButton
                            v-if="loaded.hasToken"
                            class="rv-btn"
                            :label="t('settings.deleteToken')"
                            :question="t('settings.deleteTokenQuestion')"
                            @confirm="deleteToken()"
                        />
                    </div>
                    <div class="help">
                        {{ loaded.hasToken ? t('settings.tokenKeep') : t('settings.tokenNone') }}
                    </div>
                </div>
                <div class="rv-field">
                    <label for="set-repos">{{ t('settings.repos') }}</label>
                    <textarea id="set-repos" v-model="repos" spellcheck="false" :placeholder="t('settings.reposPlaceholder')" />
                    <div class="help">
                        {{ t('settings.reposHelp') }}
                        <I18nText v-if="isVsCode" k="settings.reposVsCode">
                            <template #setting><code>revspan.repositories</code></template>
                        </I18nText>
                    </div>
                </div>
                <div class="rv-form-acts">
                    <button :class="['rv-btn rv-btn-primary', { busy: saving }]" type="submit" :disabled="saving" :aria-busy="saving">{{ t('settings.save') }}</button>
                    <button :class="['rv-btn', { busy: testing }]" type="button" :disabled="testing" :aria-busy="testing" @click="test()">{{ t('settings.test') }}</button>
                    <div :class="['rv-status', status.tone]" role="status" aria-live="polite">{{ status.text }}</div>
                </div>
            </form>
        </template>
    </main>
</template>
