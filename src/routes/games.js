import { Router } from 'express';

import { getCached, setCached } from '../cache.js';

const router = Router();

const STEAM_BASE = 'https://api.steampowered.com';

// Même TTL que les succès débloqués du joueur (PLAYER_CACHE_TTL_MS,
// achievements.js) : c'est la même classe de volatilité — ça bouge quand
// l'utilisateur joue, pas plus vite. Deux données de même volatilité, même
// TTL, plutôt qu'un troisième chiffre choisi au hasard.
const OWNED_GAMES_CACHE_TTL_MS = 5 * 60 * 1000;

// IPlayerService/GetOwnedGames : bibliothèque Steam complète d'un joueur
// (appid, nom, temps de jeu total). Contrairement à GetSchemaForGame /
// GetPlayerAchievements (route achievements.js), pas d'appid en entrée :
// c'est un appel unique pour tout le compte.
async function fetchOwnedGames(steamid, apiKey) {
  const cacheKey = `steam:owned:${steamid}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const url = `${STEAM_BASE}/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${steamid}&format=json&include_appinfo=1`;
  const response = await fetch(url);
  if (!response.ok) {
    // Rien n'est écrit en cache ici : une erreur Steam passagère ne doit pas
    // rester collée pendant tout le TTL (voir le test dédié).
    throw new Error(`Steam GetOwnedGames a échoué (${response.status})`);
  }
  const data = await response.json();
  // Profil Steam privé ou bibliothèque de jeux masquée : Steam renvoie un
  // 200 avec `response: {}` (ni `games` ni `game_count`), pas une erreur —
  // traité comme une bibliothèque vide, jamais comme une panne. Ce cas est
  // mis en cache comme les autres : conséquence assumée, un profil repassé
  // en public reste vu vide jusqu'à expiration du TTL (5 min).
  const ownedGames = data.response?.games ?? [];
  // Réponse brute mise en cache (avant le mapping fait par la route), comme
  // dans achievements.js : le cache reste valable si la forme de sortie change.
  await setCached(cacheKey, ownedGames, OWNED_GAMES_CACHE_TTL_MS);
  return ownedGames;
}

// GET /api/steam/games?steamid=
router.get('/games', async (req, res) => {
  const steamid = req.query.steamid;

  if (!steamid) {
    return res.status(400).json({ error: 'Paramètre "steamid" requis' });
  }

  const apiKey = process.env.STEAM_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'STEAM_API_KEY non configurée côté serveur' });
  }

  try {
    const ownedGames = await fetchOwnedGames(steamid, apiKey);

    const games = ownedGames.map((entry) => ({
      appid: entry.appid,
      name: entry.name,
      playtimeMinutes: entry.playtime_forever,
    }));

    res.json({ games });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Erreur inconnue' });
  }
});

export default router;
