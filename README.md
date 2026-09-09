# gamelary-api

Petit backend Node.js/Express qui relaie la [Steam Web API](https://steamcommunity.com/dev)
pour [Gamelary](https://github.com/Jarodwayo/Gamelary) — bibliothèque de
jeux vidéo façon Letterboxd. Sert deux choses, sans jamais exposer la clé
API Steam au client mobile :

- **les succès d'un jeu** (`ISteamUserStats/GetPlayerAchievements` +
  `GetSchemaForGame`), fusionnés en une seule réponse ;
- **la bibliothèque Steam du joueur et son temps de jeu**
  (`IPlayerService/GetOwnedGames`).

## Pourquoi un backend séparé plutôt qu'une route dans Gamelary

Gamelary utilise déjà des routes serveur `expo-router` (`+api.ts`) pour
IGDB et SteamGridDB (voir `ARCHITECTURE.md` du repo principal, §7) — ces
deux API acceptent un en-tête `Authorization: Bearer` ou `Client-ID`. La
Steam Web API, elle, n'accepte la clé **que** comme paramètre d'URL
(`?key=...`), incompatible avec le système d'identifiants managés utilisé
pour ce projet. Un petit service Express indépendant, où la clé vit dans
une simple variable d'environnement lue par le code (`process.env
.STEAM_API_KEY`), reste la façon la plus simple de la garder hors du bundle
client tout en construisant l'URL Steam soi-même.

## Endpoints

### `GET /`

Ping de santé (`{ status: "ok" }`) — sert aussi à réveiller le service
après une mise en veille sur l'offre gratuite Render.

### `GET /api/steam/achievements?appid=&steamid=`

- `appid` : app id Steam du jeu (voir `Game.steamAppId` côté Gamelary,
  résolu depuis les `external_games` d'IGDB).
- `steamid` : SteamID64 du joueur (champ "Lier mon compte Steam" du profil
  Gamelary).

Les deux paramètres sont validés avant tout appel sortant (`appid` :
chiffres ; `steamid` : 17 chiffres) — un format invalide donne un `400`
sans consommer de quota Steam ni créer d'entrée de cache.

Fusionne `GetSchemaForGame` (définition des succès : nom, description) et
`GetPlayerAchievements` (état débloqué pour ce joueur) en une seule
réponse :

```json
{
  "achievements": [
    { "apiname": "ACH_WIN_ONE_GAME", "name": "Première victoire", "unlocked": true }
  ]
}
```

Erreurs renvoyées telles quelles (ex. profil Steam ou détails du jeu non
publics — Steam l'indique sans erreur HTTP, ce endpoint la transforme en
`502` avec un message clair) plutôt que masquées.

### `GET /api/steam/games?steamid=`

- `steamid` : SteamID64 du joueur (même champ que ci-dessus).

Bibliothèque Steam complète du joueur avec son temps de jeu total
(`IPlayerService/GetOwnedGames`), utilisée côté Gamelary pour compléter les
heures des jeux suivis et créer ceux que le catalogue ne connaît pas encore :

```json
{
  "games": [
    { "appid": 220, "name": "Half-Life 2", "playtimeMinutes": 1234 }
  ]
}
```

Un profil privé ou une bibliothèque masquée n'est **pas** une erreur côté
Steam : l'API renvoie un `200` avec un objet `response` vide. Ce endpoint le
traduit en liste vide (`{ "games": [] }`), à distinguer d'une vraie panne
(`502`).

## Développement local

```bash
npm install
cp .env.example .env   # puis renseigner STEAM_API_KEY (voir plus bas)
npm run dev
```

Obtenir une clé Steam Web API : https://steamcommunity.com/dev/apikey
(un compte Steam suffit, gratuit).

## Déploiement (Render)

1. Créer un compte sur [render.com](https://render.com) si besoin
   (offre gratuite suffisante pour une démo — le service se met en veille
   après une période d'inactivité et redémarre au premier appel, avec un
   délai de quelques secondes).
2. **New +** → **Web Service** → connecter ce repo GitHub
   (`Jarodwayo/gamelary-api`).
3. Build Command : `npm install` — Start Command : `npm start`.
4. Onglet **Environment** : ajouter `STEAM_API_KEY` avec la vraie clé,
   `REDIS_URL` si un cache partagé est disponible (voir plus bas — optionnel),
   et `ALLOWED_ORIGINS` si besoin de restreindre les origines plus tard —
   **jamais** dans le repo Git, uniquement ici.
5. Une fois déployé, Render donne une URL du type
   `https://gamelary-api.onrender.com`. C'est cette URL que Gamelary doit
   appeler (`EXPO_PUBLIC_STEAM_API_URL`, `.env` à la racine du repo
   principal — voir `src/lib/steam-api-url.ts` côté app).

## Cache (Redis, optionnel)

Les trois appels Steam sont mis en cache (`src/cache.js`) pour éviter de
rappeler Steam à chaque requête, avec un TTL choisi selon la volatilité de
la donnée :

| Appel Steam | TTL | Pourquoi |
|---|---|---|
| `GetSchemaForGame` | 7 jours | Définition des succès d'un jeu : quasi statique |
| `GetPlayerAchievements` | 5 minutes | Change quand le joueur joue |
| `GetOwnedGames` | 5 minutes | Même volatilité que ci-dessus (le temps de jeu bouge quand le joueur joue) — même TTL, plutôt qu'une troisième valeur arbitraire |

La distinction entre ces TTL est vérifiée par un test (échanger les deux
valeurs le fait échouer) : elle ne tenait auparavant qu'à cette ligne de
README.

Une réponse en erreur n'est **jamais** mise en cache (l'écriture n'a lieu
qu'après une réponse Steam réussie) : un incident passager côté Steam ne
reste donc pas collé pendant tout le TTL. En revanche une bibliothèque vide
pour cause de profil privé est mise en cache comme une réponse normale —
conséquence assumée : repasser son profil en public reste sans effet visible
jusqu'à expiration du TTL (5 min). Sans `REDIS_URL`, ce cache est une simple `Map` en
mémoire — fonctionne, mais se vide à chaque redémarrage du service et ne
serait pas partagé si plusieurs instances tournaient. Avec `REDIS_URL`
configurée (ex. Render Key Value, Upstash...), le cache passe sur Redis
automatiquement, sans changement de code ailleurs. Une panne de connexion
Redis ne fait jamais échouer une requête : le code retombe silencieusement
sur la Map en mémoire dans ce cas (voir les logs du service pour le
diagnostiquer).

## Sécurité

- La clé Steam ne vit que dans les variables d'environnement du serveur
  (locales via `.env`, ignoré par git — voir `.gitignore` ; en production
  via l'onglet Environment de Render) — jamais commitée, jamais renvoyée
  au client.
- CORS ouvert par défaut (`ALLOWED_ORIGINS` vide) : ce service ne protège
  qu'un secret côté serveur qui n'est de toute façon jamais exposé au
  client, restreindre les origines n'ajoute donc pas de sécurité
  supplémentaire ici — à resserrer si le projet grandit au-delà d'une
  démo solo.
