// What a change of the revspan.* settings calls for in a window (pure: VS Code's event is passed as a predicate).

export interface SettingsChangeActions {
    /** The home depends on it (repositories, approval rule, followed contributors): the tree recomputes it. */
    refreshTree: boolean;
    /** The tracked repositories changed: the notifier forgets the ones removed. */
    repositoriesChanged: boolean;
    /** The refresh interval changed: the poll is re-armed. */
    rearm: boolean;
}

/** affects: ConfigurationChangeEvent.affectsConfiguration (a setting affects itself and every section above it). */
export function settingsChangeActions(affects: (section: string) => boolean): SettingsChangeActions {
    const repositoriesChanged = affects('revspan.repositories');
    return {
        refreshTree: repositoriesChanged || affects('revspan.review'),
        repositoriesChanged,
        rearm: affects('revspan.refreshIntervalMinutes'),
    };
}
