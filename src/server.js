import 'dotenv/config';

import cors from 'cors';
import express from 'express';

import achievementsRouter from './routes/achievements.js';

const app = express();

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

app.use('/api/steam', achievementsRouter);

const port = process.env.PORT ?? 3000;
app.listen(port, () => {
  console.log(`gamelary-api en écoute sur le port ${port}`);
});
