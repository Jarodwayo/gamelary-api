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

test('rejette un steamid mal formé avec 400, sans appeler Steam', async () => {
  // Même règle que la route équivalente (achievements.js) : un SteamID64
  // fait 17 chiffres. Une valeur collée dans le champ "Lier mon compte
  // Steam" n'est validée nulle part côté app (voir game-store.tsx côté
  // Gamelary) — une frontière système ne fait pas confiance à son appelant.
  global.fetch = jest.fn();

  const res = await request(app)
    .get('/api/steam/games')
    .query({ steamid: '76561197960435540&format=xml' });

  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: 'Paramètre "steamid" invalide' });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('seuls des chiffres atteignent l’URL Steam depuis que le steamid est validé', async () => {
  // Verrouille ce qui est RÉELLEMENT garanti depuis que la route valide son
  // paramètre : un premier jet de ce test vérifiait l'encodage
  // (`encodeURIComponent`) d'une valeur injectée — devenu creux, la
  // validation rejetant désormais toute valeur à encoder avant même
  // d'atteindre l'URL (voir achievements.js pour le même raisonnement).
  mockSteamGamesFetch({ response: { games: [] } });

  await request(app).get('/api/steam/games').query({ steamid: '76561197960435540' });

  const calledUrl = global.fetch.mock.calls[0][0];
  expect(new URL(calledUrl).searchParams.get('steamid')).toBe('76561197960435540');
});
