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
