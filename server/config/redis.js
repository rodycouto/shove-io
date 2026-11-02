// server/config/redis.js
// ============================================================================
// Gerenciador de Conexão com o Redis 8.0 (Compatível com Discloud VLAN e Local).
// Correções aplicadas para a Discloud:
// 1. Removido o 'return' prematuro que impedia a execução de connectRedis().
// 2. Suporte ao Redis 8.0 ACL com usuário 'default', senha e REDIS_URL
//    (redis://default:Hsbym3RK308U@rodycouto:6379).
// 3. Configuração 'family: 0' no ioredis para resolver DNS interno de containers
//    Docker/VLAN da Discloud (IPv4/IPv6) sem erro ENOTFOUND.
// 4. Fallback automático para localhost ou memória caso executado fora da VLAN.
// ============================================================================

const Redis = require('ioredis');
const ENV = require('./env');

let redisClient = null;
let pubClient = null;
let subClient = null;
let isRedisConnected = false;

/**
 * Tenta conectar a um endpoint Redis específico com timeout controlado.
 * @param {string|null} url URL completa (ex: redis://default:senha@rodycouto:6379)
 * @param {Object} options Opções do ioredis
 * @returns {Promise<Redis|null>}
 */
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

/**
 * Inicializa a conexão com o Redis priorizando a rede privada VLAN da Discloud
 * (REDIS_URL / REDIS_HOST=rodycouto) e, se estiver rodando fora da Discloud no PC local,
 * tenta 127.0.0.1:6379 antes de ativar o Modo Memória Local.
 */
async function connectRedis() {
  if (!ENV.REDIS_ENABLED) {
    console.log('[REDIS] Desativado via configuração (.env REDIS_ENABLED=false).');
    return false;
  }

  const commonOptions = {
    lazyConnect: true,
    family: 0, // Essencial em containers Docker/VLAN na Discloud (aceita IPv4 e IPv6)
    connectTimeout: 4000,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 250, 1500);
    }
  };

  try {
    // 1ª Tentativa: Conexão Discloud via REDIS_URL ou REDIS_HOST configurado no .env
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

    // 2ª Tentativa (Fallback para quando o desenvolvedor testa no PC local fora da VLAN da Discloud)
    if (!connectedMain && ENV.REDIS_HOST !== '127.0.0.1' && ENV.REDIS_HOST !== 'localhost') {
      console.warn(
        `[REDIS] Host privado '${ENV.REDIS_HOST}' inacessível fora da VLAN da Discloud (verifique se VLAN=true está no discloud.config e no mesmo cluster). Tentando Redis local (127.0.0.1:6379)...`
      );
      connectedMain = await tryConnectSingleRedis(null, {
        ...commonOptions,
        host: '127.0.0.1',
        port: 6379,
        connectTimeout: 1500
      });
    }

    if (!connectedMain) {
      isRedisConnected = false;
      console.warn('[REDIS] Nenhum servidor Redis detectado. Operando em Modo Fallback Local (Memória).');
      return false;
    }

    redisClient = connectedMain;
    pubClient = redisClient.duplicate();
    subClient = redisClient.duplicate();

    pubClient.on('error', () => {});
    subClient.on('error', () => {});

    await Promise.all([pubClient.connect(), subClient.connect()]);

    isRedisConnected = true;
    console.log('[REDIS] Conectado ao servidor Redis 8.0 com sucesso (Pub/Sub pronto)!');

    redisClient.on('error', (err) => {
      console.warn('[REDIS Runtime Error]:', err.message);
    });

    redisClient.on('end', () => {
      isRedisConnected = false;
    });

    return true;
  } catch (err) {
    isRedisConnected = false;
    console.warn('[REDIS] Falha ao inicializar clientes Redis:', err.message);
    return false;
  }
}

function getRedisStatus() {
  return isRedisConnected;
}

function getClients() {
  return { redisClient, pubClient, subClient };
}

module.exports = { connectRedis, getRedisStatus, getClients };