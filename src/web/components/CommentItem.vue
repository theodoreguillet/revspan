<script setup lang="ts">
import { computed } from 'vue';
import type { Comment } from '../../shared/api.ts';
import { usePrPage } from '../composables/usePrPage.ts';
import { displayName, fmtFull, relTime } from '../lib/format.ts';
import { avatarHue, initials, reactionView, THUMBS } from '../lib/threads.ts';
import ConfirmButton from './ConfirmButton.vue';
import SafeHtml from './SafeHtml.vue';

const props = defineProps<{ comment: Comment }>();
const emit = defineEmits<{ reply: [] }>();
const page = usePrPage();

const reactions = computed(() => reactionView(props.comment, page.detail.me));
const name = computed(() => displayName(props.comment.user));
</script>

<template>
    <div :class="['rv-cm', { new: comment.isNew }]" :data-comment="comment.id">
        <span class="rv-av" :style="{ background: `hsl(${avatarHue(comment.user)} 52% 42%)` }" :title="name" aria-hidden="true">{{ initials(name) }}</span>
        <div class="body">
            <div>
                <span class="who">{{ name }}</span>
                <span class="when" :title="fmtFull(comment.createdOn)">{{ relTime(comment.createdOn) }}</span>
                <span v-if="comment.version != null" class="vtag" :title="`Version en cours lors du commentaire : v${comment.version}`">v{{ comment.version }}</span>
                <span v-if="comment.isNew" class="newtag">nouveau</span>
            </div>
            <div v-if="comment.deleted" class="deleted">Commentaire supprimé</div>
            <SafeHtml v-else :html="comment.html" />
            <div v-if="!comment.deleted" class="acts">
                <button
                    type="button"
                    :class="['react', { liked: reactions.liked }]"
                    data-action="react"
                    :title="reactions.title"
                    :aria-pressed="reactions.liked"
                    @click="page.react(comment)"
                >
                    {{ reactions.count ? `${THUMBS} ${reactions.count}` : THUMBS }}
                </button>
                <span v-for="r in reactions.others" :key="r.emoji" class="chip" :title="r.title">{{ r.emoji }} {{ r.count }}</span>
                <button type="button" data-action="reply" @click="emit('reply')">Répondre</button>
                <ConfirmButton
                    v-if="comment.mine"
                    data-action="delete"
                    label="Supprimer"
                    question="Supprimer ce commentaire sur Bitbucket ?"
                    @confirm="page.deleteComment(comment)"
                />
            </div>
        </div>
    </div>
</template>
