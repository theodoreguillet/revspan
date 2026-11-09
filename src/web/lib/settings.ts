// Settings: token locations (the repository list is read by src/shared/repos.ts).
import type { TokenStoreKind } from '../../shared/api.ts';
import type { MessageKey } from '../i18n/index.ts';

export const TOKEN_STORE_LABELS = {
    keychain: 'settings.store.keychain',
    'secret-tool': 'settings.store.secretTool',
    file: 'settings.store.file',
    vscode: 'settings.store.vscode',
} as const satisfies Record<TokenStoreKind, MessageKey>;

/** Where the token goes, depending on whether the VS Code extension or the local server manages it. */
export function tokenStorageHelp(store: TokenStoreKind): 'settings.storageVsCode' | 'settings.storageServer' {
    return store === 'vscode' ? 'settings.storageVsCode' : 'settings.storageServer';
}
