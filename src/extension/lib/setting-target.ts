// Level at which to save a VS Code setting changed from the page (e.g. revspan.repositories).

/** Values of a setting per level (extracted from WorkspaceConfiguration.inspect()). */
export interface SettingInspection {
    defaultValue?: unknown;
    globalValue?: unknown;
    workspaceValue?: unknown;
}

/** VS Code's message for a write to a setting no loaded manifest declares (English and French builds). */
const UNREGISTERED_MESSAGE = /is not a registered configuration|n.est pas une configuration inscrite/i;

/**
 * Whether a failed write is due to a setting VS Code does not know yet: the extension was updated and the window still
 * runs the old manifest. Recognized by VS Code's message, or, in any language, by the missing default (every Revspan
 * setting declares one).
 */
export function isUnregisteredSetting(error: unknown, inspection: SettingInspection | undefined): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return UNREGISTERED_MESSAGE.test(message) || inspection?.defaultValue === undefined;
}

/**
 * The level that gives the effective value: the workspace if it defines it (otherwise "Save" would have
 * no visible effect), the user otherwise. In an untrusted workspace, VS Code ignores its value
 * (restricted setting): we write at the user level.
 */
export function settingTarget(inspection: SettingInspection | undefined, trusted: boolean): 'workspace' | 'global' {
    return trusted && inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
}
