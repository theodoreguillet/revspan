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
import { byRepoRows, reviewFromForm, type ByRepoRow } from '../lib/review-form.ts';
import type { ReviewSettings } from '../../shared/review-settings.ts';
import ConfirmButton from '../components/ConfirmButton.vue';
import I18nText from '../components/I18nText.vue';

const SCOPES = ['read:user:bitbucket', 'read:repository:bitbucket', 'read:pullrequest:bitbucket', 'write:pullrequest:bitbucket'];

const loaded = shallowRef<Settings | null>(null);
const loadError = shallowRef<unknown>(null);
const email = ref('');
const token = ref('');
const repos = ref('');
const requiredApprovals = ref<number | string | null>(2);
const byRepo = ref<ByRepoRow[]>([]);
const refreshMinutes = ref<number | string | null>(5);
const followed = ref<ReviewSettings['followed']>([]);
const notifications = ref<ReviewSettings['notifications']>({ newPullRequest: true, newVersion: true, buildFailed: false });
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
    requiredApprovals.value = settings.review.requiredApprovals;
    byRepo.value = byRepoRows(settings.review.requiredApprovalsByRepo);
    refreshMinutes.value = settings.review.refreshMinutes;
    followed.value = settings.review.followed.map((user) => ({ ...user }));
    notifications.value = { ...settings.review.notifications };
}

function readReview(): ReturnType<typeof reviewFromForm> {
    return reviewFromForm({
        requiredApprovals: requiredApprovals.value,
        byRepo: byRepo.value,
        refreshMinutes: refreshMinutes.value,
        followed: followed.value,
        notifications: notifications.value,
    });
}

function addOverride(): void {
    byRepo.value.push({ repo: '', approvals: requiredApprovals.value });
}

function removeOverride(index: number): void {
    byRepo.value.splice(index, 1);
}

function removeFollowed(uuid: string): void {
    followed.value = followed.value.filter((user) => user.uuid !== uuid);
}

function setStatus(text: string, tone: '' | 'ok' | 'err' = ''): void {
    status.value = { text, tone };
}

function isDirty(): boolean {
    const s = loaded.value;
    if (!s) {
        return false;
    }
    const review = readReview();
    // An invalid review section counts as a change: saving it reports the problem.
    const reviewChanged = !review.ok || JSON.stringify(review.review) !== JSON.stringify(s.review);
    return email.value.trim() !== s.email || token.value !== '' || parseRepoList(repos.value.split('\n')).repos.join('\n') !== s.repos.join('\n') || reviewChanged;
}

async function save(): Promise<boolean> {
    const parsed = parseRepoList(repos.value.split('\n'));
    if (parsed.bad.length) {
        setStatus(t('settings.invalidRepos', { count: parsed.bad.length, repos: parsed.bad.join(', ') }), 'err');
        return false;
    }
    const review = readReview();
    if (!review.ok) {
        setStatus(t(review.error), 'err');
        return false;
    }
    const body: { email: string; repos: string[]; review: ReviewSettings; token?: string } = { email: email.value.trim(), repos: parsed.repos, review: review.review };
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

// the confirmation is asked by the button (ConfirmButton); e-mail and repositories being typed are kept
async function deleteToken(): Promise<void> {
    try {
        loaded.value = await api.saveSettings({ token: '' });
        token.value = '';
        setStatus(t('settings.tokenDeleted'), 'ok');
    } catch (error) {
        showError(error);
    }
}

// POST /settings/test checks the saved settings: save any input in progress first.
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
                <h2 class="rv-section">{{ t('settings.reviewTitle') }}</h2>
                <div class="rv-field">
                    <label for="set-approvals">{{ t('settings.requiredApprovals') }}</label>
                    <input id="set-approvals" v-model.number="requiredApprovals" class="rv-num" type="number" min="1" max="20" step="1">
                    <div class="help">{{ t('settings.requiredApprovalsHelp') }}</div>
                </div>
                <div class="rv-field">
                    <div class="rv-label">{{ t('settings.byRepoTitle') }}</div>
                    <table v-if="byRepo.length" class="rv-overrides">
                        <thead>
                            <tr>
                                <th scope="col">{{ t('settings.byRepoRepo') }}</th>
                                <th scope="col">{{ t('settings.byRepoApprovals') }}</th>
                                <th scope="col" class="rv-sr-only">{{ t('settings.byRepoRemoveRow') }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="(row, index) in byRepo" :key="index">
                                <td><input v-model="row.repo" type="text" spellcheck="false" :aria-label="t('settings.byRepoRepo')" :placeholder="t('settings.byRepoRepoPlaceholder')"></td>
                                <td><input v-model.number="row.approvals" class="rv-num" type="number" min="1" max="20" step="1" :aria-label="t('settings.byRepoApprovals')"></td>
                                <td><button class="rv-btn" type="button" :aria-label="t('settings.byRepoRemove', { repo: row.repo || t('settings.byRepoRepo') })" @click="removeOverride(index)">{{ t('settings.byRepoRemoveRow') }}</button></td>
                            </tr>
                        </tbody>
                    </table>
                    <div v-else class="help">{{ t('settings.byRepoEmpty') }}</div>
                    <button class="rv-btn rv-add" type="button" @click="addOverride()">{{ t('settings.byRepoAdd') }}</button>
                    <div class="help">{{ t('settings.byRepoHelp') }}</div>
                </div>
                <div class="rv-field">
                    <div class="rv-label">{{ t('settings.followedTitle') }}</div>
                    <ul v-if="followed.length" class="rv-followed">
                        <li v-for="user in followed" :key="user.uuid">
                            <span>{{ user.displayName }}</span>
                            <button class="rv-btn" type="button" :aria-label="t('settings.followedRemove', { name: user.displayName })" @click="removeFollowed(user.uuid)">{{ t('settings.byRepoRemoveRow') }}</button>
                        </li>
                    </ul>
                    <div v-else class="help">{{ t('settings.followedEmpty') }}</div>
                    <div class="help">{{ t('settings.followedHelp') }}</div>
                </div>
                <div class="rv-field">
                    <label for="set-refresh">{{ t('settings.refreshMinutes') }}</label>
                    <input id="set-refresh" v-model.number="refreshMinutes" class="rv-num" type="number" min="1" max="120" step="1">
                    <div class="help">{{ t('settings.refreshMinutesHelp') }}</div>
                </div>
                <h2 class="rv-section">{{ t('settings.notificationsTitle') }}</h2>
                <div class="rv-field rv-toggles">
                    <label class="rv-check"><input v-model="notifications.newPullRequest" type="checkbox" :disabled="!isVsCode"> {{ t('settings.notifyNewPullRequest') }}</label>
                    <label class="rv-check"><input v-model="notifications.newVersion" type="checkbox" :disabled="!isVsCode"> {{ t('settings.notifyNewVersion') }}</label>
                    <label class="rv-check"><input v-model="notifications.buildFailed" type="checkbox" :disabled="!isVsCode"> {{ t('settings.notifyBuildFailed') }}</label>
                    <div v-if="!isVsCode" class="help">{{ t('settings.notificationsVsCodeOnly') }}</div>
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
