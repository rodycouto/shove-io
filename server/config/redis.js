// server/config/redis.js
// ============================================================================
// Gerenciador de Cache Redis Otimizado (Shove.io):
// - Armazena no Redis APENAS informações dos usuários (shove:user:<id>) e
//   metadados das salas criadas (shove:room:<id>).
// - NÃO utiliza Redis Adapter no Socket.io durante as partidas: tudo o que
//   acontece dentro da partida (física 30Hz, inputs, colisões, power-ups)
//   roda 100% na memória RAM para garantir o menor ping possível!
// ============================================================================

const Redis = require('ioredis');
const ENV = require('./env');

let redisClient = null;
let isRedisConnected = false;

const USER_TTL_SECONDS = 24 * 60 * 60; // 24h para usuários registrados
const GUEST_TTL_SECONDS = 2 * 60 * 60; // 2h para convidados
const ROOM_TTL_SECONDS = 2 * 60 * 60;  // 2h para salas criadas

function tryConnectSingleRedis(url, options) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (clientInstance) => {
      if (!settled) {
        settled = true;
        resolve(clientInstance);
      }
    };

    const client = url ? new Redis(url, options) : new Redis(options);

    client.on('error', (err) => {
      if (!settled && err.code !== 'ECONNREFUSED' && err.code !== 'ENOTFOUND') {
        console.warn(`[REDIS Aviso]: ${err.message}`);
      }
    });

    client
      .connect()
      .then(() => finish(client))
      .catch(() => {
        try {
          client.disconnect();
        } catch (_) {}
        finish(null);
      });
  });
}

async function connectRedis() {
  if (!ENV.REDIS_ENABLED) {
    console.log('[REDIS] Desativado via configuração (.env REDIS_ENABLED=false).');
    return false;
  }

  const commonOptions = {
    lazyConnect: true,
    family: 0,
    connectTimeout: 4000,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 250, 1500);
    }
  };

  try {
    const discloudOptions = {
      ...commonOptions,
      host: ENV.REDIS_HOST,
      port: ENV.REDIS_PORT,
      username: ENV.REDIS_USERNAME || 'default',
      password: ENV.REDIS_PASSWORD || undefined,
      db: ENV.REDIS_DB || 0
    };

    console.log(`[REDIS] Tentando conectar ao Redis (${ENV.REDIS_HOST}:${ENV.REDIS_PORT})...`);
    let connectedMain = await tryConnectSingleRedis(ENV.REDIS_URL || null, discloudOptions);

    if (!connectedMain && ENV.REDIS_HOST !== '127.0.0.1' && ENV.REDIS_HOST !== 'localhost') {
      connectedMain = await tryConnectSingleRedis(null, {
        ...commonOptions,
        host: '127.0.0.1',
        port: 6379,
        connectTimeout: 1500
      });
    }

    if (!connectedMain) {
      isRedisConnected = false;
      console.warn('[REDIS] Nenhum servidor Redis detectado. Operando 100% em Memória RAM.');
      return false;
    }

    redisClient = connectedMain;
    isRedisConnected = true;
    console.log('[REDIS] Conectado! Salvando apenas Usuários e Salas Criadas (Partidas 100% em RAM).');

    redisClient.on('error', (err) => {
      console.warn('[REDIS Runtime Error]:', err.message);
    });

    redisClient.on('end', () => {
      isRedisConnected = false;
    });

    return true;
  } catch (err) {
    isRedisConnected = false;
    console.warn('[REDIS] Falha ao inicializar cliente Redis:', err.message);
    return false;
  }
}

function getRedisStatus() {
  return Boolean(isRedisConnected && redisClient && redisClient.status === 'ready');
}

function getClients() {
  return { redisClient, pubClient: null, subClient: null };
}

/**
 * Salva informações do usuário no Redis de forma assíncrona (não bloqueante).
 */
