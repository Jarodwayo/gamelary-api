import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import request from 'supertest';

import app from '../app.js';

// On mocke `global.fetch` directement (plutôt que nock) : le code appelle
// le fetch natif de Node, qui tourne sur undici — nock n'intercepte de
// façon fiable que http/https, pas undici. Mocker fetch évite ce problème
// de compatibilité et reste simple à lire.
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  // Requis par la route (500 sinon) ; jamais une vraie clé, jamais un vrai appel réseau.
  process.env.STEAM_API_KEY = 'test-steam-key';
});

function mockSteamFetch({
  schema = [],
  schemaStatus = 200,
  playerAchievements = [],
  playerStatus = 200,
  playerSuccess = true,
  playerError,
}) {
  global.fetch = jest.fn(async (url) => {
    if (url.includes('GetSchemaForGame')) {
      return {
        ok: schemaStatus >= 200 && schemaStatus < 300,
        status: schemaStatus,
        json: async () => ({ game: { availableGameStats: { achievements: schema } } }),
      };
    }
    return {
      ok: playerStatus >= 200 && playerStatus < 300,
      status: playerStatus,
      json: async () => ({
        playerstats: playerSuccess
          ? { success: true, achievements: playerAchievements }
          : { success: false, error: playerError ?? 'Profil ou détails du jeu non publics sur Steam' },
      }),
    };
  });
}

// Chaque test utilise un appid/steamid distinct : le cache (Map en mémoire,
// partagée entre les tests du fichier) est indexé par ces valeurs, donc pas
// de couple identique => pas de résultat d'un test qui "fuit" dans un autre.

test('fusionne schéma et succès du joueur pour des paramètres valides', async () => {
  mockSteamFetch({
    schema: [
      { name: 'ACH_WIN_ONE_GAME', displayName: 'Première victoire' },
      { name: 'ACH_WIN_100_GAMES', displayName: 'Cent victoires' },
    ],
    playerAchievements: [{ apiname: 'ACH_WIN_ONE_GAME', achieved: 1 }],
  });

  const res = await request(app)
    .get('/api/steam/achievements')
    .query({ appid: '10', steamid: '76561197960435530' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    achievements: [
      { apiname: 'ACH_WIN_ONE_GAME', name: 'Première victoire', unlocked: true },
      { apiname: 'ACH_WIN_100_GAMES', name: 'Cent victoires', unlocked: false },
    ],
  });
});

test('rejette une requête sans steamid avec 400, sans appeler Steam', async () => {
  global.fetch = jest.fn();

  const res = await request(app).get('/api/steam/achievements').query({ appid: '11' });

  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: 'Paramètres "appid" et "steamid" requis' });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('mappe une erreur HTTP Steam vers 502 sans exposer de détails internes', async () => {
  mockSteamFetch({ schemaStatus: 500 });

  const res = await request(app)
    .get('/api/steam/achievements')
    .query({ appid: '20', steamid: '76561197960435531' });

  expect(res.status).toBe(502);
  expect(res.body).toEqual({ error: 'Steam GetSchemaForGame a échoué (500)' });
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(res.body.error).not.toContain('test-steam-key');
});

test('mappe un profil Steam non public (success: false) vers 502 avec le message Steam', async () => {
  mockSteamFetch({
    schema: [{ name: 'ACH_X', displayName: 'Succès X' }],
    playerSuccess: false,
    playerError: 'Profil du joueur non public',
  });

  const res = await request(app)
    .get('/api/steam/achievements')
    .query({ appid: '30', steamid: '76561197960435532' });

  expect(res.status).toBe(502);
  expect(res.body).toEqual({ error: 'Profil du joueur non public' });
});

