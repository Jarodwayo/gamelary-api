import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import request from 'supertest';

import app from '../app.js';

// Même approche que pour achievements.test.js : on mocke `global.fetch`
// directement (fetch natif = undici, nock ne l'intercepte pas de façon
// fiable), aucun test ne dépend du réseau ni d'une vraie clé API.
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  process.env.STEAM_API_KEY = 'test-steam-key';
});

function mockSteamGamesFetch({ status = 200, response }) {
  global.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ response }),
  }));
}

test('renvoie la liste des jeux possédés avec leur temps de jeu pour un steamid valide', async () => {
  mockSteamGamesFetch({
    response: {
      game_count: 2,
      games: [
        { appid: 220, name: 'Half-Life 2', playtime_forever: 1234 },
        { appid: 400, name: 'Portal', playtime_forever: 300 },
      ],
    },
  });

  const res = await request(app).get('/api/steam/games').query({ steamid: '76561197960435530' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    games: [
      { appid: 220, name: 'Half-Life 2', playtimeMinutes: 1234 },
      { appid: 400, name: 'Portal', playtimeMinutes: 300 },
    ],
  });
});

test('rejette une requête sans steamid avec 400, sans appeler Steam', async () => {
  global.fetch = jest.fn();

  const res = await request(app).get('/api/steam/games');

  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: 'Paramètre "steamid" requis' });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('mappe une erreur HTTP Steam vers 502 sans exposer de détails internes', async () => {
  mockSteamGamesFetch({ status: 500, response: {} });

  const res = await request(app).get('/api/steam/games').query({ steamid: '76561197960435531' });

  expect(res.status).toBe(502);
  expect(res.body).toEqual({ error: 'Steam GetOwnedGames a échoué (500)' });
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(res.body.error).not.toContain('test-steam-key');
});

test('traite un profil privé/bibliothèque masquée (response vide) comme une liste vide, pas une erreur', async () => {
  mockSteamGamesFetch({ status: 200, response: {} });

  const res = await request(app).get('/api/steam/games').query({ steamid: '76561197960435532' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ games: [] });
});
