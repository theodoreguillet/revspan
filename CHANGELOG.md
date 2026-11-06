# Changelog

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versions selon [SemVer](https://semver.org/lang/fr/).

## [Non publié]

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
