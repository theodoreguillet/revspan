# Strata

Relire une PR Bitbucket **couche par couche** : chaque push est une couche, même quand l'auteur fait
`git commit --amend` et rebase à chaque retour (une PR = un commit). Bitbucket ne montre que le diff complet contre
master ; Strata retrouve toutes les versions poussées et montre ce que l'auteur a vraiment changé entre deux versions,
sans le bruit apporté par les rebases.

Outil local : un serveur Node (TypeScript, Hono) qui sert une page Vue 3 dans ton navigateur.

## Lancer

```bash
npm ci && npm run build                              # une fois (puis après chaque mise à jour)
node bin/strata.js                                   # accueil « Mes PR »
node bin/strata.js https://bitbucket.org/<workspace>/<dépôt>/pull-requests/<id>   # une PR directement
```

Node 22.18 ou plus. La page s'ouvre sur `http://127.0.0.1:7420` (`--port 7500`, `--no-open` disponibles).
Pratique : `alias strata='node /chemin/vers/strata/bin/strata.js'`.

## Extension VS Code

La même page existe en extension VS Code : vue **« Mes PR »** dans la barre d'activité (icône Strata), page de la PR
dans un panneau, et deux actions sur chaque fichier du diff :

- **Ouvrir le fichier** : le fichier du dépôt cloné dans l'espace de travail, à la ligne ; un worktree git du dépôt
  (où qu'il soit) extrait sur la branche de la PR est préféré à la copie principale (sinon un message prévient que les
  lignes peuvent différer).
- **Diff VS Code** : la comparaison du fichier dans l'éditeur de diff natif (coloration syntaxique), avec exactement
  les mêmes deux côtés que la page (version rejouée sur la nouvelle base après un rebase).

Pas de serveur ni de port : l'extension appelle l'application en mémoire. Le jeton est rangé dans le stockage sécurisé
de VS Code (⚙ Réglages du panneau ou commande « Strata : Réglages »), séparément de la version web.

```bash
npm run extension:install            # construit dist/strata.vsix et l'installe dans VS Code (puis recharger la fenêtre)
npm run extension:install -- --profile "Nom"   # idem dans un profil VS Code précis (sinon : profil par défaut)
npm run package:extension            # seulement le .vsix (à partager : Extensions › … › Installer depuis un VSIX)
npm run extension:dev -- <dossier>   # mode développement : fenêtre VS Code sur <dossier>, extension non installée
```

Ou ouvrir le dossier `strata` dans VS Code et lancer « Extension Strata » (F5).

## Premier lancement : le jeton

1. Crée un jeton API Atlassian **avec droits** sur <https://id.atlassian.com/manage-profile/security/api-tokens>
   (« Create API token with scopes », application Bitbucket) :
   `read:user:bitbucket`, `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`.
2. Dans Strata, ⚙ Réglages : ton e-mail Atlassian + le jeton, puis « Tester la connexion ».
3. Ajuste la liste des dépôts de l'accueil (un `workspace/repo` par ligne).

Le jeton est rangé dans le **trousseau macOS** (service `strata-bitbucket`), via `secret-tool` sous Linux,
sinon dans un fichier `token.json` en `0600`. Il ne quitte jamais le serveur local.
Sans `read:user:bitbucket`, l'outil marche mais ne reconnaît pas tes PR ni tes approbations.

## La page d'une PR

- **Frise des versions** : un point par push, regroupés par jour ; ◆ = rebase ; sous chaque point, ce que l'auteur
  a changé (`+35 −14`, `deps` = seulement package.json / lockfile / sous-module, `rebase seul`, `message`).
  Clic = ce qu'a changé cette version ; Maj+clic = étendre la plage ; « master » = version complète.
- **Reprise** : trait « ✓ relu » sur ta dernière relecture (approbation, nouveau commentaire ou « Marquer comme relue »),
  bandeau de ce qui a bougé depuis, points bleus sur les versions nouvelles.
- **Diff** : unifié ou côte à côte, fichiers « vus » (la coche saute si le fichier change), fichiers venus de master masqués.
- **Discussions** : fils relocalisés sur la version affichée (« ligne modifiée depuis »), réponses, 👍, résolution ;
  commentaire sur une ligne de la dernière version.
- **Approuver / demander des modifs**, avec la version approuvée par chacun (« périmée » si du code a changé depuis).

Raccourcis : `j`/`k` fichier, `n`/`p` fil, `v` vu, `[`/`]` version, `?` aide.

## Développer

