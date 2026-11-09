// Réglages : emplacements du jeton (la liste des dépôts est lue par src/shared/repos.ts).
import type { TokenStoreKind } from '../../shared/api.ts';

export const TOKEN_STORE_LABELS: Record<TokenStoreKind, string> = {
    keychain: 'trousseau',
    'secret-tool': 'secret-tool',
    file: 'fichier local',
    vscode: 'stockage sécurisé de VS Code',
};

/** Où va le jeton, selon qu'il est géré par l'extension VS Code ou par le serveur local. */
export function tokenStorageHelp(store: TokenStoreKind): string {
    if (store === 'vscode') {
        return 'Le jeton reste sur ce poste : il est confié à l\'extension Revspan, jamais à la page, et rangé dans le stockage sécurisé de VS Code.';
    }
    return 'Le jeton reste sur ce poste : il est envoyé au serveur local Revspan, jamais au navigateur. Sous macOS, il est rangé dans le trousseau.';
}
