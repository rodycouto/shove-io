// server/config/env.js
// ============================================================================
// Módulo responsável por carregar e validar as variáveis de ambiente (.env).
// Inclui suporte completo às credenciais do Redis 8.0 na rede VLAN da Discloud.
// ============================================================================

const path = require('path');
const dotenv = require('dotenv');

// Garante a leitura do .env na raiz do projeto
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// No Redis o comando SELECT aceita apenas inteiros (0 a 15).
// Se alguém definir REDIS_DB="shove" por engano, converte para 0 com segurança.
const parsedRedisDb = Number.parseInt(process.env.REDIS_DB, 10);

const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT) || 8080,
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',

  // MongoDB (Atlas Cloud ou Local)
  MONGO_URI: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/shove_io',
  DATABASE_URL_CONNECTION: process.env.DATABASE_URL_CONNECTION || '',
  DATABASE_USERNAME: process.env.DATABASE_USERNAME || '',
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD || '',
  MONGO_TIMEOUT_MS: Number(process.env.MONGO_TIMEOUT_MS) || 4000,

  // Redis 8.0 (Discloud VLAN / Local Fallback)
  REDIS_ENABLED: process.env.REDIS_ENABLED !== 'false',
  REDIS_URL: process.env.REDIS_URL || 'redis://default:Hsbym3RK308U@rodycouto:6379',
  REDIS_HOST: process.env.REDIS_HOST || 'rodycouto',
  REDIS_PORT: Number(process.env.REDIS_PORT) || 6379,
  REDIS_USERNAME: process.env.REDIS_USERNAME || 'default',
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
  REDIS_DB: Number.isNaN(parsedRedisDb) ? 0 : parsedRedisDb,

  // Segurança e Autenticação (JWT & Bcrypt)
  JWT_SECRET: process.env.JWT_SECRET || 'dev_fallback_secret_change_me',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  BCRYPT_SALT_ROUNDS: Number(process.env.BCRYPT_SALT_ROUNDS) || 10,

  // Gameplay e Salas
  MAX_PLAYERS_PER_ROOM: Math.min(15, Number(process.env.MAX_PLAYERS_PER_ROOM) || 15),
  SERVER_TICK_RATE: Number(process.env.SERVER_TICK_RATE) || 30,
  BR_MIN_REAL_PLAYERS: Number(process.env.BR_MIN_REAL_PLAYERS) || 5,
  BR_WAIT_TIME_SECONDS: Number(process.env.BR_WAIT_TIME_SECONDS) || 60
};

if (ENV.NODE_ENV === 'production' && ENV.JWT_SECRET === 'dev_fallback_secret_change_me') {
  console.warn('[SECURITY WARNING] Defina um JWT_SECRET exclusivo no arquivo .env em produção!');
}

module.exports = ENV;