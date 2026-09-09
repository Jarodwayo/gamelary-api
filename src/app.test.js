import { afterEach, expect, jest, test } from '@jest/globals';
import request from 'supertest';

// app.js lit ALLOWED_ORIGINS une seule fois, au chargement du module (voir
// app.js) : pas moyen de rejouer les deux comportements (ouvert vs
// restreint) sur une seule instance déjà importée. Un import dynamique avec
// une query string différente à chaque appel force Node à recharger le
// module ESM depuis zéro (cache par spécificateur d'URL, pas par chemin
// fichier), donc à relire process.env.ALLOWED_ORIGINS à ce moment précis —
// plutôt qu'un mock de `cors`, qui ne prouverait rien sur la vraie config.
async function freshApp() {
  const module = await import(`./app.js?t=${Date.now()}-${Math.random()}`);
  return module.default;
}

const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

afterEach(() => {
  if (originalAllowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
});

test('ALLOWED_ORIGINS vide (par défaut) : le header CORS autorise toute origine', async () => {
  delete process.env.ALLOWED_ORIGINS;
  const app = await freshApp();

  const res = await request(app).get('/').set('Origin', 'https://n-importe-quel-site.example');

  expect(res.status).toBe(200);
  expect(res.headers['access-control-allow-origin']).toBe('*');
});

test('ALLOWED_ORIGINS renseignée : une origine listée reçoit le header CORS en écho', async () => {
  process.env.ALLOWED_ORIGINS = 'https://allowed.example';
  const app = await freshApp();

  const res = await request(app).get('/').set('Origin', 'https://allowed.example');

  expect(res.status).toBe(200);
  expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example');
});

test('ALLOWED_ORIGINS renseignée : une origine non listée ne reçoit aucun header CORS', async () => {
  process.env.ALLOWED_ORIGINS = 'https://allowed.example';
  const app = await freshApp();

  const res = await request(app).get('/').set('Origin', 'https://autre-site.example');

  expect(res.status).toBe(200);
  expect(res.headers['access-control-allow-origin']).toBeUndefined();
});

test('les routes Steam sont limitées par IP au-delà du quota', async () => {
  process.env.STEAM_API_KEY = 'test-steam-key';
  // Instance neuve : le compteur du limiteur vit dans le module, il doit
  // repartir de zéro pour que ce test ne dépende pas des autres.
  const app = await freshApp();
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ response: { games: [] } }) }));

  // La limite est de 30 requêtes par minute (voir app.js).
  for (let i = 0; i < 30; i += 1) {
    const res = await request(app).get('/api/steam/games').query({ steamid: `7656119796043${i}` });
    expect(res.status).not.toBe(429);
  }

  const blocked = await request(app).get('/api/steam/games').query({ steamid: '76561197960439999' });
  expect(blocked.status).toBe(429);

  // Le ping de santé reste joignable : c'est lui qui réveille le service
  // endormi sur l'offre gratuite Render.
  const ping = await request(app).get('/');
  expect(ping.status).toBe(200);
});
