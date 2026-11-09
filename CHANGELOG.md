# Changelog

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versions selon [SemVer](https://semver.org/lang/fr/).

## [Non publié]

### Ajouts

- Extension VS Code : dépôts suivis dans le réglage `strata.repositories` (Réglages de VS Code, Settings Sync, propre à
  chaque profil), toujours modifiables depuis ⚙ Réglages du panneau.
- Extension VS Code : fonctionne en espace de travail non approuvé ; en espace virtuel, tout sauf « Ouvrir le fichier ».
- Licence MIT, icône, CI GitHub Actions (lint, types, tests, tests UI, `.vsix`) et release GitHub sur tag `v*`.
- Indicateur de chargement sur les boutons d'action (approuver, demander des modifs, marquer relue, commenter,
  répondre, 👍, résoudre, supprimer, enregistrer, tester, actualiser) ; une seule écriture à la fois.

### Corrections

- Une PR dont une ancienne version a été effacée par Bitbucket (commit écrasé par un force-push) ne s'ouvrait plus
  (« Introuvable sur Bitbucket : …/commit/… »). Ces versions sont désormais affichées « indisponibles » dans la frise.

## [2.0.0] - 2026-11-06

Première version publiée sous le nom Strata.

### Ajouts

- Frise des versions d'une PR Bitbucket (un point par push, rebases repérés), comparaison de deux versions quelconques
  ou d'une version avec sa base, sans le bruit apporté par les rebases (version rejouée sur la nouvelle base).
- Résumé de chaque version : code, dépendances seules, rebase seul, message seul.
- Reprise de la relecture : dernière version relue, nouvelles versions et nouveaux commentaires, fichiers vus.
- Discussions relocalisées sur la version affichée ; commenter, répondre, 👍, résoudre, approuver, demander des modifs.
- Accueil « Mes PR » sur les dépôts suivis.
- Jeton dans le trousseau macOS, `secret-tool` sous Linux, sinon fichier `0600`.
- Extension VS Code : vue « Mes PR », page de la PR dans un panneau, « Ouvrir le fichier » (worktree git de la branche
  de la PR préféré) et « Diff VS Code » natif.
