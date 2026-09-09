import { Router } from 'express';

const router = Router();

const STEAM_BASE = 'https://api.steampowered.com';

// IPlayerService/GetOwnedGames : bibliothèque Steam complète d'un joueur
// (appid, nom, temps de jeu total). Contrairement à GetSchemaForGame /
// GetPlayerAchievements (route achievements.js), pas d'appid en entrée :
// c'est un appel unique pour tout le compte.
async function fetchOwnedGames(steamid, apiKey) {
  const url = `${STEAM_BASE}/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${encodeURIComponent(steamid)}&format=json&include_appinfo=1`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Steam GetOwnedGames a échoué (${response.status})`);
  }
  const data = await response.json();
  // Profil Steam privé ou bibliothèque de jeux masquée : Steam renvoie un
  // 200 avec `response: {}` (ni `games` ni `game_count`), pas une erreur —
  // traité comme une bibliothèque vide, jamais comme une panne.
  return data.response?.games ?? [];
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
