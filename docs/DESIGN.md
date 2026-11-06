# Strata — conception

## Pourquoi

Beaucoup d'équipes travaillent en « une PR = un commit » : chaque retour de revue se traite par `git commit --amend`
(souvent avec un rebase sur master) puis un force-push. Bitbucket n'affiche alors que le diff complet de la PR
contre master : sur une PR longue, impossible de voir ce que le dernier amend a changé. Les PR peuvent durer
des jours ou des mois, avec des dizaines de versions et plusieurs rebases.

Strata est un petit outil local (serveur Node + page web, en TypeScript) qui reconstitue toutes les versions
d'une PR Bitbucket et permet de relire version par version, de commenter, répondre, liker, résoudre et approuver.

## Objectifs

- Comparer n'importe quelle version à n'importe quelle autre, ou une version complète à sa base master.
- Ne montrer que ce que l'auteur a changé : le bruit apporté par un rebase (fichiers ou lignes venus de master)
  est retiré.
- Reprendre là où on s'est arrêté : dernière relecture, nouvelles versions, nouveaux commentaires, fichiers vus.
- Agir depuis l'outil : commenter une ligne, répondre, liker, résoudre/rouvrir, approuver, demander des modifs.
- Accueil « Mes PR » sur une liste de dépôts configurable.

## Non-objectifs

- Pas d'hébergement partagé : chacun lance l'outil sur son poste avec son jeton.
- Pas de merge, decline, édition de PR, tâches Bitbucket.
- Pas de coloration syntaxique.

## Anti-objectifs

- Écrire sur Bitbucket sans action explicite de l'utilisateur.
- Exposer le jeton au navigateur ou au réseau (serveur sur 127.0.0.1 uniquement).
- Exécuter des scripts d'installation de dépendances (`ignore-scripts=true` dans le `.npmrc` du projet).

## Décisions

