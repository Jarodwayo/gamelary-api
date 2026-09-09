import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';

import achievementsRouter from './routes/achievements.js';
import gamesRouter from './routes/games.js';

// Séparé de server.js pour rester importable par les tests (Supertest) sans
// jamais ouvrir de vrai port réseau — server.js reste le seul responsable
// de app.listen().
const app = express();

// Déployé derrière le reverse proxy Render (un seul hop) : sans ça,
// express-rate-limit lirait req.ip comme l'IP interne de ce hop plutôt que
// celle du visiteur (X-Forwarded-For), et compterait tous les visiteurs dans
// le même seau. `1` = ne fait confiance qu'au premier hop devant
// l'application, pas à un X-Forwarded-For arbitraire plus loin dans la
// chaîne.
app.set('trust proxy', 1);

// ALLOWED_ORIGINS vide (par défaut) = toutes origines acceptées. Ce backend
// ne protège qu'une chose (la clé Steam, jamais renvoyée au client — voir
// routes/achievements.js), donc restreindre les origines n'apporte pas de
// sécurité supplémentaire ici ; à resserrer si le projet grandit au-delà
// d'une démo solo.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors(allowedOrigins.length > 0 ? { origin: allowedOrigins } : undefined));

// Ping simple pour vérifier que le déploiement Render tourne, et pour le
// réveiller après une mise en veille (offre gratuite Render) sans dépendre
// d'un appel Steam réel.
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'gamelary-api' });
});

// CORS ouvert + zéro auth (voir plus haut) : n'importe quel site tiers peut
// autrement faire consommer le quota Steam de cette instance par ses propres
// visiteurs. Pas d'identité utilisateur ici (pas de compte, voir §9
// ARCHITECTURE.md côté Gamelary) donc par IP plutôt que par clé — ne protège
// que le quota, pas un sujet d'auth. Seules les routes Steam sont limitées :
// `/` (ping Render) doit rester appelable librement pour réveiller le
// service.
const steamRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessaie dans une minute' },
});

// Monté UNE SEULE FOIS pour le préfixe, pas répété sur chaque routeur :
// répété, une requête vers /games traversait les deux montages (le premier
// incrémente le compteur, son routeur ne matche pas, le second incrémente à
// nouveau) et comptait donc double — 15 requêtes/min réelles sur /games
// contre 30 sur /achievements, pour une limite pourtant annoncée identique.
app.use('/api/steam', steamRateLimiter);
app.use('/api/steam', achievementsRouter);
app.use('/api/steam', gamesRouter);

export default app;
