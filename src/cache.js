import { createClient } from 'redis';

// Cache partagé Redis quand REDIS_URL est configurée (Render), sinon repli
// sur une simple Map en mémoire — ce qui garde le développement local
// utilisable sans avoir à faire tourner un Redis local, et évite qu'une
// panne de connexion Redis fasse tomber tout le service (une erreur de
// cache ne doit jamais empêcher de répondre, juste refaire l'appel Steam).
// Contrairement à la Map en mémoire seule (limite documentée côté Gamelary,
// voir ARCHITECTURE.md §8 du repo principal), Redis survit à un redémarrage
// du service et serait partagé si plusieurs instances tournaient.
const memoryCache = new Map();

let redisClient = null;
let redisReady = false;

if (process.env.REDIS_URL) {
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => {
    // Ne jamais laisser une erreur Redis (connexion coupée, etc.) planter
    // le process : les routes retombent sur la Map en mémoire tant que
    // redisReady est false.
    redisReady = false;
    console.error('Redis error:', err.message);
  });
  redisClient.on('ready', () => {
    redisReady = true;
  });
  redisClient.connect().catch((err) => {
    console.error('Redis connection failed, using in-memory cache instead:', err.message);
  });
}

export async function getCached(key) {
  if (redisClient && redisReady) {
    try {
      const raw = await redisClient.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.error('Redis get failed, falling back to memory cache:', err.message);
    }
  }
  const entry = memoryCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  return null;
}

export async function setCached(key, value, ttlMs) {
  if (redisClient && redisReady) {
    try {
      await redisClient.set(key, JSON.stringify(value), { PX: ttlMs });
      return;
    } catch (err) {
      console.error('Redis set failed, falling back to memory cache:', err.message);
    }
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
