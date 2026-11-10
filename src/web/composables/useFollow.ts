// Follow or unfollow a PR author: the followed list lives in the settings (PUT /api/settings, review.followed).
import { ref } from 'vue';
import type { User } from '../../shared/api.ts';
import type { FollowedUser } from '../../shared/review-settings.ts';
import { withFollowed } from '../lib/follow.ts';
import { api } from '../services/api.ts';
import { showError } from './useErrors.ts';

/** Saves from the latest saved list (the settings page or another window may have changed it); returns the saved list. */
async function saveFollow(user: User, follow: boolean): Promise<FollowedUser[]> {
    const current = (await api.followed()).followed;
    const followed = withFollowed(current, { uuid: user.uuid, displayName: user.displayName }, follow);
    return (await api.saveSettings({ review: { followed } })).review.followed;
}

/** One write at a time; `onSaved` receives the saved list, an error goes to the global banner. */
export function useFollow(onSaved: (list: FollowedUser[]) => void) {
    const busy = ref(false);

    async function setFollow(user: User, follow: boolean): Promise<void> {
        if (busy.value) {
            return;
        }
        busy.value = true;
        try {
            onSaved(await saveFollow(user, follow));
        } catch (error) {
            showError(error);
        } finally {
            busy.value = false;
        }
    }

    return { busy, setFollow };
}
