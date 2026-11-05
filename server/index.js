// server/index.js
// ============================================================================
// Ponto de entrada principal do servidor Shove.io (v2.0 Otimizado).
// Inclui:
// - TCP_NODELAY ativado para reduzir latência/ping de pacotes pequenos
// - Contador em tempo real de Jogadores Online ao lado do Ping
// - Eventos em tempo real do Sistema de Amigos (verificação no banco e aprovação)
// ============================================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const ENV = require('./config/env');
const { connectDB } = require('./config/db');
const {
  connectRedis,
  getRedisStatus,
  cacheAppVersionInRedis,
  getCachedAppVersionFromRedis
} = require('./config/redis');
const authRoutes = require('./routes/authRoutes');
const RoomManager = require('./managers/RoomManager');

const app = express();
const server = http.createServer(app);

// Desativa o Algoritmo de Nagle (TCP_NODELAY) em todas as conexões TCP
// para reduzir o ping de pacotes de input e estado em até 40ms!
server.on('connection', (tcpSocket) => {
  tcpSocket.setNoDelay(true);
});

const io = new Server(server, {
  cors: { origin: ENV.CORS_ORIGIN },
  transports: ['websocket', 'polling'],
  perMessageDeflate: false,
  httpCompression: true,
  maxHttpBufferSize: 16384,
  pingInterval: 10000,
  pingTimeout: 8000
});

try {
  const compression = require('compression');
  app.use(compression());
} catch (_) {}

app.use(cors({ origin: ENV.CORS_ORIGIN }));
app.use(express.json({ limit: '32kb' }));

app.use(
  '/vendor/three',
  express.static(path.join(__dirname, '../node_modules/three/build'), {
    maxAge: ENV.NODE_ENV === 'production' ? '7d' : 0,
    immutable: ENV.NODE_ENV === 'production'
  })
);

app.use(
  express.static(path.join(__dirname, '../client'), {
    index: false,
    maxAge: ENV.NODE_ENV === 'production' ? '1h' : 0
  })
);

app.use('/api/auth', authRoutes);

// ============================================================================
// CONTROLE DE VERSÃO DO APP DESKTOP E BROADCAST DE ATUALIZAÇÃO EM TEMPO REAL
// ============================================================================
let appVersionState = {
  currentVersion: ENV.APP_VERSION,
  minVersion: ENV.MIN_APP_VERSION,
  downloadUrl: ENV.DOWNLOAD_WINDOWS_URL,
  releaseNotes: 'Melhorias de desempenho, física 100% em RAM, novo mapa Lua Cintilante e Ranking Global!',
  updatedAt: Date.now()
};