| Commande | Rôle |
|---|---|
| `npm ci` | dépendances du lockfile |
| `npm run dev` | serveur en watch (port 7420) + Vite avec rechargement à chaud (port 5173) |
| `npm run dev:fake` | serveur branché sur le faux Bitbucket (aucun appel réel) ; puis `npm run dev:web` |
| `npm run check` | lint + types + tests unitaires et d'intégration (Vitest) |
| `npm run test:e2e` | build puis tests UI Playwright sur le vrai serveur branché au faux Bitbucket |
| `npm run test:live` | test réel en lecture seule sur une PR au choix (`STRATA_LIVE_PR` = URL, `STRATA_LIVE_EMAIL`, `STRATA_KEYCHAIN_SERVICE`) |
| `npm run build:extension` / `npm run test:extension` | construit l'extension VS Code / test de fumée dans un VS Code isolé (faux Bitbucket) |
| `npm run package:extension` / `npm run extension:install` | `.vsix` dans `dist/` (vsce) / le construit et l'installe dans VS Code |
| `npm run build` / `npm start` / `npm run clean` | construit `dist/` / lance l'outil construit / supprime les builds |

Le `.npmrc` du projet contient `ignore-scripts=true` : npm n'exécute aucun script d'installation des dépendances
(aucune n'en a besoin). Les tests Playwright utilisent Python 3.10 de macOS par défaut (autre interpréteur via la
variable `PYTHON`).

La CI GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) lance lint, types, tests et tests UI, et
construit le `.vsix` (artefact téléchargeable). Pousser un tag `vX.Y.Z` égal à la version de `package.json` crée une
release GitHub avec le `.vsix` ; penser au CHANGELOG avant.

```
src/shared/api.ts      contrat de l'API (types partagés serveur ↔ page)
src/server/
  core/                règles pures : diff (Myers), fusion 3 voies, relocalisation, comparaison, modèle de PR
  bitbucket/           client REST Bitbucket et types bruts
  infra/               configuration, jeton (trousseau), cache disque
  services/            session, réglages, PR, accueil
  http/                application Hono : sécurité, routes, schémas zod
  app.ts · main.ts     assemblage et ligne de commande
src/web/               page Vue 3 (vues, composants, composables, lib/ = règles testées)
src/extension/         extension VS Code : panneau (webview), vue « Mes PR », diff natif, fichiers locaux ; lib/ = règles testées
extension/             manifeste de l'extension ; dist/ construit par `npm run build:extension`
scripts/               dev (serveur + Vite), construction de l'extension
test/                  unit · web · integration · e2e (Playwright) · live · support (faux Bitbucket à 6 PR)
```

Pile : TypeScript 5.9 strict, Hono 4 + zod 4 côté serveur, Vue 3.5 + vue-router + Vite 8 côté page, Vitest 5,
ESLint 9 (typescript-eslint, eslint-plugin-vue). Le serveur tourne aussi directement depuis les
sources (`node src/server/main.ts`, suppression de types native de Node 22).

## Comment le bruit des rebases est retiré

Pour comparer A → B : seuls les fichiers que la PR touche (en A ou en B) sont candidats, les autres viennent de master.
Si B a été rebasée, A est d'abord **rejouée sur la nouvelle base** par une fusion 3 voies ligne à ligne, puis comparée
à B : les lignes que master a changées dans `package-lock.json`, `package.json` ou `changelog.md` disparaissent, seules
celles de l'auteur restent. Détails : [docs/DESIGN.md](docs/DESIGN.md). Routes : [docs/API.md](docs/API.md).

## Limites connues

- **Like** : l'API Bitbucket n'expose pas les réactions. Un 👍 est posté comme une réponse « 👍 » (visible comme telle
  dans Bitbucket) ; les réponses d'un seul emoji sont affichées comme des réactions. Recliquer supprime ta réponse.
- **Commentaire sur une ligne** : seulement sur la dernière version (Bitbucket ancre les commentaires sur la version
  courante). Sur une ligne supprimée, l'outil poste un commentaire général qui cite la ligne.
- `npm audit` signale des alertes modérées dans l'outillage de lint (minimatch via typescript-eslint, sans correctif
  autre qu'une rétrogradation) ; rien dans ce qui s'exécute à l'usage.

## Données locales

`~/.config/strata/` (`%APPDATA%\strata` sous Windows ; `STRATA_CONFIG_DIR` pour changer) :
`config.json` (e-mail, dépôts), `state.json` (versions relues, fichiers vus), `cache/` (contenus immuables par commit,
peut être supprimé sans risque).

## Licence

[MIT](LICENSE). Historique des versions : [CHANGELOG.md](CHANGELOG.md).