| Sujet | Décision |
|---|---|
| Forme | Application TypeScript : serveur Node 22 (Hono, validation zod) + page Vue 3 (Vite, vue-router), contrat partagé `src/shared/api.ts`. Pas de store global : composables. |
| Architecture serveur | `core/` règles pures (diff, fusion, comparaison, modèle) · `bitbucket/` client REST · `infra/` config, jeton, cache · `services/` session, réglages, PR, accueil · `http/` routes Hono et schémas zod. |
| Lancement | `npm ci && npm run build` puis `node bin/strata.js [URL de PR]` → ouvre le navigateur sur `http://127.0.0.1:7420`. Développement : `npm run dev` (serveur en watch + Vite) ou `npm run dev:fake` (faux Bitbucket). Pas de Makefile : tout passe par les scripts npm. |
| Dépendances | npm standard, lockfile sur registry.npmjs.org, aucun script d'installation exécuté (`.npmrc`). |
| Jeton | Jeton API Atlassian (e-mail + jeton, Basic auth). Saisi dans l'écran Réglages. macOS : trousseau (`security`, jeton passé par stdin). Linux : `secret-tool` si présent. Sinon fichier `0600` dans le dossier de config. |
| Droits du jeton | `read:user:bitbucket`, `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`. |
| Config / état | `~/.config/strata/` (`%APPDATA%\strata` sous Windows) : `config.json`, `state.json`, `cache/`. |
| Versions | Entrées `update` de l'activité de la PR (hash source + hash master au moment du push), doublons consécutifs retirés, version courante de la PR ajoutée si absente. |
| Base d'une version | `merge-base(version, master au moment du push)` via l'API (repli : 1er parent). Le hash master de l'activité n'est pas la base : si la branche a été créée avant les derniers commits de master, la base est plus ancienne que le master noté au moment du push. |
| Rebase | Une version est un rebase si sa base diffère de celle de la version précédente. |
| Diff entre versions A → B | Fichiers candidats = fichiers différents entre les deux commits ∩ (fichiers de la PR en A ∪ en B). Les autres sont « venus de master » et masqués. Si même base : diff direct. Sinon, A est « rejoué » sur la base de B par fusion 3 voies ligne à ligne (ancêtre = base A, nôtre = base B, leur = A) ; en zone de conflit on garde les lignes de A (fichier marqué). Puis diff (A rejoué → B). Un filtrage par fichier ne suffit pas : `package-lock.json`, `package.json` et `changelog.md` sont souvent touchés par master et par l'auteur. |
| Résumé par version | Diff (v(n-1) → vn) par la même méthode. Type : `creation`, `code`, `deps` (seulement package.json / lockfiles), `rebase-only`, `message-only`, `none`. Mis en cache sur disque (les commits sont immuables). |
| Moteur de diff | Myers sur lignes (préfixe/suffixe communs retirés, plafond de distance puis repli bloc), hunks avec contexte, surlignage intra-ligne par préfixe/suffixe commun. Fusion 3 voies maison. |
| Dernière relecture | max(dernière approbation, dernier commentaire, marque locale « relue »), chacune convertie en version via sa date. Approuver ou commenter la fait avancer automatiquement. |
| Fichiers vus | Locaux, mémorisés avec l'empreinte du contenu côté B ; la coche saute si le fichier change. |
| Commentaires | Fils reconstruits (parent). Chaque commentaire est rattaché à la version en cours à sa date. Ancrage `to` relocalisé ligne à ligne vers la version affichée (marqué « ligne modifiée » si la ligne a changé). Ancrage `from` seul : affiché au niveau du fichier. Contenu : HTML rendu par Bitbucket, assaini côté client par liste blanche. |
| Like | L'API Bitbucket n'expose pas les réactions. Like = réponse « 👍 » ; les réponses composées d'un seul emoji (👍, :+1:, :thumbsup:, +1) sont affichées comme réactions. Unlike = suppression de sa propre réponse. |
| Commentaire en ligne | Possible seulement si B est la dernière version, côté nouveau (lignes ajoutées ou de contexte) : `inline.to`. Sur une ligne supprimée, commentaire général citant fichier, ligne et code. |
| Approbations | Version d'approbation déduite de l'activité ; « périmée » si une version avec du code est arrivée depuis. |
| Accueil | PR ouvertes des dépôts configurés, groupées : À relire / Réapprobation rapide (seulement rebases) / À jour / Mes PR / Autres. |
| Sécurité locale | Écoute 127.0.0.1 seulement. En-tête `Host` vérifié (anti DNS-rebinding). Toute requête qui modifie exige l'en-tête `X-Strata: 1` (bloque les formulaires et requêtes d'autres sites). Le jeton ne quitte jamais le serveur. |
| Extension VS Code | Même page Vue dans un webview et mêmes services. Les appels d'API passent par messages (`src/shared/webview-protocol.ts`) et sont traités par l'application Hono en mémoire (`app.request`, sans port), avec la même validation. Jeton dans le stockage sécurisé de VS Code, dépôts suivis dans le réglage `strata.repositories` (source de dépôts injectée dans `Store`), autres données dans le stockage global de l'extension (séparées de la version web). Ajouts propres à VS Code : vue « Mes PR » (TreeView), « Ouvrir le fichier » (dépôt de l'espace de travail, worktree de la branche de la PR préféré), « Diff VS Code » (documents virtuels + `vscode.diff`, mêmes côtés que la page). Bundle CommonJS unique (Vite, `vscode` externe). |
| Dernière relecture (précision) | Les réponses et les réactions (👍) ne comptent pas comme relecture ; seuls les nouveaux commentaires, approbations et demandes de modifs. |
| Tests | Vitest : unitaires (diff, fusion, relocalisation, versions, fils, état), règles de la page (sélection, repli, bandeau, assainissement), intégration du serveur contre un faux Bitbucket à 6 PR (écritures comprises, chaque test isolé) ; UI Playwright sur le vrai serveur branché au même faux Bitbucket ; test réel en lecture seule sur une PR au choix (`npm run test:live`, invariants et diff complet identique au diffstat de Bitbucket) ; test de fumée de l'extension dans un VS Code isolé (`npm run test:extension`). Aucune écriture sur le vrai Bitbucket pendant les tests. |

## Laissé au constructeur

Mise en page fine, raccourcis clavier exacts, messages d'erreur, stratégie de cache mémoire des données vivantes.
