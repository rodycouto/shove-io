// server/managers/RoomManager.js
// ============================================================================
// Gerenciador Central de Salas, Lista Pública, Aprovação de Entrada, Expulsão,
// Sistema de Amigos (Presença Online/Offline + Convite para Partida),
// Múltiplos Rounds, Seleção de Mapas, Apresentação + Contagem 5..1 SHOVE!,
// Física Autoritativa (30Hz) e Sistema de Níveis / XP Proporcional.
// ============================================================================

const fs = require('fs');
const path = require('path');
const ENV = require('../config/env');
const authRoutes = require('../routes/authRoutes');

const TEAMS_CATALOG = [
  { id: 1, name: 'Time Azul', icon: '🐬', color: '#00E5FF' },
  { id: 2, name: 'Time Vermelho', icon: '🦊', color: '#FF3366' },
  { id: 3, name: 'Time Amarelo', icon: '⚡', color: '#FFD600' },
  { id: 4, name: 'Time Verde', icon: '🦖', color: '#00E676' },
  { id: 5, name: 'Time Roxo', icon: '🔮', color: '#AA00FF' },
  { id: 6, name: 'Time Laranja', icon: '🐯', color: '#FF6D00' },
  { id: 7, name: 'Time Rosa', icon: '🦄', color: '#FF80AB' },
  { id: 8, name: 'Time Turquesa', icon: '🐢', color: '#1DE9B6' }
];

const POWERUP_TYPES = [
  { type: 'INVISIBLE', name: 'Invisível (5s)', icon: '👻', color: '#00E5FF' },
  { type: 'MEGA_SHOVE', name: 'Mega Shove (4x)', icon: '💥', color: '#FF3366' },
  { type: 'HEAVYWEIGHT', name: 'Peso Pesado (5s)', icon: '🛡️', color: '#FFD600' },
  { type: 'SHOCK', name: 'Arma de Shock (3s)', icon: '⚡', color: '#AA00FF' }
];

const BOT_NAMES = [
  'RoboShove', 'Pinguim3D', 'TrovãoAzul', 'MegaFeijão', 'AstroBot',
  'DinoPulo', 'PipocaCósmica', 'BolaDeFogo', 'Gelinho', 'TurboKids',
  'CapitãoEmpurra', 'ZigueZague', 'Cometa Feliz', 'SuperBumper', 'NinjaFofo'
];

const BOT_COLORS = ['#FF3366', '#00E5FF', '#FFD600', '#00E676', '#AA00FF', '#FF6D00'];