function compareSemver(vA = '1.0.0', vB = '1.0.0') {
  const partsA = String(vA).replace(/[^0-9.]/g, '').split('.').map(Number);
  const partsB = String(vB).replace(/[^0-9.]/g, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = partsA[i] || 0;
    const b = partsB[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

// GET /api/app/version — Consultado no Loading Inicial (estilo Clash Royale / Brawl Stars)
app.get('/api/app/version', async (req, res) => {
  const clientVersion = String(req.query.clientVersion || '').trim();
  const cachedVer = await getCachedAppVersionFromRedis();
  if (cachedVer && cachedVer.currentVersion) {
    if (compareSemver(ENV.APP_VERSION, cachedVer.currentVersion) > 0) {
      appVersionState.currentVersion = ENV.APP_VERSION;
      appVersionState.minVersion = ENV.MIN_APP_VERSION;
      await cacheAppVersionInRedis(appVersionState);
    } else {
      appVersionState = cachedVer;
    }
  }

  const updateRequired = clientVersion
    ? compareSemver(clientVersion, appVersionState.minVersion) < 0
    : false;
  const updateAvailable = clientVersion
    ? compareSemver(clientVersion, appVersionState.currentVersion) < 0
    : false;

  res.json({
    ...appVersionState,
    clientVersion: clientVersion || null,
    updateRequired,
    updateAvailable
  });
});

// POST /api/app/publish-update — Dispara aviso em tempo real para TODOS os usuários online
app.post('/api/app/publish-update', async (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.body?.secret;
  if (secret !== ENV.ADMIN_UPDATE_SECRET) {
    return res.status(403).json({ error: 'Chave administrativa inválida.' });
  }

  const nextVersion = String(req.body?.version || ENV.APP_VERSION).trim();
  const nextMinVersion = String(req.body?.minVersion || nextVersion).trim();
  const nextDownloadUrl = String(req.body?.downloadUrl || appVersionState.downloadUrl).trim();
  const nextNotes = String(
    req.body?.releaseNotes || `Nova versão ${nextVersion} disponível! Atualize agora para continuar jogando.`
  ).trim();

  appVersionState = {
    currentVersion: nextVersion,
    minVersion: nextMinVersion,
    downloadUrl: nextDownloadUrl,
    releaseNotes: nextNotes,
    updatedAt: Date.now()
  };

  await cacheAppVersionInRedis(appVersionState);

  // Avisa imediatamente todos os jogadores que já estão online (Lobby, Salas e Partidas)
  io.emit('app:update_available', appVersionState);

  return res.json({
    success: true,
    message: `Atualização v${nextVersion} publicada e enviada para todos os jogadores online!`,
    versionState: appVersionState
  });
});

// GET /api/ranking — Retorna a Tabela Única de Ranking (Cacheada no Redis por 60s)
app.get('/api/ranking', async (req, res) => {
  try {
    const data = await authRoutes.getGlobalRanking(false);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar o ranking.' });
  }
});

const roomManager = new RoomManager(io);

function escapeHtmlMeta(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderHtmlWithOpenGraphBadge(req, res, roomId = null) {
  const htmlPath = path.join(__dirname, '../client/index.html');
  fs.readFile(htmlPath, 'utf8', (err, rawHtml) => {
    if (err) {
      return res.sendFile(htmlPath);
    }

    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'shove.discloud.dev';
    const baseUrl = `${proto}://${host}`;
    const cleanCode = roomId ? String(roomId).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) : null;
    const room = cleanCode ? roomManager.rooms.get(cleanCode) : null;

    let ogTitle = 'Shove.io Arena 3D — Empurre seus rivais para fora!';
    let ogDesc = 'Batalha Multiplayer 3D em tempo real no navegador e celular. Crie sua sala, use a Luva de Boxe e salte nos trampolins do Circo Saltitante!';
    let ogUrl = cleanCode ? `${baseUrl}/room/${cleanCode}` : `${baseUrl}/`;
    const ogImage = `${baseUrl}/og-badge.png`;

    if (cleanCode) {
      if (room) {
        const hostName = room.hostName || 'Líder';
        const mapName = room.selectedMap?.name || 'Arena 3D';
        const currentCount = room.players ? room.players.size : 1;
        const maxCount = room.maxPlayers || 6;
        ogTitle = `Convite para Sala #${cleanCode} de ${hostName} — Shove.io Arena`;
        ogDesc = `Mapa: ${mapName} • Jogadores: ${currentCount}/${maxCount} • Clique para entrar direto na sala #${cleanCode} e batalhar em 3D!`;
      } else {
        ogTitle = `Convite para Sala #${cleanCode} — Shove.io Arena 3D`;
        ogDesc = `Clique para entrar direto na Sala #${cleanCode} no Shove.io Arena e empurrar seus amigos para fora da arena!`;
      }
    }

    const customizedHtml = rawHtml
      .replace(/__OG_TITLE__/g, escapeHtmlMeta(ogTitle))
      .replace(/__OG_DESCRIPTION__/g, escapeHtmlMeta(ogDesc))
      .replace(/__OG_IMAGE__/g, escapeHtmlMeta(ogImage))
      .replace(/__OG_URL__/g, escapeHtmlMeta(ogUrl));

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(customizedHtml);
  });
}

app.get('/', (req, res) => {
  renderHtmlWithOpenGraphBadge(req, res, null);
});

app.get('/room/:roomId', (req, res) => {
  renderHtmlWithOpenGraphBadge(req, res, req.params.roomId);
});

// Mapeia userId -> Set de socketIds ativos para saber quem está online e entregar convites
const onlineUsersMap = new Map();

function getOnlinePlayersCount() {
  return io.engine?.clientsCount || io.sockets.sockets.size || 1;
}

let lastBroadcastedOnlineCount = -1;

/**
 * Emite a quantidade de jogadores online apenas para quem está na tela principal
 * ('lobby') ou na sala em espera ('WAITING'), sem enviar pacotes extras para
 * quem está jogando dentro da partida ou no lobby final de vitória.
 */
function broadcastOnlineCountToWaitingScreens(force = false) {
  const currentCount = getOnlinePlayersCount();
  if (!force && currentCount === lastBroadcastedOnlineCount) return;
  lastBroadcastedOnlineCount = currentCount;

  io.to('lobby').emit('server:online_count', { onlineCount: currentCount });
  for (const room of roomManager.rooms.values()) {
    if (room.status === 'WAITING') {
      io.to(room.id).emit('server:online_count', { onlineCount: currentCount });
    }
  }
}

// Atualização de jogadores online de 5 em 5 segundos (5000ms) para diminuir o ping
const onlineCountInterval = setInterval(() => {
  broadcastOnlineCountToWaitingScreens(true);
}, 5000);
if (typeof onlineCountInterval.unref === 'function') {
  onlineCountInterval.unref();
}

// Atualização automática da Tabela Única de Ranking no Redis a cada 60 segundos (60000ms)
const rankingRefreshInterval = setInterval(async () => {
  try {
    const freshRanking = await authRoutes.getGlobalRanking(true);
    io.to('lobby').emit('ranking:updated', freshRanking);
  } catch (_) {}
}, (ENV.RANKING_CACHE_TTL_SEC || 60) * 1000);
if (typeof rankingRefreshInterval.unref === 'function') {
  rankingRefreshInterval.unref();
}

async function emitFriendsStateToUser(userId) {
  if (!userId) return;
  const socketIds = onlineUsersMap.get(userId);
  if (!socketIds || socketIds.size === 0) return;

  const state = await authRoutes.getFriendsState(userId);
  const enrichedFriends = state.friends.map((f) => {
    const fSockets = onlineUsersMap.get(f.userId);
    let friendRoomId = null;
    if (fSockets && fSockets.size > 0) {
      for (const sid of fSockets) {
        const sObj = io.sockets.sockets.get(sid);
        if (sObj && sObj.currentRoomId) {
          friendRoomId = sObj.currentRoomId;
          break;
        }
      }
    }
    return {
      ...f,
      online: Boolean(fSockets && fSockets.size > 0),
      roomId: friendRoomId
    };
  });

  const payload = {
    friends: enrichedFriends,
    friendRequests: state.friendRequests
  };

  for (const sid of socketIds) {
    io.to(sid).emit('friends:updated', payload);
  }
}

// ============================================================================
// Eventos de Conexão em Tempo Real (Socket.io)
// ============================================================================
io.on('connection', (socket) => {
  socket.join('lobby');

  socket.emit('rooms:list', roomManager.getPublicRoomsList());
  socket.emit('server:online_count', { onlineCount: getOnlinePlayersCount() });
  socket.emit('app:version_info', appVersionState);

  // 0. Medidor de Ping ultra-leve (sem payload extra para diminuir o ping)
  socket.on('ping:check', (callback) => {
    if (typeof callback === 'function') {
      callback();
    }
  });

  // 0.1 Identificação de sessão do usuário para presença online e lista de amigos
  socket.on('user:identify', async (userProfile = {}, callback) => {
    if (userProfile && userProfile.id) {
      socket.userId = userProfile.id;
      if (!onlineUsersMap.has(userProfile.id)) {
        onlineUsersMap.set(userProfile.id, new Set());
      }
      onlineUsersMap.get(userProfile.id).add(socket.id);

      // Garante que usuários em memória/convidados restaurados do localStorage existam na sessão
      const existing = await authRoutes.findUserById(userProfile.id);
      if (!existing) {
        authRoutes.setMemoryUser(userProfile.id, {
          id: userProfile.id,
          username: (userProfile.username || 'Jogador').substring(0, 15),
          skinColor: userProfile.skinColor || '#FF3366',
          stats: authRoutes.normalizeStats(userProfile.stats || {}),
          isGuest: Boolean(userProfile.isGuest),
          friends: [],
          friendRequests: []
        });
      }

      await emitFriendsStateToUser(userProfile.id);
    }
    if (typeof callback === 'function') {
      callback({ onlineCount: getOnlinePlayersCount() });
    }
  });

  // 0.2 Sistema de Amigos: Buscar lista atualizada
  socket.on('friends:get', async ({ userId } = {}, callback) => {
    const uid = userId || socket.userId;
    if (!uid) {
      if (typeof callback === 'function') callback({ friends: [], friendRequests: [] });
      return;
    }
    await emitFriendsStateToUser(uid);
    if (typeof callback === 'function') callback({ success: true });
  });

  // 0.3 Sistema de Amigos: Enviar solicitação (verifica se o nickname existe no banco!)
  socket.on('friends:request', async ({ fromUserId, targetNickname } = {}, callback) => {
    const uid = fromUserId || socket.userId;
    const result = await authRoutes.sendFriendRequest(uid, targetNickname);
    if (result.success && result.targetUserId) {
      await emitFriendsStateToUser(result.targetUserId);
    }
    if (typeof callback === 'function') callback(result);
  });

  // 0.4 Sistema de Amigos: Aprovar ou recusar solicitação pendente
  socket.on('friends:respond', async ({ userId, fromUserId, accept } = {}, callback) => {
    const uid = userId || socket.userId;
    const result = await authRoutes.respondToFriendRequest(uid, fromUserId, accept);
    if (result.success) {
      await emitFriendsStateToUser(uid);
      if (result.friendUserId) {
        await emitFriendsStateToUser(result.friendUserId);
      }
    }
    if (typeof callback === 'function') callback(result);
  });

  // 0.5 Sistema de Amigos: Remover amigo
  socket.on('friends:remove', async ({ userId, friendUserId } = {}, callback) => {
    const uid = userId || socket.userId;
    const result = await authRoutes.removeFriend(uid, friendUserId);
    if (result.success) {
      await emitFriendsStateToUser(uid);
      if (friendUserId) {
        await emitFriendsStateToUser(friendUserId);
      }
    }
    if (typeof callback === 'function') callback(result);
  });

  // 0.6 Buscar Tabela Única de Ranking (do Cache Redis 60s)
  socket.on('ranking:get', async (callback) => {
    const data = await authRoutes.getGlobalRanking(false);
    if (typeof callback === 'function') callback(data);
  });

  // 1. Buscar lista atualizada de salas criadas ao redor do jogo
  socket.on('rooms:get_list', (callback) => {
    const list = roomManager.getPublicRoomsList();
    if (typeof callback === 'function') callback(list);
  });

  // 2. Criação de Sala Privada pelo Host
  socket.on('room:create_private', ({ playerProfile, teamSize, friendlyFire } = {}, callback) => {
    const result = roomManager.createPrivateRoom(socket, playerProfile, { teamSize, friendlyFire });
    if (typeof callback === 'function') callback(result);
  });

  // 3. Atualização de configurações da sala pelo Host
  socket.on('room:update_config', (configData = {}, callback) => {
    const result = roomManager.updateRoomConfig(socket, configData);
    if (typeof callback === 'function') callback(result);
  });

  // 4. Alternar estado de "Pronto"
  socket.on('room:toggle_ready', (payload = {}, callback) => {
    const result = roomManager.togglePlayerReady(socket, payload);
    if (typeof callback === 'function') callback(result);
  });

  // 5. Escolha / troca de time
  socket.on('room:select_team', (teamData = {}, callback) => {
    const result = roomManager.selectTeam(socket, teamData);
    if (typeof callback === 'function') callback(result);
  });

  // 6. Entrar ou Solicitar Entrada em Sala
  socket.on('room:join_private', ({ roomId, playerProfile } = {}, callback) => {
    const result = roomManager.requestOrJoinRoom(socket, roomId, playerProfile);
    if (typeof callback === 'function') callback(result);
  });

  // 7. Criador da Sala aceita ou recusa solicitação de entrada
  socket.on('room:respond_join', (payload = {}, callback) => {
    const result = roomManager.respondJoinRequest(socket, payload);
    if (typeof callback === 'function') callback(result);
  });

  // 8. Criador da Sala expulsa (Kick) um jogador
  socket.on('room:kick_player', (payload = {}, callback) => {
    const result = roomManager.kickPlayer(socket, payload);
    if (typeof callback === 'function') callback(result);
  });

  // 9. Entrada na fila do Modo Battle Royale
  socket.on('room:join_battleroyale', (playerProfile, callback) => {
    const result = roomManager.findOrCreateBattleRoyale(socket, playerProfile);
    if (typeof callback === 'function') callback(result);
  });

  // 10. Início da partida
  socket.on('room:start', (callback) => {
    const roomId = socket.currentRoomId;
    if (!roomId) {
      if (typeof callback === 'function') callback({ error: 'Você não está em nenhuma sala.' });
      return;
    }
    const result = roomManager.startMatch(socket, roomId);
    if (typeof callback === 'function') callback(result);
  });

  // 11. Recebimento de inputs de movimentação, Shove e Segurar/Levantar (Grab)
  socket.on('match:input', (inputData) => {
    roomManager.handlePlayerInput(socket, inputData);
  });

  // 12. Acionamento direto do Empurrão (ou tentativa de Escapar quando levantado)
  socket.on('match:shove', (shoveData) => {
    roomManager.handlePlayerShoveOrEscape(socket, shoveData);
  });

  // 13. Evento explícito de apertar botão para escapar quando levantado
  socket.on('match:escape_press', () => {
    roomManager.handlePlayerShoveOrEscape(socket, {});
  });

  // 14. Saída voluntária da sala atual
  socket.on('room:leave', (callback) => {
    roomManager.leaveCurrentRoom(socket);
    if (typeof callback === 'function') callback({ success: true });
  });

  // 14.1. Mensagem no Chat em Memória da Sala/Partida (máx. 100 caracteres, morre com a sala)
  socket.on('room:chat_send', (payload, callback) => {
    const result = roomManager.handleChatMessage(socket, payload || {});
    if (typeof callback === 'function') callback(result);
  });

  // 15. Desconexão do navegador/aplicativo
  socket.on('disconnect', () => {
    if (socket.userId && onlineUsersMap.has(socket.userId)) {
      const set = onlineUsersMap.get(socket.userId);
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsersMap.delete(socket.userId);
      }
    }
    roomManager.leaveCurrentRoom(socket);
  });
});

// ============================================================================
// Inicialização Assíncrona de Banco, Redis e Servidor HTTP
// ============================================================================
async function bootstrapServer() {
  await connectDB();
  await connectRedis();
  await cacheAppVersionInRedis(appVersionState);
  await authRoutes.getGlobalRanking(true);

  // Nota de Desempenho: NÃO acoplamos @socket.io/redis-adapter ao Socket.io!
  // Assim, todos os pacotes de física (30Hz), empurrões e eventos da partida
  // trafegam 100% na memória RAM sem latência extra de rede, enquanto o Redis
  // salva apenas as informações dos usuários e as salas criadas.
  server.listen(ENV.PORT, () => {
    console.log(`=================================================`);
    console.log(`SHOVE.IO [${ENV.NODE_ENV.toUpperCase()}] rodando na porta: ${ENV.PORT}`);
    console.log(`Partidas 3D: 100% em Memória RAM (Zero Latência Redis)`);
    console.log(`Redis Cache (Usuários/Salas): ${getRedisStatus() ? 'Ativo' : 'Modo Fallback RAM'}`);
    console.log(`=================================================`);
  });
}

bootstrapServer();