async function cacheUserInRedis(userObj) {
  if (!getRedisStatus() || !userObj || !userObj.id) return;
  try {
    const ttl = userObj.isGuest ? GUEST_TTL_SECONDS : USER_TTL_SECONDS;
    const payload = JSON.stringify({
      id: String(userObj.id),
      username: userObj.username,
      skinColor: userObj.skinColor || '#FF3366',
      stats: userObj.stats || { wins: 0, shoves: 0, kills: 0, matches: 0, xp: 0, level: 1 },
      friends: Array.isArray(userObj.friends) ? userObj.friends : [],
      friendRequests: Array.isArray(userObj.friendRequests) ? userObj.friendRequests : [],
      isGuest: Boolean(userObj.isGuest)
    });

    const pipeline = redisClient.pipeline();
    pipeline.set(`shove:user:${userObj.id}`, payload, 'EX', ttl);
    if (userObj.username) {
      pipeline.set(
        `shove:username:${String(userObj.username).trim().toLowerCase()}`,
        String(userObj.id),
        'EX',
        ttl
      );
    }
    await pipeline.exec();
  } catch (_) {}
}

/**
 * Busca informações de um usuário no Redis pelo ID.
 */
async function getCachedUserFromRedis(userId) {
  if (!getRedisStatus() || !userId) return null;
  try {
    const raw = await redisClient.get(`shove:user:${userId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Busca o ID de um usuário no Redis pelo nickname (case-insensitive).
 */
async function getCachedUserIdByUsername(username) {
  if (!getRedisStatus() || !username) return null;
  try {
    const clean = String(username).trim().toLowerCase();
    return await redisClient.get(`shove:username:${clean}`);
  } catch (_) {
    return null;
  }
}

/**
 * Salva apenas os metadados da sala criada no Redis (sem dados de física da partida).
 */
async function cacheRoomInRedis(roomMeta) {
  if (!getRedisStatus() || !roomMeta || !roomMeta.id) return;
  try {
    const payload = JSON.stringify(roomMeta);
    await redisClient.set(`shove:room:${roomMeta.id}`, payload, 'EX', ROOM_TTL_SECONDS);
  } catch (_) {}
}

/**
 * Remove a sala do Redis quando ela é encerrada/excluída da memória.
 */
async function deleteRoomFromRedis(roomId) {
  if (!getRedisStatus() || !roomId) return;
  try {
    await redisClient.del(`shove:room:${roomId}`);
  } catch (_) {}
}

/**
 * Salva a Tabela Única de Ranking no Redis com TTL de 60 segundos.
 */
async function cacheRankingInRedis(rankingPayload, ttlSeconds = 60) {
  if (!getRedisStatus() || !rankingPayload) return;
  try {
    await redisClient.set(
      'shove:ranking:global',
      JSON.stringify(rankingPayload),
      'EX',
      Math.max(10, Number(ttlSeconds) || 60)
    );
  } catch (_) {}
}

/**
 * Lê a Tabela Única de Ranking em cache no Redis.
 */
async function getCachedRankingFromRedis() {
  if (!getRedisStatus()) return null;
  try {
    const raw = await redisClient.get('shove:ranking:global');
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Salva os metadados da versão ativa do App no Redis para sincronia imediata.
 */
async function cacheAppVersionInRedis(versionInfo) {
  if (!getRedisStatus() || !versionInfo) return;
  try {
    await redisClient.set('shove:app:version', JSON.stringify(versionInfo));
  } catch (_) {}
}

/**
 * Busca os metadados da versão ativa do App no Redis.
 */
async function getCachedAppVersionFromRedis() {
  if (!getRedisStatus()) return null;
  try {
    const raw = await redisClient.get('shove:app:version');
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  connectRedis,
  getRedisStatus,
  getClients,
  cacheUserInRedis,
  getCachedUserFromRedis,
  getCachedUserIdByUsername,
  cacheRoomInRedis,
  deleteRoomFromRedis,
  cacheRankingInRedis,
  getCachedRankingFromRedis,
  cacheAppVersionInRedis,
  getCachedAppVersionFromRedis
};

