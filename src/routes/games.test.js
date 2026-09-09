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

test('ne rappelle pas Steam pour un second appel identique (cache)', async () => {
  mockSteamGamesFetch({
    response: { game_count: 1, games: [{ appid: 570, name: 'Dota 2', playtime_forever: 60 }] },
  });

  const first = await request(app).get('/api/steam/games').query({ steamid: '76561197960435533' });
  const second = await request(app).get('/api/steam/games').query({ steamid: '76561197960435533' });

  expect(first.body).toEqual({ games: [{ appid: 570, name: 'Dota 2', playtimeMinutes: 60 }] });
  // Même réponse servie depuis le cache, sans second aller-retour Steam.
  expect(second.body).toEqual(first.body);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('ne met jamais une erreur Steam en cache : le rappel suivant retente', async () => {
  // Premier appel en échec, second réussi : sans la garde (écriture du cache
  // uniquement après une réponse réussie), un incident Steam passager
  // resterait collé pendant tout le TTL.
  global.fetch = jest
    .fn()
    .mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    .mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ response: { games: [{ appid: 620, name: 'Portal 2', playtime_forever: 120 }] } }),
    }));

  const failed = await request(app).get('/api/steam/games').query({ steamid: '76561197960435534' });
  expect(failed.status).toBe(502);

  const retried = await request(app).get('/api/steam/games').query({ steamid: '76561197960435534' });
  expect(retried.status).toBe(200);
  expect(retried.body).toEqual({ games: [{ appid: 620, name: 'Portal 2', playtimeMinutes: 120 }] });
  expect(global.fetch).toHaveBeenCalledTimes(2);
});
