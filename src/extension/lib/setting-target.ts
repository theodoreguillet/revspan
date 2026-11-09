// Niveau où enregistrer un réglage VS Code modifié depuis la page (ex. revspan.repositories).

/** Valeurs d'un réglage par niveau (extrait de WorkspaceConfiguration.inspect()). */
export interface SettingInspection {
    globalValue?: unknown;
    workspaceValue?: unknown;
}

/**
 * Le niveau qui donne la valeur effective : l'espace de travail s'il la définit (sinon « Enregistrer » n'aurait
 * aucun effet visible), l'utilisateur sinon. Dans un espace de travail non approuvé, VS Code ignore sa valeur
 * (réglage restreint) : on écrit au niveau utilisateur.
 */
export function settingTarget(inspection: SettingInspection | undefined, trusted: boolean): 'workspace' | 'global' {
    return trusted && inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
}