test('les valeurs acceptées arrivent telles quelles dans les URLs Steam', async () => {
  // Verrouille ce qui est RÉELLEMENT garanti depuis que la route valide ses
  // deux paramètres : seuls des chiffres atteignent l'URL sortante.
  // Un premier jet de ce test vérifiait l'encodage (`encodeURIComponent`) —
  // il était creux et mesuré comme tel : retirer les deux encodages ne le
  // faisait pas échouer, la validation rendant tout caractère à encoder
  // impossible à faire passer. L'encodage reste en place par ceinture et
  // bretelles, mais ce n'est plus lui le garde-fou (voir achievements.js).
  mockSteamFetch({ schema: [] });

  await request(app)
    .get('/api/steam/achievements')
    .query({ appid: '40', steamid: '76561197960435533' });

  const urls = global.fetch.mock.calls.map((call) => call[0]);
  expect(urls.some((url) => url.includes('GetSchemaForGame'))).toBe(true);
  for (const url of urls) {
    const params = new URL(url).searchParams;
    expect(params.get('appid')).toBe('40');
    if (params.has('steamid')) expect(params.get('steamid')).toBe('76561197960435533');
  }
});

test('ne rappelle pas Steam pour un second appel identique (cache)', async () => {
  // Le cache d'achievements.js n'était vérifié par aucun test : le
  // supprimer entièrement laissait la suite verte.
  mockSteamFetch({
    schema: [{ name: 'ACH_A', displayName: 'A' }],
    playerAchievements: [{ apiname: 'ACH_A', achieved: 1 }],
  });

  const first = await request(app)
    .get('/api/steam/achievements')
    .query({ appid: '50', steamid: '76561197960435534' });
  const callsAfterFirst = global.fetch.mock.calls.length;

  const second = await request(app)
    .get('/api/steam/achievements')
    .query({ appid: '50', steamid: '76561197960435534' });

  expect(second.body).toEqual(first.body);
  expect(global.fetch.mock.calls.length).toBe(callsAfterFirst);
});

test('le schéma survit à l’expiration des succès du joueur (TTL distincts)', async () => {
  // La définition des succès d'un jeu est quasi statique (7 jours), l'état
  // débloqué change quand le joueur joue (5 minutes). Échanger les deux
  // valeurs ne faisait échouer aucun test — la ligne du README sur les TTL
  // n'était vérifiée nulle part.
  const now = jest.spyOn(Date, 'now');
  const t0 = 1_800_000_000_000;
  now.mockReturnValue(t0);

  mockSteamFetch({
    schema: [{ name: 'ACH_B', displayName: 'B' }],
    playerAchievements: [{ apiname: 'ACH_B', achieved: 0 }],
  });
  await request(app)
    .get('/api/steam/achievements')
    .query({ appid: '60', steamid: '76561197960435535' });

  // 10 minutes plus tard : les succès du joueur ont expiré, pas le schéma.
  now.mockReturnValue(t0 + 10 * 60 * 1000);
  global.fetch.mockClear();
  await request(app)
    .get('/api/steam/achievements')
    .query({ appid: '60', steamid: '76561197960435535' });

  const urls = global.fetch.mock.calls.map((call) => call[0]);
  expect(urls.some((url) => url.includes('GetPlayerAchievements'))).toBe(true);
  expect(urls.some((url) => url.includes('GetSchemaForGame'))).toBe(false);

  now.mockRestore();
});

test('rejette un appid ou un steamid mal formé avec 400, sans appeler Steam', async () => {
  // Même règle que la route ?steamAppId= côté Gamelary, qui validait déjà
  // l'entier positif alors qu'ici tout passait tel quel jusqu'à Steam.
  global.fetch = jest.fn();

  const badAppid = await request(app)
    .get('/api/steam/achievements')
    .query({ appid: '10; DROP', steamid: '76561197960435536' });
  expect(badAppid.status).toBe(400);
  expect(badAppid.body).toEqual({ error: 'Paramètre "appid" invalide' });

  const badSteamid = await request(app)
    .get('/api/steam/achievements')
    .query({ appid: '10', steamid: 'pas-un-steamid' });
  expect(badSteamid.status).toBe(400);
  expect(badSteamid.body).toEqual({ error: 'Paramètre "steamid" invalide' });

  expect(global.fetch).not.toHaveBeenCalled();
});