const DEFAULT_MATCH_DURATION_SEC = 150;
const DEFAULT_POWERUP_SPAWN_SEC = 15;
const DEFAULT_TOTAL_ROUNDS = 3;
const MAX_TOTAL_ROUNDS = 10;
const MAP_INTRO_DURATION_MS = 3500;
const PRE_ROUND_COUNTDOWN_SEC = 5;
const ESCAPE_REQUIRED_PRESSES = 5;
const STUN_ON_ESCAPE_MS = 500;
const INVISIBLE_DURATION_MS = 5000;
const HEAVYWEIGHT_DURATION_MS = 5000;
const SHOCK_DURATION_MS = 3000;
const MAX_NORMAL_SHOVE_FORCE = 26;

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();

    // Registro em tempo real dos jogadores online para o Sistema de Amigos
    // socketId -> { socketId, userId, username, lowerName, skinColor, friends: Set<string> }
    this.onlineUsers = new Map();

    this.MAX_PLAYERS = Math.min(15, ENV.MAX_PLAYERS_PER_ROOM || 15);
    this.TICK_RATE = ENV.SERVER_TICK_RATE || 30;
    this.BR_MIN_REAL_PLAYERS = ENV.BR_MIN_REAL_PLAYERS || 5;
    this.BR_WAIT_TIME_SECONDS = ENV.BR_WAIT_TIME_SECONDS || 60;

    this.mapsList = this.loadMapsFromJson();
  }

  // ==========================================================================
  // SISTEMA DE AMIGOS (PRESENÇA ONLINE/OFFLINE E CONVITE PARA PARTIDA)
  // ==========================================================================

  /**
   * Registra que um usuário está Online no Lobby/Jogo e sincroniza sua lista de amigos.
   */
  registerUserPresence(socket, userProfile = {}) {
    if (!userProfile || !userProfile.username) return;

    const cleanName = String(userProfile.username).trim();
    const existing = this.onlineUsers.get(socket.id);
    const initialFriends = Array.isArray(userProfile.friends)
      ? userProfile.friends
      : existing
      ? Array.from(existing.friends)
      : [];

    this.onlineUsers.set(socket.id, {
      socketId: socket.id,
      userId: userProfile.id || `user_${socket.id}`,
      username: cleanName,
      lowerName: cleanName.toLowerCase(),
      skinColor: userProfile.skinColor || '#FF3366',
      friends: new Set(initialFriends.map((f) => String(f).trim()).filter(Boolean))
    });

    this.broadcastFriendsPresence();
  }

  /**
   * Remove o registro de presença quando o socket desconecta ou faz logout.
   */
  unregisterUserPresence(socket) {
    if (this.onlineUsers.has(socket.id)) {
      this.onlineUsers.delete(socket.id);
      this.broadcastFriendsPresence();
    }
  }

  /**
   * Procura um usuário online pelo Nickname (case-insensitive).
   */
  findOnlineUserByUsername(username) {
    if (!username) return null;
    const targetLower = String(username).trim().toLowerCase();
    for (const u of this.onlineUsers.values()) {
      if (u.lowerName === targetLower) {
        return u;
      }
    }
    return null;
  }

  /**
   * Monta a lista de amigos de um socket específico informando quem está Online ou Offline.
   */
  getFriendsListForSocket(socketId) {
    const userRecord = this.onlineUsers.get(socketId);
    if (!userRecord) return [];

    const result = [];
    for (const friendName of userRecord.friends) {
      const onlineMatch = this.findOnlineUserByUsername(friendName);
      const friendSocket = onlineMatch ? this.io.sockets.sockets.get(onlineMatch.socketId) : null;
      const isOnline = Boolean(onlineMatch && friendSocket && friendSocket.connected);

      result.push({
        username: onlineMatch ? onlineMatch.username : friendName,
        skinColor: onlineMatch ? onlineMatch.skinColor : '#9aa5ce',
        online: isOnline,
        inRoomId: isOnline ? friendSocket.currentRoomId || null : null
      });
    }

    // Ordena mostrando amigos Online no topo da lista
    return result.sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
  }

  /**
   * Atualiza em tempo real o status Online/Offline na tela de todos os usuários conectados.
   */
  broadcastFriendsPresence() {
    for (const [sockId] of this.onlineUsers.entries()) {
      const sock = this.io.sockets.sockets.get(sockId);
      if (sock) {
        sock.emit('friends:list_update', this.getFriendsListForSocket(sockId));
      }
    }
  }

  /**
   * Adiciona um amigo pelo Nickname, persiste no banco/memória e retorna a lista atualizada.
   */
  async addFriend(socket, { friendUsername } = {}) {
    const cleanFriend = String(friendUsername || '').trim();
    if (!cleanFriend || cleanFriend.length < 2) {
      return { error: 'Digite um Nickname válido para adicionar.' };
    }

    const myRecord = this.onlineUsers.get(socket.id);
    if (!myRecord) {
      return { error: 'Faça login antes de adicionar amigos.' };
    }

    if (cleanFriend.toLowerCase() === myRecord.lowerName) {
      return { error: 'Você não pode adicionar a si mesmo!' };
    }

    // Evita duplicatas com capitalização diferente
    for (const existing of myRecord.friends) {
      if (existing.toLowerCase() === cleanFriend.toLowerCase()) {
        return { error: `${cleanFriend} já está na sua lista de amigos!` };
      }
    }

    myRecord.friends.add(cleanFriend);
    const savedArray = await authRoutes.saveUserFriendsList(
      myRecord.userId,
      Array.from(myRecord.friends)
    );

    const friendsList = this.getFriendsListForSocket(socket.id);
    socket.emit('friends:list_update', friendsList);
    return { success: true, friends: savedArray, friendsList };
  }

  /**
   * Remove um amigo da lista do usuário.
   */
  async removeFriend(socket, { friendUsername } = {}) {
    const targetLower = String(friendUsername || '').trim().toLowerCase();
    const myRecord = this.onlineUsers.get(socket.id);
    if (!myRecord) return { error: 'Sessão não encontrada.' };

    for (const f of Array.from(myRecord.friends)) {
      if (f.toLowerCase() === targetLower) {
        myRecord.friends.delete(f);
      }
    }

    const savedArray = await authRoutes.saveUserFriendsList(
      myRecord.userId,
      Array.from(myRecord.friends)
    );

    const friendsList = this.getFriendsListForSocket(socket.id);
    socket.emit('friends:list_update', friendsList);
    return { success: true, friends: savedArray, friendsList };
  }

  /**
   * Envia um convite de partida em tempo real para um amigo Online.
   * Se quem convidou ainda não estiver em uma sala, cria uma sala privada automaticamente!
   */
  inviteFriendToMatch(socket, { friendUsername, playerProfile } = {}) {
    const friendRecord = this.findOnlineUserByUsername(friendUsername);
    if (!friendRecord) {
      return { error: `${friendUsername} está Offline no momento.` };
    }

    const friendSocket = this.io.sockets.sockets.get(friendRecord.socketId);
    if (!friendSocket || !friendSocket.connected) {
      return { error: `${friendUsername} está Offline no momento.` };
    }

    let roomId = socket.currentRoomId;
    let createdRoomNow = null;

    // Se o jogador que clicou em "Convidar" ainda não estava em uma sala, cria uma sala para ele!
    if (!roomId || !this.rooms.has(roomId)) {
      const createRes = this.createPrivateRoom(socket, playerProfile || {
        id: this.onlineUsers.get(socket.id)?.userId,
        username: this.onlineUsers.get(socket.id)?.username || 'Jogador',
        skinColor: this.onlineUsers.get(socket.id)?.skinColor || '#FF3366'
      });
      roomId = createRes.room.id;
      createdRoomNow = createRes.room;
    }

    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'WAITING') {
      return { error: 'A partida na sua sala já começou!' };
    }

    // Registra o amigo na lista de convidados autorizados da sala para entrar direto ao aceitar
    if (!room.invitedSockets) room.invitedSockets = new Set();
    room.invitedSockets.add(friendSocket.id);

    const senderName = this.onlineUsers.get(socket.id)?.username || playerProfile?.username || 'Amigo';

    friendSocket.emit('friends:receive_invite', {
      roomId: room.id,
      fromUsername: senderName,
      teamSize: room.teamSize,
      totalRounds: room.totalRounds
    });

    return {
      success: true,
      room: createdRoomNow,
      message: `Convite enviado para ${friendRecord.username}!`
    };
  }

  // ==========================================================================
  // MAPAS, SALAS, LISTA PÚBLICA E CONTROLE DE ACESSO
  // ==========================================================================

  loadMapsFromJson() {
    try {
      const mapsPath = path.resolve(__dirname, '../../client/data/maps.json');
      const raw = fs.readFileSync(mapsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.maps) && parsed.maps.length > 0) {
        return parsed.maps;
      }
    } catch (err) {
      console.error('[RoomManager] Erro ao ler maps.json:', err.message);
    }
    return [
      {
        id: 'map_hex_classic',
        name: 'Arena Hexagonal Clássica',
        description: 'Plataforma aberta sem obstáculos: pura força no empurrão!',
        theme: {
          background: '#070812',
          platformColor: '#232946',
          borderColor: '#ff3366',
          centerColor: '#00e5ff'
        },
        physics: {
          radius: 12.0,
          sides: 6,
          friction: 0.88,
          moveSpeed: 18.5,
          innerHoleRadius: 0,
          shrinkRate: 0,
          minRadius: 12.0,
          pillars: []
        }
      }
    ];
  }

  pickMapForRound(room) {
    this.mapsList = this.loadMapsFromJson();
    const allowedIds = Array.isArray(room?.selectedMapIds) && room.selectedMapIds.length > 0
      ? room.selectedMapIds
      : this.mapsList.map((m) => m.id);

    let pool = this.mapsList.filter((m) => allowedIds.includes(m.id));
    if (pool.length === 0) {
      pool = [...this.mapsList];
    }

    if (pool.length > 1 && room?.lastPlayedMapId) {
      const differentMaps = pool.filter((m) => m.id !== room.lastPlayedMapId);
      if (differentMaps.length > 0) {
        pool = differentMaps;
      }
    }

    const chosen = pool[Math.floor(Math.random() * pool.length)];
    if (room) {
      room.lastPlayedMapId = chosen.id;
    }
    return JSON.parse(JSON.stringify(chosen));
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    do {
      code = '';
      for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (this.rooms.has(code));
    return code;
  }

  sanitizeTeamSize(teamSize) {
    const allowed = [1, 2, 3, 4, 5];
    const num = Number(teamSize);
    return allowed.includes(num) ? num : 1;
  }

  getAvailableTeamsForSize(teamSize) {
    if (teamSize <= 1) return [];
    const numTeams = Math.ceil(this.MAX_PLAYERS / teamSize);
    return TEAMS_CATALOG.slice(0, numTeams);
  }

  findAvailableTeamId(room) {
    if (room.teamSize <= 1) return null;
    const teams = this.getAvailableTeamsForSize(room.teamSize);

    for (const t of teams) {
      let count = 0;
      for (const p of room.players.values()) {
        if (p.teamId === t.id) count++;
      }
      if (count < room.teamSize) {
        return t.id;
      }
    }
    return teams[0]?.id || 1;
  }

  rebalanceTeams(room) {
    if (room.teamSize <= 1) {
      for (const p of room.players.values()) {
        p.teamId = null;
      }
      return;
    }

    const teams = this.getAvailableTeamsForSize(room.teamSize);
    const counts = new Map(teams.map((t) => [t.id, 0]));

    for (const p of room.players.values()) {
      if (p.teamId && counts.has(p.teamId) && counts.get(p.teamId) < room.teamSize) {
        counts.set(p.teamId, counts.get(p.teamId) + 1);
      } else {
        let assigned = teams[0].id;
        for (const t of teams) {
          if (counts.get(t.id) < room.teamSize) {
            assigned = t.id;
            break;
          }
        }
        p.teamId = assigned;
        counts.set(assigned, (counts.get(assigned) || 0) + 1);
      }
    }
  }

  ensureSingleRoomPerUser(socket, userId) {
    if (socket.currentRoomId) {
      this.leaveCurrentRoom(socket);
    }

    for (const room of this.rooms.values()) {
      if (room.joinRequests && room.joinRequests.has(socket.id)) {
        room.joinRequests.delete(socket.id);
        this.broadcastRoomState(room.id);
      }
      if (userId) {
        for (const [sockId, p] of room.players.entries()) {
          if (!p.isBot && p.userId === userId && sockId !== socket.id) {
            const oldSocket = this.io.sockets.sockets.get(sockId);
            if (oldSocket) {
              this.leaveCurrentRoom(oldSocket);
            } else {
              room.players.delete(sockId);
            }
          }
        }
      }
    }
  }

  syncConfiguredBots(room) {
    if (room.mode !== 'PRIVATE') return;

    for (const [key, p] of room.players.entries()) {
      if (p.isBot) {
        room.players.delete(key);
      }
    }

    const realCount = this.countRealPlayers(room);
    const maxAllowedBots = Math.max(0, this.MAX_PLAYERS - realCount);
    const targetBots = Math.max(0, Math.min(maxAllowedBots, Number(room.botCount) || 0));
    room.botCount = targetBots;

    const usedNames = new Set(Array.from(room.players.values()).map((p) => p.username));

    for (let i = 0; i < targetBots; i++) {
      const botId = `bot_cfg_${Date.now()}_${i}`;
      let botName = BOT_NAMES[i % BOT_NAMES.length];
      if (usedNames.has(botName)) {
        botName = `${botName}_${i + 1}`;
      }
      usedNames.add(botName);

      const skinColor = BOT_COLORS[i % BOT_COLORS.length];
      const teamId = room.teamSize > 1 ? this.findAvailableTeamId(room) : null;

      room.players.set(botId, {
        socketId: botId,
        userId: botId,
        username: `🤖 ${botName}`,
        skinColor,
        teamId,
        isBot: true,
        isReady: true,
        roundWins: 0,
        totalKills: 0,
        totalShoves: 0,
        joinedAt: Date.now()
      });
    }
  }

  createPrivateRoom(hostSocket, playerProfile, options = {}) {
    this.ensureSingleRoomPerUser(hostSocket, playerProfile?.id);

    const roomId = this.generateRoomCode();
    const teamSize = this.sanitizeTeamSize(options.teamSize ?? 1);
    const friendlyFire = Boolean(options.friendlyFire ?? false);
    const allMapIds = this.mapsList.map((m) => m.id);

    const room = {
      id: roomId,
      mode: 'PRIVATE',
      hostId: hostSocket.id,
      hostName: (playerProfile?.username || 'Líder').substring(0, 15),
      maxPlayers: this.MAX_PLAYERS,
      teamSize,
      friendlyFire,
      isOpenJoin: false,
      totalRounds: DEFAULT_TOTAL_ROUNDS,
      currentRound: 1,
      selectedMapIds: [...allMapIds],
      lastPlayedMapId: null,
      playerSpeedMultiplier: 1.0,
      powerupsEnabled: true,
      powerupSpawnInterval: DEFAULT_POWERUP_SPAWN_SEC,
      matchDuration: DEFAULT_MATCH_DURATION_SEC,
      botCount: 2,
      status: 'WAITING',
      roundPhase: 'IDLE',
      combatLocked: false,
      countdown: null,
      selectedMap: this.mapsList[0],
      players: new Map(),
      joinRequests: new Map(),
      invitedSockets: new Set(),
      powerups: new Map(),
      matchLoop: null,
      countdownTimer: null,
      introTimeout: null,
      preRoundInterval: null,
      nextRoundTimeout: null
    };

    this.rooms.set(roomId, room);
    this.addPlayerDirectlyToRoom(hostSocket, room, playerProfile);
    this.syncConfiguredBots(room);
    this.broadcastRoomState(roomId);
    this.broadcastPublicRoomsList();
    this.broadcastFriendsPresence();
    return { room: this.serializeRoom(room) };
  }

  getPublicRoomsList() {
    const list = [];
    for (const room of this.rooms.values()) {
      if (room.mode === 'PRIVATE' && room.status === 'WAITING') {
        const hostPlayer = room.players.get(room.hostId);
        list.push({
          id: room.id,
          hostName: hostPlayer ? hostPlayer.username : room.hostName || 'Líder',
          playersCount: room.players.size,
          realPlayersCount: this.countRealPlayers(room),
          maxPlayers: room.maxPlayers,
          teamSize: room.teamSize,
          totalRounds: room.totalRounds,
          isOpenJoin: Boolean(room.isOpenJoin)
        });
      }
    }
    return list;
  }

  broadcastPublicRoomsList() {
    this.io.emit('rooms:list', this.getPublicRoomsList());
  }

  updateRoomConfig(socket, configData = {}) {
    const cleanId = (configData.roomId || socket.currentRoomId || '').trim().toUpperCase();
    const room = this.rooms.get(cleanId);

    if (!room) return { error: 'Sala não encontrada.' };
    if (room.hostId !== socket.id) {
      return { error: 'Apenas o criador da sala pode alterar as configurações.' };
    }
    if (room.status !== 'WAITING') {
      return { error: 'Não é possível alterar configurações com a partida em andamento.' };
    }

    if (configData.teamSize !== undefined) {
      room.teamSize = this.sanitizeTeamSize(configData.teamSize);
      this.rebalanceTeams(room);
    }

    if (configData.friendlyFire !== undefined) {
      room.friendlyFire = Boolean(configData.friendlyFire);
    }

    if (configData.totalRounds !== undefined) {
      const r = Number(configData.totalRounds);
      if (!Number.isNaN(r)) {
        room.totalRounds = Math.max(1, Math.min(MAX_TOTAL_ROUNDS, Math.round(r)));
      }
    }

    if (configData.isOpenJoin !== undefined) {
      room.isOpenJoin = Boolean(configData.isOpenJoin);
      if (room.isOpenJoin && room.joinRequests.size > 0) {
        for (const [reqSockId, reqData] of room.joinRequests.entries()) {
          const reqSocket = this.io.sockets.sockets.get(reqSockId);
          if (reqSocket && this.countRealPlayers(room) < room.maxPlayers) {
            room.joinRequests.delete(reqSockId);
            this.addPlayerDirectlyToRoom(reqSocket, room, reqData.playerProfile);
            reqSocket.emit('room:join_accepted', { room: this.serializeRoom(room) });
          }
        }
      }
    }

    if (Array.isArray(configData.selectedMapIds)) {
      const validIds = this.mapsList.map((m) => m.id);
      const filtered = configData.selectedMapIds.filter((id) => validIds.includes(id));
      if (filtered.length >= 1) {
        room.selectedMapIds = filtered;
      }
    }

    if (configData.playerSpeedMultiplier !== undefined) {
      const spd = Number(configData.playerSpeedMultiplier);
      if (!Number.isNaN(spd)) {
        room.playerSpeedMultiplier = Math.max(0.6, Math.min(2.0, Number(spd.toFixed(2))));
      }
    }

    if (configData.powerupsEnabled !== undefined) {
      room.powerupsEnabled = Boolean(configData.powerupsEnabled);
    }

    if (configData.powerupSpawnInterval !== undefined) {
      const interval = Number(configData.powerupSpawnInterval);
      if (!Number.isNaN(interval)) {
        room.powerupSpawnInterval = Math.max(5, Math.min(60, Math.round(interval)));
      }
    }

    if (configData.matchDuration !== undefined) {
      const dur = Number(configData.matchDuration);
      if (!Number.isNaN(dur)) {
        room.matchDuration = Math.max(30, Math.min(600, Math.round(dur)));
      }
    }

    if (configData.botCount !== undefined) {
      const bots = Number(configData.botCount);
      if (!Number.isNaN(bots)) {
        room.botCount = Math.max(0, Math.min(14, Math.round(bots)));
        this.syncConfiguredBots(room);
      }
    }

    this.broadcastRoomState(cleanId);
    this.broadcastPublicRoomsList();
    return { room: this.serializeRoom(room) };
  }

  kickPlayer(hostSocket, { roomId, targetSocketId } = {}) {
    const cleanId = (roomId || hostSocket.currentRoomId || '').trim().toUpperCase();
    const room = this.rooms.get(cleanId);

    if (!room) return { error: 'Sala não encontrada.' };
    if (room.hostId !== hostSocket.id) {
      return { error: 'Apenas o criador da sala pode expulsar jogadores.' };
    }
    if (!targetSocketId || targetSocketId === hostSocket.id) {
      return { error: 'Alvo inválido para expulsão.' };
    }

    const targetPlayer = room.players.get(targetSocketId);
    if (!targetPlayer) return { error: 'Jogador não encontrado na sala.' };

    room.players.delete(targetSocketId);

    const targetSocket = this.io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.leave(cleanId);
      targetSocket.currentRoomId = null;
      targetSocket.emit('room:kicked', {
        roomId: cleanId,
        reason: 'Você foi removido da sala pelo criador.'
      });
    }

    this.broadcastRoomState(cleanId);
    this.broadcastPublicRoomsList();
    this.broadcastFriendsPresence();
    return { room: this.serializeRoom(room) };
  }

  requestOrJoinRoom(socket, roomId, playerProfile, forceDirectFromInvite = false) {
    if (!roomId || typeof roomId !== 'string') {
      return { error: 'Informe um código de sala válido.' };
    }

    const cleanId = roomId.trim().toUpperCase();
    const room = this.rooms.get(cleanId);

    if (!room) {
      return { error: 'Sala não encontrada! Verifique o código ou a lista de salas.' };
    }
    if (room.status !== 'WAITING') {
      return { error: 'A partida nesta sala já começou!' };
    }

    if (room.players.has(socket.id)) {
      return { room: this.serializeRoom(room) };
    }

    // Se o jogador veio de um Convite de Amigo (ou se a sala está livre / foi convidado), permite trocar/entrar direto!
    const wasInvited = Boolean(
      forceDirectFromInvite || (room.invitedSockets && room.invitedSockets.has(socket.id))
    );

    if (socket.currentRoomId && socket.currentRoomId !== cleanId && !wasInvited) {
      return { error: 'Você já está em uma sala! Saia da sala atual antes de entrar em outra.' };
    }

    const realCount = this.countRealPlayers(room);
    if (realCount >= room.maxPlayers) {
      return { error: `Esta sala já atingiu o limite máximo de ${room.maxPlayers} usuários!` };
    }

    if (room.isOpenJoin || room.hostId === socket.id || wasInvited) {
      if (room.invitedSockets) room.invitedSockets.delete(socket.id);
      return this.addPlayerDirectlyToRoom(socket, room, playerProfile);
    }

    const safeProfile = playerProfile || {};
    room.joinRequests.set(socket.id, {
      socketId: socket.id,
      userId: safeProfile.id || `user_${socket.id}`,
      username: (safeProfile.username || 'Jogador').substring(0, 15),
      skinColor: safeProfile.skinColor || '#00E5FF',
      playerProfile: safeProfile,
      requestedAt: Date.now()
    });

    this.broadcastRoomState(cleanId);
    return {
      pendingApproval: true,
      roomId: cleanId,
      message: `Solicitação enviada para a sala ${cleanId}! Aguarde o criador aceitar.`
    };
  }

  respondJoinRequest(hostSocket, { roomId, requesterSocketId, accept } = {}) {
    const cleanId = (roomId || hostSocket.currentRoomId || '').trim().toUpperCase();
    const room = this.rooms.get(cleanId);

    if (!room) return { error: 'Sala não encontrada.' };
    if (room.hostId !== hostSocket.id) {
      return { error: 'Apenas o criador da sala pode aprovar solicitações.' };
    }

    const reqData = room.joinRequests.get(requesterSocketId);
    if (!reqData) {
      return { error: 'Solicitação não encontrada ou já respondida.' };
    }

    room.joinRequests.delete(requesterSocketId);
    const requesterSocket = this.io.sockets.sockets.get(requesterSocketId);

    if (!accept) {
      if (requesterSocket) {
        requesterSocket.emit('room:join_rejected', {
          roomId: cleanId,
          reason: 'O criador da sala recusou sua solicitação de entrada.'
        });
      }
      this.broadcastRoomState(cleanId);
      return { room: this.serializeRoom(room) };
    }

    if (!requesterSocket) {
      this.broadcastRoomState(cleanId);
      return { error: 'O jogador desconectou.' };
    }
    if (requesterSocket.currentRoomId && requesterSocket.currentRoomId !== cleanId) {
      this.broadcastRoomState(cleanId);
      return { error: 'Este jogador já entrou em outra sala.' };
    }

    const joinRes = this.addPlayerDirectlyToRoom(requesterSocket, room, reqData.playerProfile);
    if (joinRes.error) {
      requesterSocket.emit('room:join_rejected', { roomId: cleanId, reason: joinRes.error });
      return joinRes;
    }

    requesterSocket.emit('room:join_accepted', { room: joinRes.room });
    return joinRes;
  }

  addPlayerDirectlyToRoom(socket, room, playerProfile) {
    const cleanId = room.id;
    const realCount = this.countRealPlayers(room);

    if (!room.players.has(socket.id) && realCount >= room.maxPlayers) {
      return { error: `Esta sala já atingiu o limite máximo de ${room.maxPlayers} usuários!` };
    }

    if (!room.players.has(socket.id) && room.players.size >= room.maxPlayers && room.mode === 'PRIVATE') {
      for (const [k, p] of room.players.entries()) {
        if (p.isBot) {
          room.players.delete(k);
          room.botCount = Math.max(0, (room.botCount || 1) - 1);
          break;
        }
      }
    }

    this.ensureSingleRoomPerUser(socket, playerProfile?.id);

    const safeProfile = playerProfile || {};
    const teamId = room.teamSize > 1 ? this.findAvailableTeamId(room) : null;
    const isHostPlayer = room.hostId === socket.id;

    const playerObj = {
      socketId: socket.id,
      userId: safeProfile.id || `user_${socket.id}`,
      username: (safeProfile.username || 'Jogador').substring(0, 15),
      skinColor: safeProfile.skinColor || '#FF3366',
      stats: authRoutes.normalizeStats(safeProfile.stats || {}),
      teamId,
      isBot: false,
      isReady: isHostPlayer,
      roundWins: 0,
      totalKills: 0,
      totalShoves: 0,
      joinedAt: Date.now()
    };

    room.players.set(socket.id, playerObj);
    room.joinRequests?.delete(socket.id);
    socket.join(cleanId);
    socket.currentRoomId = cleanId;

    this.broadcastRoomState(cleanId);
    this.broadcastPublicRoomsList();
    this.broadcastFriendsPresence();
    return { room: this.serializeRoom(room) };
  }

  togglePlayerReady(socket, { roomId } = {}) {
    const cleanId = (roomId || socket.currentRoomId || '').trim().toUpperCase();
    const room = this.rooms.get(cleanId);

    if (!room) return { error: 'Sala não encontrada.' };
    if (room.status !== 'WAITING') return { error: 'A partida já começou!' };

    const player = room.players.get(socket.id);
    if (!player) return { error: 'Você não está nesta sala.' };

    if (room.hostId === socket.id) {
      player.isReady = true;
      return { room: this.serializeRoom(room), isReady: true };
    }

    player.isReady = !player.isReady;
    this.broadcastRoomState(cleanId);
    return { room: this.serializeRoom(room), isReady: player.isReady };
  }

  areAllRealPlayersReady(room) {
    for (const p of room.players.values()) {
      if (!p.isBot && p.socketId !== room.hostId) {
        if (!p.isReady) return false;
      }
    }
    return true;
  }

  selectTeam(socket, { roomId, teamId }) {
    const cleanId = (roomId || socket.currentRoomId || '').trim().toUpperCase();
    const room = this.rooms.get(cleanId);

    if (!room) return { error: 'Sala não encontrada.' };
    if (room.status !== 'WAITING') return { error: 'A partida já começou!' };
    if (room.teamSize <= 1) return { error: 'Esta sala está no modo Individual (Solo).' };

    const player = room.players.get(socket.id);
    if (!player) return { error: 'Você não está nesta sala.' };

    const targetTeamId = Number(teamId);
    const validTeams = this.getAvailableTeamsForSize(room.teamSize);
    const teamExists = validTeams.some((t) => t.id === targetTeamId);
    if (!teamExists) return { error: 'Time inválido para esta configuração.' };

    if (player.teamId === targetTeamId) {
      return { room: this.serializeRoom(room) };
    }

    let currentInTeam = 0;
    for (const p of room.players.values()) {
      if (p.teamId === targetTeamId) currentInTeam++;
    }

    if (currentInTeam >= room.teamSize) {
      return { error: `Este time já está cheio (${room.teamSize}/${room.teamSize})!` };
    }

    player.teamId = targetTeamId;
    this.broadcastRoomState(cleanId);
    return { room: this.serializeRoom(room) };
  }

  findOrCreateBattleRoyale(socket, playerProfile) {
    if (socket.currentRoomId) {
      this.leaveCurrentRoom(socket);
    }

    let targetRoom = null;

    for (const room of this.rooms.values()) {
      if (
        room.mode === 'BATTLEROYALE' &&
        room.status === 'WAITING' &&
        room.players.size < this.MAX_PLAYERS
      ) {
        targetRoom = room;
        break;
      }
    }

    if (!targetRoom) {
      const roomId = 'BR_' + this.generateRoomCode();
      const allMapIds = this.mapsList.map((m) => m.id);
      targetRoom = {
        id: roomId,
        mode: 'BATTLEROYALE',
        hostId: null,
        maxPlayers: this.MAX_PLAYERS,
        teamSize: 1,
        friendlyFire: false,
        isOpenJoin: true,
        totalRounds: DEFAULT_TOTAL_ROUNDS,
        currentRound: 1,
        selectedMapIds: [...allMapIds],
        lastPlayedMapId: null,
        playerSpeedMultiplier: 1.0,
        powerupsEnabled: true,
        powerupSpawnInterval: DEFAULT_POWERUP_SPAWN_SEC,
        matchDuration: DEFAULT_MATCH_DURATION_SEC,
        botCount: 0,
        status: 'WAITING',
        roundPhase: 'IDLE',
        combatLocked: false,
        countdown: this.BR_WAIT_TIME_SECONDS,
        minRealPlayers: this.BR_MIN_REAL_PLAYERS,
        selectedMap: this.mapsList[0],
        players: new Map(),
        joinRequests: new Map(),
        invitedSockets: new Set(),
        powerups: new Map(),
        matchLoop: null,
        countdownTimer: null,
        introTimeout: null,
        preRoundInterval: null,
        nextRoundTimeout: null
      };
      this.rooms.set(roomId, targetRoom);
      this.startBattleRoyaleCountdown(targetRoom);
    }

    const joinRes = this.addPlayerDirectlyToRoom(socket, targetRoom, playerProfile);

    const realCount = this.countRealPlayers(targetRoom);
    if (realCount >= this.MAX_PLAYERS && targetRoom.status === 'WAITING') {
      this.clearRoomTimers(targetRoom);
      this.launchMatch(targetRoom);
    }

    return joinRes;
  }

  countRealPlayers(room) {
    let count = 0;
    for (const p of room.players.values()) {
      if (!p.isBot) count++;
    }
    return count;
  }

  startBattleRoyaleCountdown(room) {
    if (room.countdownTimer) clearInterval(room.countdownTimer);

    room.countdown = this.BR_WAIT_TIME_SECONDS;

    room.countdownTimer = setInterval(() => {
      if (!this.rooms.has(room.id) || room.status !== 'WAITING') {
        clearInterval(room.countdownTimer);
        room.countdownTimer = null;
        return;
      }

      room.countdown -= 1;
      const realPlayers = this.countRealPlayers(room);

      this.io.to(room.id).emit('room:br_countdown', {
        roomId: room.id,
        countdown: room.countdown,
        realPlayers,
        minRealPlayers: this.BR_MIN_REAL_PLAYERS,
        maxPlayers: room.maxPlayers
      });

      if (room.countdown <= 0) {
        clearInterval(room.countdownTimer);
        room.countdownTimer = null;

        if (realPlayers < this.BR_MIN_REAL_PLAYERS) {
          this.cancelBattleRoyaleRoom(
            room,
            `Partida cancelada! Eram necessários pelo menos ${this.BR_MIN_REAL_PLAYERS} jogadores reais em 1 minuto (havia ${realPlayers}).`
          );
        } else {
          this.fillRoomWithBots(room);
          this.launchMatch(room);
        }
      }
    }, 1000);
  }

  cancelBattleRoyaleRoom(room, reason) {
    room.status = 'CANCELLED';
    this.io.to(room.id).emit('room:cancelled', {
      roomId: room.id,
      reason
    });

    for (const p of room.players.values()) {
      if (!p.isBot) {
        const clientSocket = this.io.sockets.sockets.get(p.socketId);
        if (clientSocket) {
          clientSocket.leave(room.id);
          clientSocket.currentRoomId = null;
        }
      }
    }

    this.clearRoomTimers(room);
    this.rooms.delete(room.id);
    this.broadcastPublicRoomsList();
    this.broadcastFriendsPresence();
  }

  fillRoomWithBots(room) {
    const slotsAvailable = this.MAX_PLAYERS - room.players.size;
    if (slotsAvailable <= 0) return;

    const usedNames = new Set(Array.from(room.players.values()).map((p) => p.username));

    for (let i = 0; i < slotsAvailable; i++) {
      const botId = `bot_${Date.now()}_${i}`;
      let botName = BOT_NAMES[i % BOT_NAMES.length];
      if (usedNames.has(botName)) {
        botName = `${botName}_${i + 1}`;
      }
      usedNames.add(botName);

      const skinColor = BOT_COLORS[i % BOT_COLORS.length];
      const teamId = room.teamSize > 1 ? this.findAvailableTeamId(room) : null;

      room.players.set(botId, {
        socketId: botId,
        userId: botId,
        username: `🤖 ${botName}`,
        skinColor,
        teamId,
        isBot: true,
        isReady: true,
        roundWins: 0,
        totalKills: 0,
        totalShoves: 0,
        joinedAt: Date.now()
      });
    }
  }

  leaveCurrentRoom(socket) {
    for (const r of this.rooms.values()) {
      if (r.joinRequests && r.joinRequests.has(socket.id)) {
        r.joinRequests.delete(socket.id);
        this.broadcastRoomState(r.id);
      }
    }

    const roomId = socket.currentRoomId;
    if (!roomId || !this.rooms.has(roomId)) return;

    const room = this.rooms.get(roomId);
    const leavingPlayer = room.players.get(socket.id);
    if (leavingPlayer) {
      this.releaseAnyGrabLinks(room, leavingPlayer);
    }

    room.players.delete(socket.id);
    socket.leave(roomId);
    socket.currentRoomId = null;

    const remainingRealPlayers = this.countRealPlayers(room);

    if (remainingRealPlayers === 0) {
      this.clearRoomTimers(room);
      this.rooms.delete(roomId);
    } else {
      if (room.mode === 'PRIVATE' && room.hostId === socket.id) {
        for (const p of room.players.values()) {
          if (!p.isBot) {
            room.hostId = p.socketId;
            room.hostName = p.username;
            p.isReady = true;
            break;
          }
        }
      }
      this.broadcastRoomState(roomId);
    }
    this.broadcastPublicRoomsList();
    this.broadcastFriendsPresence();
  }

  startMatch(socket, roomId) {
    const cleanId = (roomId || socket.currentRoomId || '').trim().toUpperCase();
    const room = this.rooms.get(cleanId);

    if (!room) return { error: 'Sala não encontrada.' };
    if (room.mode === 'PRIVATE' && room.hostId !== socket.id) {
      return { error: 'Apenas o criador da sala pode iniciar a partida!' };
    }
    if (room.status !== 'WAITING') {
      return { error: 'A partida já foi iniciada.' };
    }

    if (!this.areAllRealPlayersReady(room)) {
      return {
        error: 'Aguarde todos os jogadores convidados clicarem em "Pronto" antes de iniciar!'
      };
    }

    if (room.players.size < 2) {
      room.botCount = 1;
      this.syncConfiguredBots(room);
    }

    this.launchMatch(room);
    return { success: true };
  }

  // ==========================================================================
  // LÓGICA DE MÚLTIPLOS ROUNDS, APRESENTAÇÃO DO MAPA E CONTAGEM 5..1 SHOVE!
  // ==========================================================================

  launchMatch(room) {
    this.clearRoomTimers(room);
    room.status = 'PLAYING';
    room.currentRound = 1;
    room.totalRounds = Math.max(1, Math.min(MAX_TOTAL_ROUNDS, Number(room.totalRounds) || DEFAULT_TOTAL_ROUNDS));
    room.lastPlayedMapId = null;
    room.teamRoundWins = new Map();

    for (const p of room.players.values()) {
      p.roundWins = 0;
      p.totalKills = 0;
      p.totalShoves = 0;
    }

    this.broadcastPublicRoomsList();
    this.startRound(room);
  }

  startRound(room) {
    this.clearRoomTimers(room);
    room.selectedMap = this.pickMapForRound(room);
    room.powerups = new Map();
    room.nextPowerupId = 1;

    const spawnInterval = Math.max(5, Number(room.powerupSpawnInterval) || DEFAULT_POWERUP_SPAWN_SEC);
    room.powerupTimerSec = spawnInterval;

    const mapPhysics = room.selectedMap.physics;
    const totalPlayers = room.players.size;
    room.initialPlayerCount = totalPlayers;
    room.matchTimeRemaining = Math.max(30, Number(room.matchDuration) || DEFAULT_MATCH_DURATION_SEC);
    room.speedMultiplier = room.playerSpeedMultiplier || 1.0;

    room.roundPhase = 'MAP_INTRO';
    room.combatLocked = true;

    const spawnRadius = mapPhysics.innerHoleRadius > 0
      ? (mapPhysics.innerHoleRadius + mapPhysics.radius) * 0.52
      : mapPhysics.radius * 0.62;

    let idx = 0;
    for (const p of room.players.values()) {
      const angle = (idx / totalPlayers) * Math.PI * 2;
      p.x = Math.cos(angle) * spawnRadius;
      p.y = 0;
      p.z = Math.sin(angle) * spawnRadius;
      p.vx = 0;
      p.vy = 0;
      p.vz = 0;
      p.rotationY = Math.atan2(-p.x, -p.z);
      p.inputX = 0;
      p.inputZ = 0;

      p.charging = false;
      p.chargePower = 0;
      p.grabCharging = false;
      p.grabChargePower = 0;
      p.grabbedTargetId = null;
      p.grabbedById = null;
      p.escapePresses = 0;

      p.stunnedUntil = 0;
      p.invisibleUntil = 0;
      p.heavyUntil = 0;
      p.shockedUntil = 0;
      p.hasMegaShove = false;
      p.hasShockWeapon = false;

      p.alive = true;
      p.kills = 0;
      p.shovesCount = 0;
      p.lastShovedBy = null;
      p.lastShovedAt = 0;
      p.botCooldown = 0.7 + Math.random() * 1.0;
      p.botEscapeTimer = 0;
      idx++;
    }

    room.currentArenaRadius = mapPhysics.radius;
    room.matchStartTime = Date.now() + MAP_INTRO_DURATION_MS + PRE_ROUND_COUNTDOWN_SEC * 1000;

    const serializedRoom = this.serializeRoom(room);

    this.io.to(room.id).emit('room:started', {
      roomId: room.id,
      room: serializedRoom,
      map: room.selectedMap,
      currentRound: room.currentRound,
      totalRounds: room.totalRounds
    });

    this.io.to(room.id).emit('match:map_presentation', {
      currentRound: room.currentRound,
      totalRounds: room.totalRounds,
      map: room.selectedMap,
      durationMs: MAP_INTRO_DURATION_MS
    });

    const dt = 1 / this.TICK_RATE;
    room.matchLoop = setInterval(() => {
      this.updateMatchPhysics(room, dt);
    }, 1000 / this.TICK_RATE);

    room.introTimeout = setTimeout(() => {
      if (!this.rooms.has(room.id) || room.status !== 'PLAYING') return;

      room.roundPhase = 'COUNTDOWN';
      let count = PRE_ROUND_COUNTDOWN_SEC;

      this.io.to(room.id).emit('match:pre_countdown', {
        count,
        text: String(count)
      });

      room.preRoundInterval = setInterval(() => {
        if (!this.rooms.has(room.id) || room.status !== 'PLAYING') {
          clearInterval(room.preRoundInterval);
          room.preRoundInterval = null;
          return;
        }

        count -= 1;
        if (count > 0) {
          this.io.to(room.id).emit('match:pre_countdown', {
            count,
            text: String(count)
          });
        } else {
          clearInterval(room.preRoundInterval);
          room.preRoundInterval = null;
          room.roundPhase = 'ACTIVE';
          room.combatLocked = false;
          room.matchStartTime = Date.now();

          this.io.to(room.id).emit('match:pre_countdown', {
            count: 0,
            text: 'SHOVE!'
          });
        }
      }, 1000);
    }, MAP_INTRO_DURATION_MS);
  }

  releaseAnyGrabLinks(room, player) {
    if (!player) return;
    if (player.grabbedTargetId) {
      const target = room.players.get(player.grabbedTargetId);
      if (target) {
        target.grabbedById = null;
        target.escapePresses = 0;
        if (target.y > 0) target.y = 0.2;
      }
      player.grabbedTargetId = null;
      player.grabCharging = false;
      player.grabChargePower = 0;
    }
    if (player.grabbedById) {
      const captor = room.players.get(player.grabbedById);
      if (captor) {
        captor.grabbedTargetId = null;
        captor.grabCharging = false;
        captor.grabChargePower = 0;
      }
      player.grabbedById = null;
      player.escapePresses = 0;
    }
  }

  handlePlayerInput(socket, inputData) {
    const roomId = socket.currentRoomId;
    if (!roomId || !this.rooms.has(roomId)) return;

    const room = this.rooms.get(roomId);
    if (room.status !== 'PLAYING') return;

    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    const now = Date.now();
    const isIncapacitated = now < player.stunnedUntil || now < player.shockedUntil;

    if (player.grabbedById || isIncapacitated) {
      player.inputX = 0;
      player.inputZ = 0;
      return;
    }

    let mx = Number(inputData?.moveX) || 0;
    let mz = Number(inputData?.moveZ) || 0;
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }

    player.inputX = mx;
    player.inputZ = mz;

    if (room.combatLocked) {
      player.charging = false;
      player.chargePower = 0;
      player.grabCharging = false;
      player.grabChargePower = 0;
      return;
    }

    if (typeof inputData?.charging === 'boolean') {
      if (player.charging && !inputData.charging) {
        this.executeShove(room, player, player.chargePower);
        player.chargePower = 0;
      }
      player.charging = inputData.charging;
    }

    if (typeof inputData?.grabCharging === 'boolean') {
      if (!player.grabCharging && inputData.grabCharging) {
        player.grabCharging = true;
        this.tryStartGrab(room, player);
      } else if (player.grabCharging && !inputData.grabCharging) {
        this.throwGrabbedTarget(room, player);
        player.grabCharging = false;
        player.grabChargePower = 0;
      }
    }
  }

  handlePlayerShoveOrEscape(socket, { power } = {}) {
    const roomId = socket.currentRoomId;
    if (!roomId || !this.rooms.has(roomId)) return;

    const room = this.rooms.get(roomId);
    if (room.status !== 'PLAYING' || room.combatLocked) return;

    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    const now = Date.now();
    if (now < player.shockedUntil || now < player.stunnedUntil) return;

    if (player.grabbedById) {
      this.registerEscapePress(room, player);
      return;
    }

    const finalPower = Math.max(0.25, Math.min(1.0, Number(power) || player.chargePower || 0.5));
    this.executeShove(room, player, finalPower);
    player.charging = false;
    player.chargePower = 0;
  }

  registerEscapePress(room, victim) {
    if (!victim.grabbedById) return;
    const captor = room.players.get(victim.grabbedById);
    if (!captor || !captor.alive) {
      this.releaseAnyGrabLinks(room, victim);
      return;
    }

    victim.escapePresses = (victim.escapePresses || 0) + 1;

    this.io.to(room.id).emit('match:escape_progress', {
      victimId: victim.socketId,
      captorId: captor.socketId,
      presses: victim.escapePresses,
      required: ESCAPE_REQUIRED_PRESSES
    });

    if (victim.escapePresses >= ESCAPE_REQUIRED_PRESSES) {
      this.releaseAnyGrabLinks(room, victim);

      const angle = captor.rotationY + Math.PI * 0.5;
      victim.x = captor.x + Math.sin(angle) * 1.4;
      victim.z = captor.z + Math.cos(angle) * 1.4;
      victim.y = 0;
      victim.vx = Math.sin(angle) * 6;
      victim.vz = Math.cos(angle) * 6;
      victim.vy = 2.5;

      captor.stunnedUntil = Date.now() + STUN_ON_ESCAPE_MS;
      captor.vx = -Math.sin(captor.rotationY) * 4;
      captor.vz = -Math.cos(captor.rotationY) * 4;

      this.io.to(room.id).emit('match:escaped', {
        victimId: victim.socketId,
        victimName: victim.username,
        captorId: captor.socketId,
        captorName: captor.username,
        stunMs: STUN_ON_ESCAPE_MS
      });
    }
  }

  tryStartGrab(room, attacker) {
    if (room.combatLocked) return;
    if (!attacker || !attacker.alive || attacker.grabbedById || attacker.grabbedTargetId) return;

    const now = Date.now();
    if (now < attacker.stunnedUntil || now < attacker.shockedUntil) return;

    if (attacker.invisibleUntil > now) {
      attacker.invisibleUntil = 0;
    }

    const GRAB_RANGE = 2.35;
    let nearestTarget = null;
    let minDist = Infinity;

    for (const target of room.players.values()) {
      if (target.socketId === attacker.socketId || !target.alive) continue;
      if (target.grabbedById || target.grabbedTargetId) continue;
      if (this.isProtectedTeammate(room, attacker, target)) continue;
      if (target.invisibleUntil > now) continue;
      if (target.heavyUntil > now) continue;

      const dist = Math.hypot(target.x - attacker.x, target.z - attacker.z);
      if (dist <= GRAB_RANGE && dist < minDist) {
        minDist = dist;
        nearestTarget = target;
      }
    }

    if (nearestTarget) {
      attacker.grabbedTargetId = nearestTarget.socketId;
      attacker.grabChargePower = 0.1;

      nearestTarget.grabbedById = attacker.socketId;
      nearestTarget.escapePresses = 0;
      nearestTarget.charging = false;
      nearestTarget.chargePower = 0;
      nearestTarget.vx = 0;
      nearestTarget.vy = 0;
      nearestTarget.vz = 0;

      this.io.to(room.id).emit('match:grabbed', {
        captorId: attacker.socketId,
        captorName: attacker.username,
        victimId: nearestTarget.socketId,
        victimName: nearestTarget.username,
        requiredPresses: ESCAPE_REQUIRED_PRESSES
      });
    }
  }

  throwGrabbedTarget(room, attacker) {
    if (!attacker || !attacker.grabbedTargetId) return;

    const target = room.players.get(attacker.grabbedTargetId);
    const power = Math.max(0.15, Math.min(1.0, attacker.grabChargePower || 0.2));

    attacker.grabbedTargetId = null;
    attacker.grabChargePower = 0;

    if (!target || !target.alive) return;

    target.grabbedById = null;
    target.escapePresses = 0;

    const dirX = Math.sin(attacker.rotationY);
    const dirZ = Math.cos(attacker.rotationY);

    const vulnMult = Date.now() < target.shockedUntil ? 1.35 : 1.0;
    const throwForce = (15 + power * 27) * vulnMult;

    target.x = attacker.x + dirX * 1.1;
    target.z = attacker.z + dirZ * 1.1;
    target.y = Math.max(0.5, attacker.y + 1.4);
    target.vx = dirX * throwForce;
    target.vz = dirZ * throwForce;
    target.vy = 5.0 + power * 4.5;

    target.lastShovedBy = attacker.socketId;
    target.lastShovedAt = Date.now();
    attacker.shovesCount = (attacker.shovesCount || 0) + 1;
    attacker.totalShoves = (attacker.totalShoves || 0) + 1;

    this.io.to(room.id).emit('match:thrown', {
      attackerId: attacker.socketId,
      targetId: target.socketId,
      x: attacker.x,
      z: attacker.z,
      power
    });
  }

  isProtectedTeammate(room, p1, p2) {
    if (room.teamSize <= 1) return false;
    if (room.friendlyFire) return false;
    return p1.teamId !== null && p1.teamId === p2.teamId;
  }

  executeShove(room, attacker, normalizedPower = 0.6) {
    if (room.combatLocked) return;
    if (!attacker || !attacker.alive || attacker.grabbedById) return;

    const now = Date.now();
    if (now < attacker.stunnedUntil || now < attacker.shockedUntil) return;

    if (attacker.grabbedTargetId) {
      this.throwGrabbedTarget(room, attacker);
      return;
    }

    if (attacker.invisibleUntil > now) {
      attacker.invisibleUntil = 0;
    }

    if (attacker.hasShockWeapon) {
      const shockedSomeone = this.fireShockWeapon(room, attacker, now);
      if (shockedSomeone) {
        attacker.hasShockWeapon = false;
        return;
      }
    }

    const isMega = Boolean(attacker.hasMegaShove);
    const SHOVE_RANGE = isMega ? 3.4 : 2.75;

    const baseForce = isMega
      ? MAX_NORMAL_SHOVE_FORCE * 4.0
      : 13 + normalizedPower * (MAX_NORMAL_SHOVE_FORCE - 13);

    if (isMega) {
      attacker.hasMegaShove = false;
    }

    const forwardX = Math.sin(attacker.rotationY);
    const forwardZ = Math.cos(attacker.rotationY);
    attacker.vx += forwardX * 5.0;
    attacker.vz += forwardZ * 5.0;

    let hitAnyone = false;

    for (const target of room.players.values()) {
      if (target.socketId === attacker.socketId || !target.alive) continue;
      if (this.isProtectedTeammate(room, attacker, target)) continue;
      if (target.invisibleUntil > now) continue;

      const dx = target.x - attacker.x;
      const dz = target.z - attacker.z;
      const dist = Math.hypot(dx, dz);

      if (dist <= SHOVE_RANGE && dist > 0.001) {
        const nx = dx / dist;
        const nz = dz / dist;

        const vulnMult = now < target.shockedUntil ? 1.35 : 1.0;

        if (target.grabbedTargetId) {
          this.releaseAnyGrabLinks(room, target);
        }

        target.vx += nx * baseForce * vulnMult;
        target.vz += nz * baseForce * vulnMult;
        target.vy = isMega ? 9.5 : 4.4 + normalizedPower * 2.6;

        target.lastShovedBy = attacker.socketId;
        target.lastShovedAt = now;
        attacker.shovesCount = (attacker.shovesCount || 0) + 1;
        attacker.totalShoves = (attacker.totalShoves || 0) + 1;
        hitAnyone = true;
      }
    }

    this.io.to(room.id).emit('match:shove_fx', {
      attackerId: attacker.socketId,
      x: attacker.x,
      z: attacker.z,
      power: isMega ? 1.5 : normalizedPower,
      isMega,
      hitAnyone
    });
  }

  fireShockWeapon(room, attacker, now) {
    const SHOCK_RANGE = 5.2;
    let bestTarget = null;
    let minDist = Infinity;

    for (const target of room.players.values()) {
      if (target.socketId === attacker.socketId || !target.alive) continue;
      if (this.isProtectedTeammate(room, attacker, target)) continue;
      if (target.invisibleUntil > now) continue;

      const dist = Math.hypot(target.x - attacker.x, target.z - attacker.z);
      if (dist <= SHOCK_RANGE && dist < minDist) {
        minDist = dist;
        bestTarget = target;
      }
    }

    if (!bestTarget) return false;

    bestTarget.shockedUntil = now + SHOCK_DURATION_MS;
    bestTarget.charging = false;
    bestTarget.chargePower = 0;
    this.releaseAnyGrabLinks(room, bestTarget);

    this.io.to(room.id).emit('match:shock_fx', {
      attackerId: attacker.socketId,
      attackerName: attacker.username,
      targetId: bestTarget.socketId,
      targetName: bestTarget.username,
      fromX: attacker.x,
      fromZ: attacker.z,
      toX: bestTarget.x,
      toZ: bestTarget.z,
      durationMs: SHOCK_DURATION_MS
    });

    return true;
  }

  spawnRandomPowerup(room) {
    const mapPhysics = room.selectedMap.physics;
    const minR = mapPhysics.innerHoleRadius > 0 ? mapPhysics.innerHoleRadius + 1.4 : 1.2;
    const maxR = Math.max(minR + 0.5, room.currentArenaRadius - 1.8);

    const angle = Math.random() * Math.PI * 2;
    const r = minR + Math.random() * (maxR - minR);
    let x = Math.cos(angle) * r;
    let z = Math.sin(angle) * r;

    if (Array.isArray(mapPhysics.pillars)) {
      for (const pil of mapPhysics.pillars) {
        if (Math.hypot(x - pil.x, z - pil.z) < pil.radius + 1.2) {
          x = 0;
          z = 0;
        }
      }
    }

    const template = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
    const id = `pwr_${room.nextPowerupId++}`;

    const powerup = {
      id,
      type: template.type,
      name: template.name,
      icon: template.icon,
      color: template.color,
      x: Number(x.toFixed(2)),
      y: 9.0,
      z: Number(z.toFixed(2))
    };

    room.powerups.set(id, powerup);
    this.io.to(room.id).emit('match:powerup_spawned', powerup);
  }

  applyPowerupToPlayer(room, player, powerup) {
    const now = Date.now();

    switch (powerup.type) {
      case 'INVISIBLE':
        player.invisibleUntil = now + INVISIBLE_DURATION_MS;
        break;
      case 'MEGA_SHOVE':
        player.hasMegaShove = true;
        break;
      case 'HEAVYWEIGHT':
        player.heavyUntil = now + HEAVYWEIGHT_DURATION_MS;
        break;
      case 'SHOCK':
        player.hasShockWeapon = true;
        break;
      default:
        break;
    }

    this.io.to(room.id).emit('match:powerup_collected', {
      powerupId: powerup.id,
      powerupType: powerup.type,
      powerupName: powerup.name,
      powerupIcon: powerup.icon,
      playerId: player.socketId,
      playerName: player.username
    });
  }

  updateMatchPhysics(room, dt) {
    if (room.status !== 'PLAYING' || room.roundPhase === 'ROUND_OVER') return;

    const now = Date.now();
    const mapPhysics = room.selectedMap.physics;
    const playersArr = Array.from(room.players.values());
    const alivePlayers = playersArr.filter((p) => p.alive);

    const totalMatchDur = Math.max(30, Number(room.matchDuration) || DEFAULT_MATCH_DURATION_SEC);

    if (!room.combatLocked) {
      const elapsedSec = Math.max(0, (now - room.matchStartTime) / 1000);
      room.matchTimeRemaining = Math.max(0, totalMatchDur - elapsedSec);

      const fallenPlayers = Math.max(0, (room.initialPlayerCount || playersArr.length) - alivePlayers.length);
      const totalPossibleFallen = Math.max(1, (room.initialPlayerCount || playersArr.length) - 1);
      const fallenRatio = Math.min(1, fallenPlayers / totalPossibleFallen);
      const timeProgress = Math.min(1, elapsedSec / totalMatchDur);

      const hostBaseSpeedMult = Number(room.playerSpeedMultiplier) || 1.0;
      room.speedMultiplier = hostBaseSpeedMult * (1.0 + fallenRatio * 0.45 + timeProgress * 0.35);

      if (mapPhysics.shrinkRate > 0 && room.currentArenaRadius > mapPhysics.minRadius) {
        room.currentArenaRadius = Math.max(
          mapPhysics.minRadius,
          room.currentArenaRadius - mapPhysics.shrinkRate * dt
        );
      }

      if (room.powerupsEnabled !== false) {
        room.powerupTimerSec -= dt;
        if (room.powerupTimerSec <= 0) {
          room.powerupTimerSec = Math.max(5, Number(room.powerupSpawnInterval) || DEFAULT_POWERUP_SPAWN_SEC);
          if (room.powerups.size < 4) {
            this.spawnRandomPowerup(room);
          }
        }

        for (const [pwrId, pwr] of room.powerups.entries()) {
          if (pwr.y > 0.65) {
            pwr.y = Math.max(0.65, pwr.y - 12.0 * dt);
          }
          if (pwr.y <= 1.5) {
            for (const p of alivePlayers) {
              if (p.grabbedById || p.y < -0.2) continue;
              const d = Math.hypot(p.x - pwr.x, p.z - pwr.z);
              if (d < 1.35) {
                this.applyPowerupToPlayer(room, p, pwr);
                room.powerups.delete(pwrId);
                break;
              }
            }
          }
        }
      }
    }

    for (const p of playersArr) {
      if (!p.alive) continue;

      if (p.grabbedById) {
        const captor = room.players.get(p.grabbedById);
        if (!captor || !captor.alive || now < captor.stunnedUntil || now < captor.shockedUntil) {
          this.releaseAnyGrabLinks(room, p);
        } else {
          p.x = captor.x + Math.sin(captor.rotationY) * 0.35;
          p.z = captor.z + Math.cos(captor.rotationY) * 0.35;
          p.y = captor.y + 2.15;
          p.rotationY = captor.rotationY;

          if (p.isBot && now >= p.shockedUntil && !room.combatLocked) {
            p.botEscapeTimer = (p.botEscapeTimer || 0) + dt;
            if (p.botEscapeTimer >= 0.28) {
              p.botEscapeTimer = 0;
              this.registerEscapePress(room, p);
            }
          }
          continue;
        }
      }

      if (p.isBot) {
        if (room.combatLocked) {
          p.inputX = 0;
          p.inputZ = 0;
          p.charging = false;
          p.grabCharging = false;
        } else {
          this.updateBotAI(room, p, playersArr, dt, now);
        }
      }

      const isIncapacitated = now < p.stunnedUntil || now < p.shockedUntil;
      if (isIncapacitated) {
        p.inputX = 0;
        p.inputZ = 0;
        p.charging = false;
        p.chargePower = 0;
      }

      if (p.charging && !isIncapacitated && !room.combatLocked) {
        p.chargePower = Math.min(1.0, p.chargePower + dt * 0.9);
      }

      if (p.grabCharging && p.grabbedTargetId && !isIncapacitated && !room.combatLocked) {
        p.grabChargePower = Math.min(1.0, p.grabChargePower + dt * 0.75);
      }

      const distFromCenter = Math.hypot(p.x, p.z);
      const fellInCenterHole =
        mapPhysics.innerHoleRadius > 0 && distFromCenter < mapPhysics.innerHoleRadius - 0.35;
      const fellOutside = distFromCenter > room.currentArenaRadius + 0.35;

      const onPlatform = p.y >= -0.2 && !fellInCenterHole && !fellOutside;

      if (onPlatform) {
        const actionSlowdown = p.charging || p.grabbedTargetId ? 0.75 : 1.0;
        const baseSpeed = mapPhysics.moveSpeed || 18.5;
        const accel = baseSpeed * room.speedMultiplier * actionSlowdown;

        p.vx += p.inputX * accel * dt;
        p.vz += p.inputZ * accel * dt;

        if (Math.hypot(p.inputX, p.inputZ) > 0.08 && !isIncapacitated) {
          p.rotationY = Math.atan2(p.inputX, p.inputZ);
        }

        if (p.y > 0 || p.vy > 0) {
          p.vy -= 18 * dt;
          p.y += p.vy * dt;
          if (p.y < 0) {
            p.y = 0;
            p.vy = 0;
          }
        }
      } else {
        p.vy -= 26 * dt;
        p.y += p.vy * dt;
      }

      const friction = mapPhysics.friction || 0.88;
      p.vx *= friction;
      p.vz *= friction;

      p.x += p.vx * dt;
      p.z += p.vz * dt;

      if (Array.isArray(mapPhysics.pillars) && p.y >= -0.2) {
        for (const pillar of mapPhysics.pillars) {
          const dx = p.x - pillar.x;
          const dz = p.z - pillar.z;
          const dist = Math.hypot(dx, dz);
          const minDist = (pillar.radius || 1.1) + 0.65;
          if (dist < minDist && dist > 0.001) {
            const nx = dx / dist;
            const nz = dz / dist;
            p.x = pillar.x + nx * minDist;
            p.z = pillar.z + nz * minDist;
            const bounce = (pillar.bounciness || 1.2) * 9.5;
            p.vx = nx * bounce;
            p.vz = nz * bounce;
          }
        }
      }

      if (p.y < -11) {
        this.releaseAnyGrabLinks(room, p);
        p.alive = false;
        let killerName = null;
        if (p.lastShovedBy && now - p.lastShovedAt < 9000) {
          const killer = room.players.get(p.lastShovedBy);
          if (killer) {
            killer.kills = (killer.kills || 0) + 1;
            killer.totalKills = (killer.totalKills || 0) + 1;
            killerName = killer.username;
          }
        }
        this.io.to(room.id).emit('match:eliminated', {
          victimId: p.socketId,
          victimName: p.username,
          killerName
        });
      }
    }

    for (let i = 0; i < playersArr.length; i++) {
      const p1 = playersArr[i];
      if (!p1.alive || p1.y < -0.5 || p1.grabbedById) continue;

      for (let j = i + 1; j < playersArr.length; j++) {
        const p2 = playersArr[j];
        if (!p2.alive || p2.y < -0.5 || p2.grabbedById) continue;

        if (p1.invisibleUntil > now || p2.invisibleUntil > now) continue;

        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const dist = Math.hypot(dx, dz);
        const minDist = 1.3;

        if (dist < minDist && dist > 0.001) {
          const nx = dx / dist;
          const nz = dz / dist;
          const overlap = (minDist - dist) * 0.5;

          p1.x -= nx * overlap;
          p1.z -= nz * overlap;
          p2.x += nx * overlap;
          p2.z += nz * overlap;

          if (this.isProtectedTeammate(room, p1, p2)) continue;

          const bumpForce = 3.4;
          p1.vx -= nx * bumpForce;
          p1.vz -= nz * bumpForce;
          p2.vx += nx * bumpForce;
          p2.vz += nz * bumpForce;
        }
      }
    }

    this.io.to(room.id).emit('match:state', {
      arenaRadius: Number(room.currentArenaRadius.toFixed(2)),
      currentRound: room.currentRound,
      totalRounds: room.totalRounds,
      combatLocked: Boolean(room.combatLocked),
      timeRemaining: Math.ceil(room.matchTimeRemaining),
      speedMultiplier: Number(room.speedMultiplier.toFixed(2)),
      powerupsEnabled: room.powerupsEnabled !== false,
      nextPowerupIn: room.powerupsEnabled !== false ? Math.max(1, Math.ceil(room.powerupTimerSec)) : null,
      powerups: Array.from(room.powerups.values()),
      players: playersArr.map((p) => ({
        id: p.socketId,
        username: p.username,
        skinColor: p.skinColor,
        teamId: p.teamId,
        x: Number(p.x.toFixed(2)),
        y: Number(p.y.toFixed(2)),
        z: Number(p.z.toFixed(2)),
        ry: Number(p.rotationY.toFixed(2)),
        charge: Number(Math.max(p.chargePower, p.grabChargePower).toFixed(2)),
        grabbedById: p.grabbedById,
        grabbedTargetId: p.grabbedTargetId,
        escapePresses: p.escapePresses || 0,
        stunned: now < p.stunnedUntil,
        invisible: now < p.invisibleUntil,
        heavy: now < p.heavyUntil,
        shocked: now < p.shockedUntil,
        hasMegaShove: Boolean(p.hasMegaShove),
        hasShockWeapon: Boolean(p.hasShockWeapon),
        alive: p.alive,
        kills: p.kills,
        roundWins: p.roundWins || 0
      }))
    });

    if (!room.combatLocked) {
      this.checkRoundEndCondition(room, playersArr);
    }
  }

  updateBotAI(room, bot, playersArr, dt, now) {
    if (now < bot.stunnedUntil || now < bot.shockedUntil) {
      bot.inputX = 0;
      bot.inputZ = 0;
      return;
    }

    const mapPhysics = room.selectedMap.physics;

    if (bot.grabbedTargetId) {
      const distCenter = Math.hypot(bot.x, bot.z) || 0.1;
      bot.inputX = bot.x / distCenter;
      bot.inputZ = bot.z / distCenter;
      bot.rotationY = Math.atan2(bot.inputX, bot.inputZ);

      if (bot.grabChargePower >= 0.55 || distCenter > room.currentArenaRadius * 0.65) {
        this.throwGrabbedTarget(room, bot);
        bot.grabCharging = false;
        bot.botCooldown = 1.2 + Math.random();
      }
      return;
    }

    let nearestTarget = null;
    let minDist = Infinity;

    for (const other of playersArr) {
      if (other.socketId === bot.socketId || !other.alive || other.y < -0.2) continue;
      if (this.isProtectedTeammate(room, bot, other)) continue;
      if (other.invisibleUntil > now) continue;

      const d = Math.hypot(other.x - bot.x, other.z - bot.z);
      if (d < minDist) {
        minDist = d;
        nearestTarget = other;
      }
    }

    let targetX = nearestTarget ? nearestTarget.x : 0;
    let targetZ = nearestTarget ? nearestTarget.z : 0;
    for (const pwr of room.powerups.values()) {
      const dp = Math.hypot(pwr.x - bot.x, pwr.z - bot.z);
      if (pwr.y <= 1.2 && dp < 4.5 && dp < minDist) {
        targetX = pwr.x;
        targetZ = pwr.z;
        break;
      }
    }

    let moveX = 0;
    let moveZ = 0;

    if (nearestTarget || room.powerups.size > 0) {
      const dx = targetX - bot.x;
      const dz = targetZ - bot.z;
      const len = Math.hypot(dx, dz) || 1;
      moveX = dx / len;
      moveZ = dz / len;
    }

    const distFromCenter = Math.hypot(bot.x, bot.z);
    if (distFromCenter > room.currentArenaRadius * 0.72 && distFromCenter > 0.01) {
      const pullStrength = 1.45;
      moveX += (-bot.x / distFromCenter) * pullStrength;
      moveZ += (-bot.z / distFromCenter) * pullStrength;
    }

    if (mapPhysics.innerHoleRadius > 0 && distFromCenter < mapPhysics.innerHoleRadius + 2.2) {
      const pushOut = 1.65;
      const safeDist = distFromCenter || 0.1;
      moveX += (bot.x / safeDist) * pushOut;
      moveZ += (bot.z / safeDist) * pushOut;
    }

    const norm = Math.hypot(moveX, moveZ);
    if (norm > 1) {
      moveX /= norm;
      moveZ /= norm;
    }

    bot.inputX = moveX;
    bot.inputZ = moveZ;

    bot.botCooldown -= dt;
    if (nearestTarget && minDist < 3.2 && bot.botCooldown <= 0) {
      if (bot.hasShockWeapon && minDist < 4.5) {
        this.executeShove(room, bot, 0.6);
        bot.botCooldown = 1.0;
      } else if (minDist < 2.1 && Math.random() < 0.35 && !(nearestTarget.heavyUntil > now)) {
        bot.grabCharging = true;
        this.tryStartGrab(room, bot);
      } else {
        bot.charging = true;
        if (bot.chargePower >= 0.45 || minDist < 1.85) {
          this.executeShove(room, bot, Math.max(0.45, bot.chargePower));
          bot.charging = false;
          bot.chargePower = 0;
          bot.botCooldown = 1.1 + Math.random() * 1.1;
        }
      }
    } else if (minDist > 4.0) {
      bot.charging = false;
      bot.chargePower = 0;
    }
  }

  checkRoundEndCondition(room, playersArr) {
    const alivePlayers = playersArr.filter((p) => p.alive);
    const timeUp = room.matchTimeRemaining <= 0;

    if (room.teamSize <= 1) {
      if (alivePlayers.length <= 1 || timeUp) {
        const sortedAlive = [...alivePlayers].sort((a, b) => (b.kills || 0) - (a.kills || 0));
        const roundWinner = sortedAlive[0] || playersArr[0];
        if (roundWinner) {
          roundWinner.roundWins = (roundWinner.roundWins || 0) + 1;
        }
        this.handleRoundCompletion(room, {
          roundWinnerName: roundWinner ? roundWinner.username : 'Empate'
        });
      }
    } else {
      const aliveTeams = new Set(alivePlayers.map((p) => p.teamId));
      if (aliveTeams.size <= 1 || timeUp) {
        const winningTeamId = aliveTeams.values().next().value;
        const teamMeta = TEAMS_CATALOG.find((t) => t.id === winningTeamId) || TEAMS_CATALOG[0];

        if (winningTeamId) {
          const prevTeamWins = room.teamRoundWins.get(winningTeamId) || 0;
          room.teamRoundWins.set(winningTeamId, prevTeamWins + 1);
          for (const p of playersArr) {
            if (p.teamId === winningTeamId) {
              p.roundWins = (p.roundWins || 0) + 1;
            }
          }
        }

        this.handleRoundCompletion(room, {
          roundWinnerName: teamMeta ? `${teamMeta.icon} ${teamMeta.name}` : 'Empate'
        });
      }
    }
  }

  handleRoundCompletion(room, { roundWinnerName }) {
    this.clearRoomTimers(room);
    room.roundPhase = 'ROUND_OVER';
    room.combatLocked = true;

    if (room.currentRound < room.totalRounds) {
      this.io.to(room.id).emit('match:round_ended', {
        currentRound: room.currentRound,
        totalRounds: room.totalRounds,
        roundWinnerName,
        nextRoundInMs: 3200
      });

      room.nextRoundTimeout = setTimeout(() => {
        if (!this.rooms.has(room.id) || room.status !== 'PLAYING') return;
        room.currentRound += 1;
        this.startRound(room);
      }, 3200);
    } else {
      this.finalizeMultiRoundMatch(room);
    }
  }

  async finalizeMultiRoundMatch(room) {
    const playersArr = Array.from(room.players.values());
    let resultSummary = null;
    let winningSocketIds = new Set();

    if (room.teamSize <= 1) {
      const sorted = [...playersArr].sort(
        (a, b) =>
          (b.roundWins || 0) - (a.roundWins || 0) ||
          (b.totalKills || 0) - (a.totalKills || 0) ||
          (b.totalShoves || 0) - (a.totalShoves || 0)
      );
      const champion = sorted[0];
      if (champion) winningSocketIds.add(champion.socketId);

      const winnersList = playersArr
        .filter((p) => winningSocketIds.has(p.socketId))
        .map((p) => ({
          id: p.socketId,
          username: p.username,
          skinColor: p.skinColor,
          teamId: p.teamId
        }));

      const losersList = playersArr
        .filter((p) => !winningSocketIds.has(p.socketId))
        .map((p) => ({
          id: p.socketId,
          username: p.username,
          skinColor: p.skinColor,
          teamId: p.teamId
        }));

      resultSummary = {
        winnerType: 'SOLO',
        winnerName: champion ? champion.username : 'Empate!',
        winnerColor: champion ? champion.skinColor : '#FFD600',
        winnerTeam: null,
        winnersList,
        losersList
      };
    } else {
      let bestTeamId = null;
      let maxTeamWins = -1;
      for (const p of playersArr) {
        if (!p.teamId) continue;
        const tw = room.teamRoundWins.get(p.teamId) || 0;
        if (tw > maxTeamWins) {
          maxTeamWins = tw;
          bestTeamId = p.teamId;
        }
      }

      const teamMeta = TEAMS_CATALOG.find((t) => t.id === bestTeamId) || TEAMS_CATALOG[0];
      for (const p of playersArr) {
        if (p.teamId === bestTeamId) winningSocketIds.add(p.socketId);
      }

      const winnersList = playersArr
        .filter((p) => winningSocketIds.has(p.socketId))
        .map((p) => ({
          id: p.socketId,
          username: p.username,
          skinColor: p.skinColor,
          teamId: p.teamId
        }));

      const losersList = playersArr
        .filter((p) => !winningSocketIds.has(p.socketId))
        .map((p) => ({
          id: p.socketId,
          username: p.username,
          skinColor: p.skinColor,
          teamId: p.teamId
        }));

      resultSummary = {
        winnerType: 'TEAM',
        winnerName: teamMeta ? `${teamMeta.icon} ${teamMeta.name}` : 'Empate!',
        winnerColor: teamMeta ? teamMeta.color : '#00E5FF',
        winnerTeam: teamMeta || null,
        winnersList,
        losersList
      };
    }

    const xpReportBySocket = {};

    for (const p of playersArr) {
      if (p.isBot) continue;

      const isWinner = winningSocketIds.has(p.socketId);
      const shoves = p.totalShoves || 0;
      const kills = p.totalKills || 0;
      const roundWins = p.roundWins || 0;

      const xpFromShoves = shoves * 15;
      const xpFromKills = kills * 50;
      const xpFromRounds = roundWins * 60;
      const xpFromWin = isWinner ? 150 : 25;
      const totalXpGained = xpFromShoves + xpFromKills + xpFromRounds + xpFromWin;

      const progressResult = await authRoutes.updateUserMatchStats(p.userId, p.stats, {
        wins: isWinner ? 1 : 0,
        matches: 1,
        shoves,
        kills,
        xpGained: totalXpGained
      });

      p.stats = progressResult.stats;

      xpReportBySocket[p.socketId] = {
        isWinner,
        shoves,
        kills,
        roundWins,
        xpFromShoves,
        xpFromKills,
        xpFromRounds,
        xpFromWin,
        totalXpGained,
        previousLevel: progressResult.previousLevel,
        newLevel: progressResult.newLevel,
        leveledUp: progressResult.leveledUp,
        updatedStats: progressResult.stats
      };
    }

    const ranking = playersArr
      .map((p) => ({
        username: p.username,
        skinColor: p.skinColor,
        teamId: p.teamId,
        roundWins: p.roundWins || 0,
        kills: p.totalKills || 0,
        shovesCount: p.totalShoves || 0,
        alive: p.alive
      }))
      .sort(
        (a, b) =>
          b.roundWins - a.roundWins ||
          b.kills - a.kills ||
          b.shovesCount - a.shovesCount
      );

    if (room.mode === 'PRIVATE') {
      room.status = 'WAITING';
      room.roundPhase = 'IDLE';
      for (const p of room.players.values()) {
        p.isReady = Boolean(p.isBot || p.socketId === room.hostId);
      }
      this.syncConfiguredBots(room);
    } else {
      room.status = 'FINISHED';
    }

    this.io.to(room.id).emit('match:ended', {
      roomId: room.id,
      ...resultSummary,
      ranking,
      xpReportBySocket,
      room: this.serializeRoom(room)
    });

    if (room.mode === 'BATTLEROYALE') {
      for (const p of room.players.values()) {
        if (!p.isBot) {
          const s = this.io.sockets.sockets.get(p.socketId);
          if (s) {
            s.leave(room.id);
            s.currentRoomId = null;
          }
        }
      }
      this.rooms.delete(room.id);
    } else {
      this.broadcastRoomState(room.id);
    }

    this.broadcastPublicRoomsList();
    this.broadcastFriendsPresence();
  }

  clearRoomTimers(room) {
    if (room.countdownTimer) {
      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
    }
    if (room.matchLoop) {
      clearInterval(room.matchLoop);
      room.matchLoop = null;
    }
    if (room.introTimeout) {
      clearTimeout(room.introTimeout);
      room.introTimeout = null;
    }
    if (room.preRoundInterval) {
      clearInterval(room.preRoundInterval);
      room.preRoundInterval = null;
    }
    if (room.nextRoundTimeout) {
      clearTimeout(room.nextRoundTimeout);
      room.nextRoundTimeout = null;
    }
  }

  serializeRoom(room) {
    if (!room) return null;
    const availableTeams = this.getAvailableTeamsForSize(room.teamSize);
    const allRealReady = this.areAllRealPlayersReady(room);

    return {
      id: room.id,
      mode: room.mode,
      hostId: room.hostId,
      hostName: room.hostName,
      maxPlayers: room.maxPlayers,
      teamSize: room.teamSize,
      friendlyFire: Boolean(room.friendlyFire),
      isOpenJoin: Boolean(room.isOpenJoin),
      totalRounds: room.totalRounds || DEFAULT_TOTAL_ROUNDS,
      currentRound: room.currentRound || 1,
      selectedMapIds: room.selectedMapIds || this.mapsList.map((m) => m.id),
      allMapsCatalog: this.mapsList.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description
      })),
      playerSpeedMultiplier: room.playerSpeedMultiplier || 1.0,
      powerupsEnabled: room.powerupsEnabled !== false,
      powerupSpawnInterval: room.powerupSpawnInterval || DEFAULT_POWERUP_SPAWN_SEC,
      matchDuration: room.matchDuration || DEFAULT_MATCH_DURATION_SEC,
      botCount: room.botCount || 0,
      allRealReady,
      status: room.status,
      countdown: room.countdown,
      minRealPlayers: room.minRealPlayers || this.BR_MIN_REAL_PLAYERS,
      selectedMap: room.selectedMap,
      availableTeams,
      joinRequests: room.joinRequests
        ? Array.from(room.joinRequests.values()).map((r) => ({
            socketId: r.socketId,
            username: r.username,
            skinColor: r.skinColor
          }))
        : [],
      players: Array.from(room.players.values()).map((p) => {
        const teamMeta = availableTeams.find((t) => t.id === p.teamId) || null;
        return {
          socketId: p.socketId,
          userId: p.userId,
          username: p.username,
          skinColor: p.skinColor,
          stats: p.stats || null,
          teamId: p.teamId,
          teamName: teamMeta ? teamMeta.name : null,
          teamIcon: teamMeta ? teamMeta.icon : null,
          teamColor: teamMeta ? teamMeta.color : null,
          isBot: Boolean(p.isBot),
          isReady: Boolean(p.isReady || p.socketId === room.hostId)
        };
      })
    };
  }

  broadcastRoomState(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.io.to(roomId).emit('room:update', this.serializeRoom(room));
  }
}

module.exports = RoomManager;