// server/config/db.js
// ============================================================================
// Gerenciador de conexão com o MongoDB (Atlas Cloud ou Local).
// Caso o banco não esteja acessível, ativa automaticamente o modo em memória
// para não bloquear o desenvolvimento ou testes locais.
// ============================================================================

const mongoose = require('mongoose');
const ENV = require('./env');

let isMongoConnected = false;

/**
 * Inicializa a conexão com o MongoDB priorizando DATABASE_URL_CONNECTION
 * e utilizando MONGO_URI como fallback.
 */
async function connectDB() {
  // Escolhe a URI do Atlas (se definida) ou a URI local definida no .env
  const connectionUri = ENV.DATABASE_URL_CONNECTION || ENV.MONGO_URI;

  if (!connectionUri) {
    console.warn('[DB] Nenhuma URI de MongoDB configurada. Operando em modo memória.');
    isMongoConnected = false;
    return;
  }

  try {
    await mongoose.connect(connectionUri, {
      serverSelectionTimeoutMS: ENV.MONGO_TIMEOUT_MS
    });
    isMongoConnected = true;
    const isAtlas = connectionUri.startsWith('mongodb+srv://');
    console.log(`[DB] Conectado ao MongoDB (${isAtlas ? 'Atlas Cloud' : 'Local'}) com sucesso!`);
  } catch (err) {
    isMongoConnected = false;
    console.warn(`[DB] Aviso: MongoDB não detectado (${err.message}).`);
    console.warn('[DB] Usando banco em memória temporário para desenvolvimento sem bloqueios.');
  }
}

/**
 * Retorna se a conexão com o MongoDB está ativa.
 * @returns {boolean}
 */
function getDbStatus() {
  return isMongoConnected;
}

module.exports = { connectDB, getDbStatus };