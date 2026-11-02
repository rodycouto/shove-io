// server/index.js
// ============================================================================
// Ponto de entrada principal do servidor Shove.io.
// Configura Express, Socket.io, MongoDB, Redis 8.0 Adapter (Discloud VLAN),
// Medidor de Ping, Lista de Amigos (Online/Offline + Convites), Lista Pública
// de Salas, Solicitação/Aprovação de Entrada, Expulsão e Múltiplos Rounds.
// ============================================================================

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const ENV = require('./config/env');
const { connectDB } = require('./config/db');
const { connectRedis, getClients, getRedisStatus } = require('./config/redis');
const authRoutes = require('./routes/authRoutes');
const RoomManager = require('./managers/RoomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ENV.CORS_ORIGIN }
});

app.use(cors({ origin: ENV.CORS_ORIGIN }));
app.use(express.json());

// Desativa cache antigo de CSS/JS no navegador para sempre entregar o visual atualizado
app.use(
  express.static(path.join(__dirname, '../client'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  })
);
app.use('/vendor/three', express.static(path.join(__dirname, '../node_modules/three/build')));

app.use('/api/auth', authRoutes);

app.get('/room/:roomId', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

const roomManager = new RoomManager(io);

// Alias defensivo caso algum módulo externo chame removePlayer(socketOrId)
roomManager.removePlayer = (socketOrId) => {
  const targetSocket =
    typeof socketOrId === 'string' ? io.sockets.sockets.get(socketOrId) : socketOrId;
  if (targetSocket) {
    roomManager.leaveCurrentRoom(targetSocket);
  }
};

// ============================================================================
// Eventos de Conexão em Tempo Real (Socket.io)
// ============================================================================
io.on('connection', (socket) => {
  console.log(`[Socket] Conectado: ${socket.id}`);

  socket.emit('rooms:list', roomManager.getPublicRoomsList());

  // 0. Medidor de Ping em tempo real (canto superior esquerdo)
  socket.on('ping:check', (callback) => {
    if (typeof callback === 'function') callback();
  });

  // 1. Sistema de Presença e Lista de Amigos (Online/Offline + Convidar para Partida)
  socket.on('user:register_presence', (userProfile = {}, callback) => {
    roomManager.registerUserPresence(socket, userProfile);
    if (typeof callback === 'function') {
      callback({ friendsList: roomManager.getFriendsListForSocket(socket.id) });
    }
  });

  socket.on('friends:get_list', (callback) => {
    if (typeof callback === 'function') {
      callback(roomManager.getFriendsListForSocket(socket.id));
    }
  });

  socket.on('friends:add', async (payload = {}, callback) => {
    const res = await roomManager.addFriend(socket, payload);
    if (typeof callback === 'function') callback(res);
  });

  socket.on('friends:remove', async (payload = {}, callback) => {
    const res = await roomManager.removeFriend(socket, payload);
    if (typeof callback === 'function') callback(res);
  });

  socket.on('friends:invite', (payload = {}, callback) => {
    const res = roomManager.inviteFriendToMatch(socket, payload);
    if (typeof callback === 'function') callback(res);
  });

  // 2. Buscar lista atualizada de salas criadas ao redor do jogo
  socket.on('rooms:get_list', (callback) => {
    const list = roomManager.getPublicRoomsList();
    if (typeof callback === 'function') callback(list);
  });

  // 3. Criação de Sala Privada pelo Host
  socket.on('room:create_private', ({ playerProfile, teamSize, friendlyFire } = {}, callback) => {
    const result = roomManager.createPrivateRoom(socket, playerProfile, { teamSize, friendlyFire });
    if (typeof callback === 'function') callback(result);
  });

  // 4. Atualização de configurações da sala pelo Host
  socket.on('room:update_config', (configData = {}, callback) => {
    const result = roomManager.updateRoomConfig(socket, configData);
    if (typeof callback === 'function') callback(result);
  });

  // 5. Alternar estado de "Pronto" (exclusivo para jogadores convidados)
  socket.on('room:toggle_ready', (payload = {}, callback) => {
    const result = roomManager.togglePlayerReady(socket, payload);
    if (typeof callback === 'function') callback(result);
  });

  // 6. Escolha / troca de time por qualquer jogador na sala
  socket.on('room:select_team', (teamData = {}, callback) => {
    const result = roomManager.selectTeam(socket, teamData);
    if (typeof callback === 'function') callback(result);
  });

  // 7. Entrar ou Solicitar Entrada em Sala (via Lista de Salas, Código, Link ou Convite de Amigo)
  socket.on('room:join_private', ({ roomId, playerProfile, fromInvite } = {}, callback) => {
    const result = roomManager.requestOrJoinRoom(socket, roomId, playerProfile, Boolean(fromInvite));
    if (typeof callback === 'function') callback(result);
  });

  // 8. Criador da Sala aceita ou recusa solicitação de entrada
  socket.on('room:respond_join', (payload = {}, callback) => {
    const result = roomManager.respondJoinRequest(socket, payload);
    if (typeof callback === 'function') callback(result);
  });

  // 9. Criador da Sala expulsa jogador da sala
  socket.on('room:kick_player', (payload = {}, callback) => {
    const result = roomManager.kickPlayer(socket, payload);
    if (typeof callback === 'function') callback(result);
  });

  // 10. Entrar na fila pública do Battle Royale
  const handleJoinBR = (payload = {}, callback) => {
    const profile = payload && payload.playerProfile ? payload.playerProfile : payload;
    const result = roomManager.findOrCreateBattleRoyale(socket, profile);
    if (typeof callback === 'function') callback(result);
  };
  socket.on('room:join_battleroyale', handleJoinBR);
  socket.on('room:join_br', handleJoinBR);

  // 11. Iniciar partida manualmente (Exclusivo do Criador quando convidados estão Prontos)
  const handleStartMatch = (payloadOrCb, maybeCb) => {
    const callback = typeof payloadOrCb === 'function' ? payloadOrCb : maybeCb;
    const roomId =
      payloadOrCb && typeof payloadOrCb === 'object' ? payloadOrCb.roomId : socket.currentRoomId;
    const result = roomManager.startMatch(socket, roomId);
    if (typeof callback === 'function') callback(result);
  };
  socket.on('room:start', handleStartMatch);
  socket.on('room:start_match', handleStartMatch);

  // 12. Movimento contínuo e carregamento de empurrão/agarrão na arena
  socket.on('match:input', (inputData = {}) => {
    roomManager.handlePlayerInput(socket, inputData);
  });
  socket.on('game:move_input', (inputData = {}) => {
    roomManager.handlePlayerInput(socket, inputData);
  });

  // 13. Pressionar empurrar para escapar quando levantado ou soltar empurrão
  socket.on('match:escape_press', (payload = {}) => {
    roomManager.handlePlayerShoveOrEscape(socket, payload);
  });
  socket.on('game:shove_release', (payload = {}) => {
    roomManager.handlePlayerShoveOrEscape(socket, payload);
  });

  // 14. Sair da sala atual e retornar ao lobby
  socket.on('room:leave', (callback) => {
    roomManager.leaveCurrentRoom(socket);
    if (typeof callback === 'function') callback({ success: true });
  });

  // 15. Logout explícito do usuário
  socket.on('user:logout', () => {
    roomManager.leaveCurrentRoom(socket);
    roomManager.unregisterUserPresence(socket);
  });

  // 16. Desconexão do socket
  socket.on('disconnect', () => {
    roomManager.leaveCurrentRoom(socket);
    roomManager.unregisterUserPresence(socket);
    console.log(`[Socket] Desconectado: ${socket.id}`);
  });
});

// ============================================================================
// Inicialização Assíncrona (MongoDB + Redis 8.0 Adapter na Discloud + HTTP)
// ============================================================================
async function bootstrap() {
  await connectDB();
  await connectRedis();

  if (getRedisStatus()) {
    const { pubClient, subClient } = getClients();
    io.adapter(createAdapter(pubClient, subClient));
    console.log('🚀 [Socket.io] Redis Adapter 8.0 ativado com sucesso!');
  }

  server.listen(ENV.PORT, '0.0.0.0', () => {
    console.log(`🎮 Servidor Shove.io rodando na porta ${ENV.PORT}`);
  });
}

bootstrap();