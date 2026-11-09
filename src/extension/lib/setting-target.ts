// Level at which to save a VS Code setting changed from the page (e.g. revspan.repositories).

/** Values of a setting per level (extracted from WorkspaceConfiguration.inspect()). */
export interface SettingInspection {
    globalValue?: unknown;
    workspaceValue?: unknown;
}

/**
 * The level that gives the effective value: the workspace if it defines it (otherwise "Save" would have
 * no visible effect), the user otherwise. In an untrusted workspace, VS Code ignores its value
 * (restricted setting): we write at the user level.
 */
export function settingTarget(inspection: SettingInspection | undefined, trusted: boolean): 'workspace' | 'global' {
    return trusted && inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
}
