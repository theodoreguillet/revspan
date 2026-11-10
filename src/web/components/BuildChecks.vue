<script setup lang="ts">
// Builds tab: each check of the PR's head commit, with its state, age and link to the CI tool.
import { computed } from 'vue';
import type { BuildCheck } from '../../shared/api.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { t, tr } from '../i18n/index.ts';
import { buildCheckText, safeBuildUrl } from '../lib/build.ts';

const ICONS: Record<BuildCheck['state'], string> = { success: '✓', failed: '✗', stopped: '✗', running: '' };

const page = usePrPage();
const checks = computed(() => page.detail.build);
const rows = computed(() => (checks.value ?? []).map((check) => ({
    check,
    href: safeBuildUrl(check.url),
    ...buildCheckText(tr(), check),
})));
</script>

<template>
    <div class="rv-builds">
        <div class="rv-builds-list">
            <p v-if="checks === null" class="rv-chk muted" data-builds="unavailable">{{ t('build.unavailable') }}</p>
            <p v-else-if="!rows.length" class="rv-chk muted" data-builds="empty">{{ t('build.empty') }}</p>
            <template v-else>
                <div v-for="row in rows" :key="row.check.key" class="rv-chk" :data-check="row.check.key" :data-state="row.check.state">
                    <span :class="['ic', row.check.state]" aria-hidden="true">
                        <span v-if="row.check.state === 'running'" class="rv-spin" />{{ ICONS[row.check.state] }}
                    </span>
                    <span class="nm">{{ row.check.name }} — {{ row.state }}</span>
                    <span class="when">{{ row.when }}</span>
                    <a v-if="row.href" class="ext" :href="row.href" target="_blank" rel="noopener noreferrer" :title="t('build.open')" :aria-label="`${t('build.open')}: ${row.check.name}`">↗</a>
                </div>
            </template>
            <p class="rv-chk note">{{ t('build.note') }}</p>
        </div>
    </div>
</template>
