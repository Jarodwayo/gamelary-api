import { afterEach, expect, test } from '@jest/globals';
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
