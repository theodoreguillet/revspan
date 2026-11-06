# Strata — API locale

Le contrat (types des requêtes et réponses) est défini une seule fois, en TypeScript, dans
[`src/shared/api.ts`](../src/shared/api.ts) : le serveur et la page l'importent tous les deux.
Les entrées sont validées côté serveur par zod ([`src/server/http/schemas.ts`](../src/server/http/schemas.ts)).

Règles communes :

- toutes les routes sont sous `/api`, en JSON ;
- toute requête autre que GET porte l'en-tête `X-Strata: 1` (sinon 403) ; une origine étrangère est refusée ;
- l'en-tête `Host` doit être `127.0.0.1:<port>` ou `localhost:<port>` ;
- erreur : statut ≠ 2xx et corps `ApiErrorBody` = `{ error: { code, message } }` (message en français).
  Codes notables : `NO_TOKEN` (409), `BB_UNAUTHORIZED` (401), `BB_FORBIDDEN` (403), `BB_NOT_FOUND` (404), `BAD_REQUEST` (400).

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| GET | `/api/health` | — | `Health` |
| GET | `/api/settings` | — | `Settings` |
| PUT | `/api/settings` | `SettingsUpdate` | `Settings` |
| POST | `/api/settings/test` | — | `ConnectionTest` |
| GET | `/api/home` | — | `Home` |
| GET | `/api/pr/:ws/:repo/:id` | — | `PrDetail` |
| GET | `/api/pr/:ws/:repo/:id/summary` | — | `Summary` (lent la 1re fois, puis cache disque) |
| GET | `/api/pr/:ws/:repo/:id/compare?from=&to=&context=` | — | `Comparison` (`from=0` : version complète contre sa base) |
| POST | `/api/pr/:ws/:repo/:id/comments` | `NewComment` | `Comment` |
| DELETE | `/api/pr/:ws/:repo/:id/comments/:cid` | — | `Ok` |
| POST / DELETE | `/api/pr/:ws/:repo/:id/comments/:cid/resolve` | — | `Ok` |
| POST | `/api/pr/:ws/:repo/:id/react` | `ReactRequest` | `{ reacted: boolean }` (bascule) |
| POST / DELETE | `/api/pr/:ws/:repo/:id/approve` | — | `Ok` (POST réapprouve si besoin) |
| POST / DELETE | `/api/pr/:ws/:repo/:id/request-changes` | — | `Ok` |
| POST | `/api/pr/:ws/:repo/:id/reviewed` | `{ version }` | `Ok` (marque locale « relue ») |
| POST | `/api/pr/:ws/:repo/:id/viewed` | `ViewedRequest` | `Ok` |

Page : SPA Vue servie depuis `dist/web`, routage par hash (`#/`, `#/pr/:ws/:repo/:id?from=&to=`, `#/settings`).
`GET /open?url=<URL Bitbucket de PR>` redirige vers `/#/pr/...`.
