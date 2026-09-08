import { Router } from 'express';

const router = Router();

const STEAM_BASE = 'https://api.steampowered.com';

// Cache mémoire, même principe que côté Gamelary (games+api.ts/cover+api.ts
// dans le repo principal) : simple Map avec TTL, suffisant pour une seule
// instance de démo. Le schéma des succès (noms/descriptions) d'un jeu ne
// change presque jamais -> TTL long ; l'état débloqué change quand
// l'utilisateur joue -> TTL court.
const SCHEMA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PLAYER_CACHE_TTL_MS = 5 * 60 * 1000;
const schemaCache = new Map();
const playerCache = new Map();

function getCached(cache, key) {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  return null;
}

function setCached(cache, key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// GetSchemaForGame : liste des succès définis pour un jeu (apiname, nom et
// description affichés, icônes) — indépendant d'un joueur particulier.
async function fetchSchema(appid, apiKey) {
  const cacheKey = appid;
  const cached = getCached(schemaCache, cacheKey);
  if (cached) return cached;

  const url = `${STEAM_BASE}/ISteamUserStats/GetSchemaForGame/v2/?key=${apiKey}&appid=${appid}&l=french`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Steam GetSchemaForGame a échoué (${response.status})`);
  }
  const data = await response.json();
  const achievements = data.game?.availableGameStats?.achievements ?? [];
  setCached(schemaCache, cacheKey, achievements, SCHEMA_CACHE_TTL_MS);
  return achievements;
}

// GetPlayerAchievements : état débloqué/non débloqué pour CE joueur sur CE
// jeu. Peut échouer proprement (pas une erreur HTTP) si le profil ou le
// détail du jeu n'est pas public côté joueur — Steam renvoie alors
// `success: false` avec un message, à distinguer d'une vraie erreur réseau.
async function fetchPlayerAchievements(appid, steamid, apiKey) {
  const cacheKey = `${appid}:${steamid}`;
  const cached = getCached(playerCache, cacheKey);
  if (cached) return cached;

  const url = `${STEAM_BASE}/ISteamUserStats/GetPlayerAchievements/v0001/?key=${apiKey}&steamid=${steamid}&appid=${appid}&l=french`;
  const response = await fetch(url);
  if (!response.ok) {
    // Steam renvoie 400 pour un jeu sans succès configurés plutôt qu'une
    // liste vide : traité comme "aucun succès", pas comme une erreur.
    if (response.status === 400) return [];
    throw new Error(`Steam GetPlayerAchievements a échoué (${response.status})`);
  }
  const data = await response.json();
  if (data.playerstats?.success === false) {
    throw new Error(data.playerstats.error ?? 'Profil ou détails du jeu non publics sur Steam');
  }
  const achievements = data.playerstats?.achievements ?? [];
  setCached(playerCache, cacheKey, achievements, PLAYER_CACHE_TTL_MS);
  return achievements;
}

// GET /api/steam/achievements?appid=&steamid=
// Fusionne les deux appels ci-dessus en la forme attendue par Gamelary
// (voir Achievement, src/types/game.ts côté app) : { apiname, name,
// unlocked }. `apiname` (stable, fourni par Steam) sert de base à l'id
// généré côté client au moment de l'import, plutôt qu'un id purement
// aléatoire — deux imports successifs du même jeu retombent sur les mêmes
// entrées au lieu de les dupliquer.
router.get('/achievements', async (req, res) => {
  const appid = req.query.appid;
  const steamid = req.query.steamid;

  if (!appid || !steamid) {
    return res.status(400).json({ error: 'Paramètres "appid" et "steamid" requis' });
  }

  const apiKey = process.env.STEAM_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'STEAM_API_KEY non configurée côté serveur' });
  }

  try {
    const [schema, playerAchievements] = await Promise.all([
      fetchSchema(appid, apiKey),
      fetchPlayerAchievements(appid, steamid, apiKey),
    ]);

    const unlockedByApiName = new Map(playerAchievements.map((a) => [a.apiname, a.achieved === 1]));

    const achievements = schema.map((entry) => ({
      apiname: entry.name,
      name: entry.displayName || entry.name,
      unlocked: unlockedByApiName.get(entry.name) ?? false,
    }));

    res.json({ achievements });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Erreur inconnue' });
  }
});

export default router;
