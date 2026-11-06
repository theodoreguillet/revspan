# Strata pour VS Code

Relire une PR Bitbucket version par version (amend, rebase) sans quitter VS Code : vue « Mes PR » dans la barre
latérale, page de la PR dans un panneau, « Ouvrir le fichier » (dépôt cloné, worktree git de la branche si présent)
et « Diff VS Code » (éditeur de diff natif, coloration syntaxique). Le jeton Bitbucket est rangé dans le stockage
sécurisé de VS Code (⚙ Réglages dans le panneau).

Construit depuis le dossier `strata` : `npm run package:extension` (→ `dist/strata.vsix`) ou
`npm run extension:install` (construit et installe dans VS Code). Voir le README du dossier `strata`.
