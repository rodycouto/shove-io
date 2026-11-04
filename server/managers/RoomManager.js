// server/managers/RoomManager.js
// ============================================================================
// Gerenciador Central de Salas, Lista Pública, Aprovação de Entrada, Expulsão,
// Múltiplos Rounds, Seleção de Mapas (incluindo Circo Saltitante com 5 Trampolins),
// Novo Power-up Luva de Boxe (Nocaute de 2s no chão + Vulnerabilidade),
// Física Autoritativa (30Hz com volatile.emit + vetores vx/vy/vz para predição)
// e Nível (level) de cada personagem ao lado do nome.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const ENV = require('../config/env');
const authRoutes = require('../routes/authRoutes');
const { cacheRoomInRedis, deleteRoomFromRedis } = require('../config/redis');

// Catálogo de times utilizando identificadores de ícones do Lucide (sem emojis)
const TEAMS_CATALOG = [
  { id: 1, name: 'Time Azul', icon: 'shield', color: '#00E5FF' },
  { id: 2, name: 'Time Vermelho', icon: 'flame', color: '#FF3366' },
  { id: 3, name: 'Time Amarelo', icon: 'zap', color: '#FFD600' },
  { id: 4, name: 'Time Verde', icon: 'award', color: '#00E676' },
  { id: 5, name: 'Time Roxo', icon: 'sparkles', color: '#AA00FF' },
  { id: 6, name: 'Time Laranja', icon: 'swords', color: '#FF6D00' },
  { id: 7, name: 'Time Rosa', icon: 'star', color: '#FF80AB' },
  { id: 8, name: 'Time Turquesa', icon: 'trophy', color: '#1DE9B6' }
];

// Catálogo dos 5 Power-ups (incluindo o novo BOXING_GLOVE - Luva de Boxe)
const POWERUP_TYPES = [
  { type: 'INVISIBLE', name: 'Invisível (5s)', icon: 'ghost', color: '#00E5FF' },
  { type: 'MEGA_SHOVE', name: 'Mega Shove (4x)', icon: 'flame', color: '#FF3366' },
  { type: 'HEAVYWEIGHT', name: 'Peso Pesado (5s)', icon: 'shield', color: '#FFD600' },
  { type: 'SHOCK', name: 'Arma de Shock (3s)', icon: 'zap', color: '#AA00FF' },
  { type: 'BOXING_GLOVE', name: 'Luva de Boxe (KO 2s)', icon: 'hand', color: '#FF1744' }
];

const BOT_NAMES = [
  'RoboShove', 'Pinguim3D', 'TrovãoAzul', 'MegaFeijão', 'AstroBot',
  'DinoPulo', 'PipocaCósmica', 'BolaDeFogo', 'Gelinho', 'TurboKids',
  'CapitãoEmpurra', 'ZigueZague', 'CometaFeliz', 'SuperBumper', 'NinjaFofo'
];

const BOT_COLORS = ['#FF3366', '#00E5FF', '#FFD600', '#00E676', '#AA00FF', '#FF6D00'];

// Constantes padrão de Gameplay
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
const BOXING_KO_DURATION_MS = 2000; // 2 segundos deitado no chão vulnerável
const MAX_NORMAL_SHOVE_FORCE = 26;

// Arredondamento matemático rápido (sem alocar strings com .toFixed(2) no Garbage Collector)
function round2(val) {
  return Math.round((Number(val) || 0) * 100) / 100;
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();

    this.MAX_PLAYERS = Math.min(15, ENV.MAX_PLAYERS_PER_ROOM || 15);
    this.TICK_RATE = ENV.SERVER_TICK_RATE || 30;
    this.BR_MIN_REAL_PLAYERS = ENV.BR_MIN_REAL_PLAYERS || 5;
    this.BR_WAIT_TIME_SECONDS = ENV.BR_WAIT_TIME_SECONDS || 60;

    this.mapsList = this.loadMapsFromJson();
    this.publicRoomsBroadcastTimer = null;
  }

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
          pillars: [],
          trampolines: []
        }
      }
    ];
  }

  pickMapForRound(room) {
    const allowedIds =
      Array.isArray(room?.selectedMapIds) && room.selectedMapIds.length > 0
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
    return typeof structuredClone === 'function'
      ? structuredClone(chosen)
      : JSON.parse(JSON.stringify(chosen));
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

    const usedNames = new Set();
    for (const p of room.players.values()) {
      usedNames.add(p.username);
    }

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
        username: botName,
        skinColor,
        level: 1,
        stats: { level: 1, xp: 0, wins: 0, matches: 0, shoves: 0, kills: 0 },
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
      selectedPowerupIds: POWERUP_TYPES.map((p) => p.type),
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
      powerups: new Map(),
      chatHistory: [],
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
          hostLevel: hostPlayer ? hostPlayer.level || 1 : 1,
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
    if (this.publicRoomsBroadcastTimer) return;
    this.publicRoomsBroadcastTimer = setTimeout(() => {
      this.publicRoomsBroadcastTimer = null;
      this.io.to('lobby').emit('rooms:list', this.getPublicRoomsList());
    }, 80);
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
      room.selectedMapIds = configData.selectedMapIds.filter((id) => validIds.includes(id));
    }

    if (Array.isArray(configData.selectedPowerupIds)) {
      const validPowerupIds = POWERUP_TYPES.map((p) => p.type);
      room.selectedPowerupIds = configData.selectedPowerupIds.filter((id) =>
        validPowerupIds.includes(id)
      );
      room.powerupsEnabled = room.selectedPowerupIds.length > 0;
    }

    if (configData.playerSpeedMultiplier !== undefined) {
      const spd = Number(configData.playerSpeedMultiplier);
      if (!Number.isNaN(spd)) {
        room.playerSpeedMultiplier = Math.max(0.6, Math.min(2.0, Number(spd.toFixed(2))));
      }
    }

    if (configData.powerupsEnabled !== undefined && !Array.isArray(configData.selectedPowerupIds)) {
      room.powerupsEnabled = Boolean(configData.powerupsEnabled);
      if (
        room.powerupsEnabled &&
        (!Array.isArray(room.selectedPowerupIds) || room.selectedPowerupIds.length === 0)
      ) {
        room.selectedPowerupIds = POWERUP_TYPES.map((p) => p.type);
      } else if (!room.powerupsEnabled) {
        room.selectedPowerupIds = [];
      }
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
      targetSocket.join('lobby');
      targetSocket.currentRoomId = null;
      targetSocket.emit('room:kicked', {
        roomId: cleanId,
        reason: 'Você foi removido da sala pelo criador.'
      });
    }

    this.broadcastRoomState(cleanId);
    this.broadcastPublicRoomsList();
    return { room: this.serializeRoom(room) };
  }

  requestOrJoinRoom(socket, roomId, playerProfile) {
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

    if (socket.currentRoomId && socket.currentRoomId !== cleanId) {
      return { error: 'Você já está em uma sala! Saia da sala atual antes de entrar em outra.' };
    }

    const realCount = this.countRealPlayers(room);
    if (realCount >= room.maxPlayers) {
      return { error: `Esta sala já atingiu o limite máximo de ${room.maxPlayers} usuários!` };
    }

    if (room.isOpenJoin || room.hostId === socket.id) {
      return this.addPlayerDirectlyToRoom(socket, room, playerProfile);
    }

    const safeProfile = playerProfile || {};
    const normStats = authRoutes.normalizeStats(safeProfile.stats || {});
    room.joinRequests.set(socket.id, {
      socketId: socket.id,
      userId: safeProfile.id || `user_${socket.id}`,
      username: (safeProfile.username || 'Jogador').substring(0, 15),
      skinColor: safeProfile.skinColor || '#00E5FF',
      level: normStats.level,
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
    const normStats = authRoutes.normalizeStats(safeProfile.stats || {});
    const teamId = room.teamSize > 1 ? this.findAvailableTeamId(room) : null;
    const isHostPlayer = room.hostId === socket.id;

    const playerObj = {
      socketId: socket.id,
      userId: safeProfile.id || `user_${socket.id}`,
      username: (safeProfile.username || 'Jogador').substring(0, 15),
      skinColor: safeProfile.skinColor || '#FF3366',
      level: normStats.level,
      stats: normStats,
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
        powerups: new Map(),
        chatHistory: [],
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
          clientSocket.join('lobby');
          clientSocket.currentRoomId = null;
        }
      }
    }

    this.clearRoomTimers(room);
    this.rooms.delete(room.id);
    deleteRoomFromRedis(room.id);
    this.broadcastPublicRoomsList();
  }

  fillRoomWithBots(room) {
    const slotsAvailable = this.MAX_PLAYERS - room.players.size;
    if (slotsAvailable <= 0) return;

    const usedNames = new Set();
    for (const p of room.players.values()) {
      usedNames.add(p.username);
    }

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
        username: botName,
        skinColor,
        level: 1,
        stats: { level: 1, xp: 0, wins: 0, matches: 0, shoves: 0, kills: 0 },
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
    if (!roomId || !this.rooms.has(roomId)) {
      socket.join('lobby');
      return;
    }

    const room = this.rooms.get(roomId);
    const leavingPlayer = room.players.get(socket.id);
    if (leavingPlayer) {
      this.releaseAnyGrabLinks(room, leavingPlayer);
    }

    room.players.delete(socket.id);
    socket.leave(roomId);
    socket.join('lobby');
    socket.currentRoomId = null;

    const remainingRealPlayers = this.countRealPlayers(room);

    if (remainingRealPlayers === 0) {
      this.clearRoomTimers(room);
      this.rooms.delete(roomId);
      deleteRoomFromRedis(roomId);
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

  launchMatch(room) {
    this.clearRoomTimers(room);
    room.status = 'PLAYING';
    room.currentRound = 1;
    room.totalRounds = Math.max(
      1,
      Math.min(MAX_TOTAL_ROUNDS, Number(room.totalRounds) || DEFAULT_TOTAL_ROUNDS)
    );
    room.lastPlayedMapId = null;
    room.teamRoundWins = new Map();

    for (const p of room.players.values()) {
      p.roundWins = 0;
      p.totalKills = 0;
      p.totalShoves = 0;
      if (!p.isBot) {
        const s = this.io.sockets.sockets.get(p.socketId);
        if (s) s.leave('lobby');
      }
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

    const spawnRadius =
      mapPhysics.innerHoleRadius > 0
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
      p.knockedOutUntil = 0;
      p.hasMegaShove = false;
      p.hasShockWeapon = false;
      p.hasBoxingGlove = false;
      p.lastTrampolineJumpAt = 0;

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

    let lastTickPerf = performance.now();
    room.matchLoop = setInterval(() => {
      const nowPerf = performance.now();
      const realDt = Math.min(0.1, Math.max(0.005, (nowPerf - lastTickPerf) / 1000));
      lastTickPerf = nowPerf;
      this.updateMatchPhysics(room, realDt);
    }, Math.round(1000 / this.TICK_RATE));

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
    const isIncapacitated =
      now < player.stunnedUntil || now < player.shockedUntil || now < player.knockedOutUntil;

    if (player.grabbedById || isIncapacitated) {
      player.inputX = 0;
      player.inputZ = 0;
      return;
    }

    let mx = Number(inputData?.moveX) || 0;
    let mz = Number(inputData?.moveZ) || 0;
    const lenSq = mx * mx + mz * mz;
    if (lenSq > 1) {
      const len = Math.sqrt(lenSq);
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
    if (now < player.shockedUntil || now < player.stunnedUntil || now < player.knockedOutUntil) {
      return;
    }

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
    if (
      now < attacker.stunnedUntil ||
      now < attacker.shockedUntil ||
      now < attacker.knockedOutUntil
    ) {
      return;
    }

    if (attacker.invisibleUntil > now) {
      attacker.invisibleUntil = 0;
    }

    const GRAB_RANGE_SQ = 2.35 * 2.35;
    let nearestTarget = null;
    let minDistSq = Infinity;

    for (const target of room.players.values()) {
      if (target.socketId === attacker.socketId || !target.alive) continue;
      if (target.grabbedById || target.grabbedTargetId) continue;
      if (this.isProtectedTeammate(room, attacker, target)) continue;
      if (target.invisibleUntil > now) continue;
      if (target.heavyUntil > now) continue;

      const dx = target.x - attacker.x;
      const dz = target.z - attacker.z;
      const distSq = dx * dx + dz * dz;
      if (distSq <= GRAB_RANGE_SQ && distSq < minDistSq) {
        minDistSq = distSq;
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

    const now = Date.now();
    // Alvo eletrocutado ou nocauteado pela Luva de Boxe fica mais vulnerável!
    const vulnMult =
      now < target.knockedOutUntil ? 1.45 : now < target.shockedUntil ? 1.35 : 1.0;
    const throwForce = (15 + power * 27) * vulnMult;

    target.x = attacker.x + dirX * 1.1;
    target.z = attacker.z + dirZ * 1.1;
    target.y = Math.max(0.5, attacker.y + 1.4);
    target.vx = dirX * throwForce;
    target.vz = dirZ * throwForce;
    const isLowGravThrow = Boolean(room.selectedMap?.physics?.lowGravity);
    target.vy = (5.0 + power * 4.5) * (isLowGravThrow ? 1.4 : 1.0);

    target.lastShovedBy = attacker.socketId;
    target.lastShovedAt = now;
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

  /**
   * Dispara o soco da Luva de Boxe: nocauteia o oponente deixando-o deitado no
   * chão por 2 segundos (BOXING_KO_DURATION_MS = 2000) e vulnerável aos inimigos!
   */
  fireBoxingGlove(room, attacker, now) {
    const PUNCH_RANGE_SQ = 3.25 * 3.25;
    let bestTarget = null;
    let minDistSq = Infinity;

    for (const target of room.players.values()) {
      if (target.socketId === attacker.socketId || !target.alive) continue;
      if (this.isProtectedTeammate(room, attacker, target)) continue;
      if (target.invisibleUntil > now) continue;

      const dx = target.x - attacker.x;
      const dz = target.z - attacker.z;
      const distSq = dx * dx + dz * dz;
      if (distSq <= PUNCH_RANGE_SQ && distSq < minDistSq) {
        minDistSq = distSq;
        bestTarget = target;
      }
    }

    if (!bestTarget) return false;

    const dx = bestTarget.x - attacker.x;
    const dz = bestTarget.z - attacker.z;
    const dist = Math.sqrt(minDistSq) || 1;
    const nx = dx / dist;
    const nz = dz / dist;

    this.releaseAnyGrabLinks(room, bestTarget);
    bestTarget.charging = false;
    bestTarget.chargePower = 0;
    bestTarget.grabCharging = false;
    bestTarget.grabChargePower = 0;
    bestTarget.knockedOutUntil = now + BOXING_KO_DURATION_MS;

    // Impacto curto que derruba o oponente no chão
    bestTarget.vx = nx * 8.5;
    bestTarget.vz = nz * 8.5;
    bestTarget.vy = 2.2;
    bestTarget.lastShovedBy = attacker.socketId;
    bestTarget.lastShovedAt = now;

    attacker.shovesCount = (attacker.shovesCount || 0) + 1;
    attacker.totalShoves = (attacker.totalShoves || 0) + 1;

    this.io.to(room.id).emit('match:knockout_fx', {
      attackerId: attacker.socketId,
      attackerName: attacker.username,
      targetId: bestTarget.socketId,
      targetName: bestTarget.username,
      x: bestTarget.x,
      z: bestTarget.z,
      durationMs: BOXING_KO_DURATION_MS
    });

    return true;
  }

  executeShove(room, attacker, normalizedPower = 0.6) {
    if (room.combatLocked) return;
    if (!attacker || !attacker.alive || attacker.grabbedById) return;

    const now = Date.now();
    if (
      now < attacker.stunnedUntil ||
      now < attacker.shockedUntil ||
      now < attacker.knockedOutUntil
    ) {
      return;
    }

    if (attacker.grabbedTargetId) {
      this.throwGrabbedTarget(room, attacker);
      return;
    }

    if (attacker.invisibleUntil > now) {
      attacker.invisibleUntil = 0;
    }

    // Prioridade 1: Luva de Boxe (soco nocauteador de 2s no chão)
    if (attacker.hasBoxingGlove) {
      const knockedSomeone = this.fireBoxingGlove(room, attacker, now);
      if (knockedSomeone) {
        attacker.hasBoxingGlove = false;
        return;
      }
    }

    // Prioridade 2: Arma de Shock
    if (attacker.hasShockWeapon) {
      const shockedSomeone = this.fireShockWeapon(room, attacker, now);
      if (shockedSomeone) {
        attacker.hasShockWeapon = false;
        return;
      }
    }

    const isMega = Boolean(attacker.hasMegaShove);
    const SHOVE_RANGE = isMega ? 3.4 : 2.75;
    const SHOVE_RANGE_SQ = SHOVE_RANGE * SHOVE_RANGE;

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
      const distSq = dx * dx + dz * dz;

      if (distSq <= SHOVE_RANGE_SQ && distSq > 0.000001) {
        const dist = Math.sqrt(distSq);
        const nx = dx / dist;
        const nz = dz / dist;

        // Oponente deitado no chão (nocauteado pela Luva de Boxe) fica 45% mais vulnerável!
        const vulnMult =
          now < target.knockedOutUntil ? 1.45 : now < target.shockedUntil ? 1.35 : 1.0;

        if (target.grabbedTargetId) {
          this.releaseAnyGrabLinks(room, target);
        }

        target.vx += nx * baseForce * vulnMult;
        target.vz += nz * baseForce * vulnMult;
        const isLowGrav = Boolean(room.selectedMap?.physics?.lowGravity);
        const baseVy = isMega ? 9.5 : 4.4 + normalizedPower * 2.6;
        target.vy = isLowGrav ? baseVy * 1.45 : baseVy;

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
    const SHOCK_RANGE_SQ = 5.2 * 5.2;
    let bestTarget = null;
    let minDistSq = Infinity;

    for (const target of room.players.values()) {
      if (target.socketId === attacker.socketId || !target.alive) continue;
      if (this.isProtectedTeammate(room, attacker, target)) continue;
      if (target.invisibleUntil > now) continue;

      const dx = target.x - attacker.x;
      const dz = target.z - attacker.z;
      const distSq = dx * dx + dz * dz;
      if (distSq <= SHOCK_RANGE_SQ && distSq < minDistSq) {
        minDistSq = distSq;
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
    const minR = mapPhysics.innerHoleRadius > 0 ? mapPhysics.innerHoleRadius + 1.4 : 1.8;
    const maxR = Math.max(minR + 0.5, room.currentArenaRadius - 1.8);

    const angle = Math.random() * Math.PI * 2;
    const r = minR + Math.random() * (maxR - minR);
    let x = Math.cos(angle) * r;
    let z = Math.sin(angle) * r;

    if (Array.isArray(mapPhysics.pillars)) {
      for (const pil of mapPhysics.pillars) {
        const dx = x - pil.x;
        const dz = z - pil.z;
        const safeR = pil.radius + 1.2;
        if (dx * dx + dz * dz < safeR * safeR) {
          x = 0;
          z = 0;
        }
      }
    }

    const allowedPowerups = Array.isArray(room.selectedPowerupIds)
      ? POWERUP_TYPES.filter((p) => room.selectedPowerupIds.includes(p.type))
      : POWERUP_TYPES;
    if (allowedPowerups.length === 0) return;

    const template = allowedPowerups[Math.floor(Math.random() * allowedPowerups.length)];
    const id = `pwr_${room.nextPowerupId++}`;

    const powerup = {
      id,
      type: template.type,
      name: template.name,
      icon: template.icon,
      color: template.color,
      x: round2(x),
      y: 9.0,
      z: round2(z)
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
      case 'BOXING_GLOVE':
        player.hasBoxingGlove = true;
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

    let aliveCount = 0;
    for (let i = 0; i < playersArr.length; i++) {
      if (playersArr[i].alive) aliveCount++;
    }

    const totalMatchDur = Math.max(30, Number(room.matchDuration) || DEFAULT_MATCH_DURATION_SEC);

    if (!room.combatLocked) {
      const elapsedSec = Math.max(0, (now - room.matchStartTime) / 1000);
      room.matchTimeRemaining = Math.max(0, totalMatchDur - elapsedSec);

      const fallenPlayers = Math.max(0, (room.initialPlayerCount || playersArr.length) - aliveCount);
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

      if (room.powerupsEnabled !== false && (!Array.isArray(room.selectedPowerupIds) || room.selectedPowerupIds.length > 0)) {
        room.powerupTimerSec -= dt;
        if (room.powerupTimerSec <= 0) {
          room.powerupTimerSec = Math.max(
            5,
            Number(room.powerupSpawnInterval) || DEFAULT_POWERUP_SPAWN_SEC
          );
          if (room.powerups.size < 4) {
            this.spawnRandomPowerup(room);
          }
        }

        const PICKUP_RADIUS_SQ = 1.35 * 1.35;
        for (const [pwrId, pwr] of room.powerups.entries()) {
          if (pwr.y > 0.65) {
            pwr.y = Math.max(0.65, round2(pwr.y - 12.0 * dt));
          }
          if (pwr.y <= 1.5) {
            for (let i = 0; i < playersArr.length; i++) {
              const p = playersArr[i];
              if (!p.alive || p.grabbedById || p.y < -0.2) continue;
              const dx = p.x - pwr.x;
              const dz = p.z - pwr.z;
              if (dx * dx + dz * dz < PICKUP_RADIUS_SQ) {
                this.applyPowerupToPlayer(room, p, pwr);
                room.powerups.delete(pwrId);
                break;
              }
            }
          }
        }
      }
    }

    const innerHoleBoundary =
      mapPhysics.innerHoleRadius > 0 ? Math.max(0, mapPhysics.innerHoleRadius - 0.35) : 0;
    const innerHoleBoundarySq = innerHoleBoundary * innerHoleBoundary;
    const outerBoundary = room.currentArenaRadius + 0.35;
    const outerBoundarySq = outerBoundary * outerBoundary;

    for (let i = 0; i < playersArr.length; i++) {
      const p = playersArr[i];
      if (!p.alive) continue;

      if (p.grabbedById) {
        const captor = room.players.get(p.grabbedById);
        if (
          !captor ||
          !captor.alive ||
          now < captor.stunnedUntil ||
          now < captor.shockedUntil ||
          now < captor.knockedOutUntil
        ) {
          this.releaseAnyGrabLinks(room, p);
        } else {
          p.x = captor.x + Math.sin(captor.rotationY) * 0.35;
          p.z = captor.z + Math.cos(captor.rotationY) * 0.35;
          p.y = captor.y + 2.15;
          p.rotationY = captor.rotationY;

          if (p.isBot && now >= p.shockedUntil && now >= p.knockedOutUntil && !room.combatLocked) {
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

      const isIncapacitated =
        now < p.stunnedUntil || now < p.shockedUntil || now < p.knockedOutUntil;
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

      const distFromCenterSq = p.x * p.x + p.z * p.z;
      const fellInCenterHole =
        mapPhysics.innerHoleRadius > 0 && distFromCenterSq < innerHoleBoundarySq;
      const fellOutside = distFromCenterSq > outerBoundarySq;

      const onPlatform = p.y >= -0.2 && !fellInCenterHole && !fellOutside;

      if (onPlatform) {
        const actionSlowdown = p.charging || p.grabbedTargetId ? 0.75 : 1.0;
        const airControlMult = p.y > 0.35 ? 1.15 : 1.0;
        const baseSpeed = mapPhysics.moveSpeed || 18.5;
        const accel = baseSpeed * room.speedMultiplier * actionSlowdown * airControlMult;

        p.vx += p.inputX * accel * dt;
        p.vz += p.inputZ * accel * dt;

        if (p.inputX * p.inputX + p.inputZ * p.inputZ > 0.0064 && !isIncapacitated) {
          p.rotationY = Math.atan2(p.inputX, p.inputZ);
        }

        const mapGravity = Number(mapPhysics.gravity) || 21;
        // Mapa Lua Cintilante (lowGravity): saltos lunares mais altos ao se locomover na superfície
        if (
          mapPhysics.lowGravity &&
          p.y <= 0.04 &&
          p.vy <= 0.1 &&
          !isIncapacitated &&
          !room.combatLocked &&
          p.inputX * p.inputX + p.inputZ * p.inputZ > 0.04
        ) {
          p.vy = Number(mapPhysics.jumpForce) || 10.6;
          p.y = 0.06;
        }

        if (p.y > 0 || p.vy > 0) {
          p.vy -= mapGravity * dt;
          p.y += p.vy * dt;
          if (p.y < 0) {
            p.y = 0;
            p.vy = 0;
          }
        }

        // Física dos 5 Trampolins (Mapa: Circo Saltitante)
        if (
          Array.isArray(mapPhysics.trampolines) &&
          mapPhysics.trampolines.length > 0 &&
          p.y <= 0.45 &&
          p.vy <= 1.5 &&
          now - (p.lastTrampolineJumpAt || 0) > 320
        ) {
          for (let tIdx = 0; tIdx < mapPhysics.trampolines.length; tIdx++) {
            const tramp = mapPhysics.trampolines[tIdx];
            const dx = p.x - tramp.x;
            const dz = p.z - tramp.z;
            const r = (tramp.radius || 1.3) + 0.25;
            if (dx * dx + dz * dz <= r * r) {
              p.vy = tramp.jumpForce || 14.8;
              p.y = 0.25;
              p.lastTrampolineJumpAt = now;

              // Impulso horizontal suave na direção do movimento para fugir pelos ares
              if (p.inputX !== 0 || p.inputZ !== 0) {
                p.vx += p.inputX * 6.5;
                p.vz += p.inputZ * 6.5;
              }

              this.io.to(room.id).emit('match:trampoline_jump', {
                playerId: p.socketId,
                trampIndex: tIdx,
                x: tramp.x,
                z: tramp.z
              });
              break;
            }
          }
        }
      } else {
        const fallGrav = mapPhysics.lowGravity && p.y > -2.5 ? (Number(mapPhysics.gravity) || 9.0) * 1.35 : 26;
        p.vy -= fallGrav * dt;
        p.y += p.vy * dt;
      }

      const baseFriction = mapPhysics.friction || 0.88;
      const frictionFactor = Math.pow(baseFriction, dt * 30);
      p.vx *= frictionFactor;
      p.vz *= frictionFactor;

      p.x += p.vx * dt;
      p.z += p.vz * dt;

      if (Array.isArray(mapPhysics.pillars) && p.y >= -0.2 && p.y <= 2.8) {
        for (let k = 0; k < mapPhysics.pillars.length; k++) {
          const pillar = mapPhysics.pillars[k];
          const dx = p.x - pillar.x;
          const dz = p.z - pillar.z;
          const minDist = (pillar.radius || 1.1) + 0.65;
          const distSq = dx * dx + dz * dz;
          if (distSq < minDist * minDist && distSq > 0.000001) {
            const dist = Math.sqrt(distSq);
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

    const PLAYER_MIN_DIST = 1.3;
    const PLAYER_MIN_DIST_SQ = PLAYER_MIN_DIST * PLAYER_MIN_DIST;

    for (let i = 0; i < playersArr.length; i++) {
      const p1 = playersArr[i];
      if (!p1.alive || p1.y < -0.5 || p1.grabbedById || p1.invisibleUntil > now) continue;

      for (let j = i + 1; j < playersArr.length; j++) {
        const p2 = playersArr[j];
        if (!p2.alive || p2.y < -0.5 || p2.grabbedById || p2.invisibleUntil > now) continue;
        // Se um estiver pulando alto no trampolim e o outro no chão, não colide no ar
        if (Math.abs(p1.y - p2.y) > 1.7) continue;

        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const distSq = dx * dx + dz * dz;

        if (distSq < PLAYER_MIN_DIST_SQ && distSq > 0.000001) {
          const dist = Math.sqrt(distSq);
          const nx = dx / dist;
          const nz = dz / dist;
          const overlap = (PLAYER_MIN_DIST - dist) * 0.5;

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

    // Serialização enxuta (Sparse Payload) sem alocações de string (.toFixed):
    // Reduz o tamanho do pacote WebSocket em ~60% omitindo flags falsas/nulas!
    const serializedPlayers = new Array(playersArr.length);
    for (let i = 0; i < playersArr.length; i++) {
      const p = playersArr[i];
      if (!p.alive && p.y <= -10.8) {
        serializedPlayers[i] = { id: p.socketId, y: -12, alive: false };
        continue;
      }

      const item = {
        id: p.socketId,
        x: round2(p.x),
        y: round2(p.y),
        z: round2(p.z),
        vx: round2(p.vx),
        vy: round2(p.vy),
        vz: round2(p.vz),
        ry: round2(p.rotationY),
        alive: p.alive
      };

      const chargeVal = round2(Math.max(p.chargePower || 0, p.grabChargePower || 0));
      if (chargeVal > 0) item.charge = chargeVal;
      if (p.grabbedById) {
        item.grabbedById = p.grabbedById;
        if (p.escapePresses) item.escapePresses = p.escapePresses;
      }
      if (p.grabbedTargetId) item.grabbedTargetId = p.grabbedTargetId;
      if (now < p.stunnedUntil) item.stunned = true;
      if (now < p.invisibleUntil) item.invisible = true;
      if (now < p.heavyUntil) item.heavy = true;
      if (now < p.shockedUntil) item.shocked = true;
      if (now < p.knockedOutUntil) item.knockedOut = true;
      if (p.hasMegaShove) item.hasMegaShove = true;
      if (p.hasShockWeapon) item.hasShockWeapon = true;
      if (p.hasBoxingGlove) item.hasBoxingGlove = true;

      serializedPlayers[i] = item;
    }

    const pwrEnabled =
      room.powerupsEnabled !== false &&
      (!Array.isArray(room.selectedPowerupIds) || room.selectedPowerupIds.length > 0);

    this.io.to(room.id).volatile.emit('match:state', {
      arenaRadius: round2(room.currentArenaRadius),
      currentRound: room.currentRound,
      totalRounds: room.totalRounds,
      combatLocked: Boolean(room.combatLocked),
      timeRemaining: Math.ceil(room.matchTimeRemaining),
      powerupsEnabled: pwrEnabled,
      nextPowerupIn: pwrEnabled ? Math.max(1, Math.ceil(room.powerupTimerSec)) : null,
      powerups: room.powerups.size > 0 ? Array.from(room.powerups.values()) : [],
      players: serializedPlayers
    });

    if (!room.combatLocked) {
      this.checkRoundEndCondition(room, playersArr);
    }
  }

  updateBotAI(room, bot, playersArr, dt, now) {
    if (
      now < bot.stunnedUntil ||
      now < bot.shockedUntil ||
      now < bot.knockedOutUntil
    ) {
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
    let minDistSq = Infinity;

    if (
      bot.cachedTargetId &&
      now - (bot.lastTargetScanAt || 0) < 95
    ) {
      const cached = room.players.get(bot.cachedTargetId);
      if (
        cached &&
        cached.alive &&
        cached.y >= -0.2 &&
        cached.invisibleUntil <= now &&
        !this.isProtectedTeammate(room, bot, cached)
      ) {
        const dx = cached.x - bot.x;
        const dz = cached.z - bot.z;
        minDistSq = dx * dx + dz * dz;
        nearestTarget = cached;
      }
    }

    if (!nearestTarget) {
      bot.lastTargetScanAt = now;
      for (let i = 0; i < playersArr.length; i++) {
        const other = playersArr[i];
        if (other.socketId === bot.socketId || !other.alive || other.y < -0.2) continue;
        if (this.isProtectedTeammate(room, bot, other)) continue;
        if (other.invisibleUntil > now) continue;

        const dx = other.x - bot.x;
        const dz = other.z - bot.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < minDistSq) {
          minDistSq = dSq;
          nearestTarget = other;
        }
      }
      bot.cachedTargetId = nearestTarget ? nearestTarget.socketId : null;
    }

    const minDist = minDistSq < Infinity ? Math.sqrt(minDistSq) : Infinity;

    let targetX = nearestTarget ? nearestTarget.x : 0;
    let targetZ = nearestTarget ? nearestTarget.z : 0;
    for (const pwr of room.powerups.values()) {
      if (pwr.y <= 1.2) {
        const dx = pwr.x - bot.x;
        const dz = pwr.z - bot.z;
        const dpSq = dx * dx + dz * dz;
        if (dpSq < 20.25 && dpSq < minDistSq) {
          targetX = pwr.x;
          targetZ = pwr.z;
          break;
        }
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

    const normSq = moveX * moveX + moveZ * moveZ;
    if (normSq > 1) {
      const norm = Math.sqrt(normSq);
      moveX /= norm;
      moveZ /= norm;
    }

    bot.inputX = moveX;
    bot.inputZ = moveZ;

    bot.botCooldown -= dt;
    if (nearestTarget && minDist < 3.2 && bot.botCooldown <= 0) {
      if (bot.hasBoxingGlove && minDist < 3.1) {
        this.executeShove(room, bot, 0.8);
        bot.botCooldown = 1.0;
      } else if (bot.hasShockWeapon && minDist < 4.5) {
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
          roundWinnerName: teamMeta ? teamMeta.name : 'Empate'
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
    const winningSocketIds = new Set();

    if (room.teamSize <= 1) {
      const sorted = [...playersArr].sort(
        (a, b) =>
          (b.roundWins || 0) - (a.roundWins || 0) ||
          (b.totalKills || 0) - (a.totalKills || 0) ||
          (b.totalShoves || 0) - (a.totalShoves || 0)
      );
      const champion = sorted[0];
      if (champion) winningSocketIds.add(champion.socketId);
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
      for (const p of playersArr) {
        if (p.teamId === bestTeamId) winningSocketIds.add(p.socketId);
      }
    }

    // Atualiza XP e Nível de todos os jogadores reais em paralelo ANTES de montar
    // winnersList e losersList para que o nível exibido na tela de vitória esteja atualizado!
    const xpReportBySocket = {};
    const realPlayers = playersArr.filter((p) => !p.isBot);

    await Promise.all(
      realPlayers.map(async (p) => {
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
        p.level = progressResult.newLevel || progressResult.stats?.level || 1;

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
      })
    );

    const winnersList = playersArr
      .filter((p) => winningSocketIds.has(p.socketId))
      .map((p) => ({
        id: p.socketId,
        username: p.username,
        skinColor: p.skinColor,
        level: p.stats?.level || p.level || 1,
        teamId: p.teamId
      }));

    const losersList = playersArr
      .filter((p) => !winningSocketIds.has(p.socketId))
      .map((p) => ({
        id: p.socketId,
        username: p.username,
        skinColor: p.skinColor,
        level: p.stats?.level || p.level || 1,
        teamId: p.teamId
      }));

    let resultSummary = null;
    if (room.teamSize <= 1) {
      const champion = winnersList[0];
      resultSummary = {
        winnerType: 'SOLO',
        winnerName: champion ? `${champion.username} (Nv. ${champion.level})` : 'Empate!',
        winnerColor: champion ? champion.skinColor : '#FFD600',
        winnerTeam: null,
        winnersList,
        losersList
      };
    } else {
      const winnerSample = winnersList[0];
      const teamMeta =
        TEAMS_CATALOG.find((t) => t.id === winnerSample?.teamId) || TEAMS_CATALOG[0];
      resultSummary = {
        winnerType: 'TEAM',
        winnerName: teamMeta ? teamMeta.name : 'Empate!',
        winnerColor: teamMeta ? teamMeta.color : '#00E5FF',
        winnerTeam: teamMeta || null,
        winnersList,
        losersList
      };
    }

    const ranking = playersArr
      .map((p) => ({
        username: p.username,
        skinColor: p.skinColor,
        level: p.stats?.level || p.level || 1,
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

    for (const p of realPlayers) {
      const s = this.io.sockets.sockets.get(p.socketId);
      if (s) s.join('lobby');
    }

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
      for (const p of realPlayers) {
        const s = this.io.sockets.sockets.get(p.socketId);
        if (s) {
          s.leave(room.id);
          s.currentRoomId = null;
        }
      }
      this.rooms.delete(room.id);
    deleteRoomFromRedis(room.id);
    } else {
      this.broadcastRoomState(room.id);
    }

    this.broadcastPublicRoomsList();
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
      selectedMapIds: Array.isArray(room.selectedMapIds)
        ? room.selectedMapIds
        : this.mapsList.map((m) => m.id),
      selectedPowerupIds: Array.isArray(room.selectedPowerupIds)
        ? room.selectedPowerupIds
        : POWERUP_TYPES.map((p) => p.type),
      allMapsCatalog: this.mapsList.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description
      })),
      allPowerupsCatalog: POWERUP_TYPES.map((p) => ({
        id: p.type,
        type: p.type,
        name: p.name,
        icon: p.icon,
        color: p.color
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
      chatHistory: Array.isArray(room.chatHistory) ? room.chatHistory : [],
      joinRequests: room.joinRequests
        ? Array.from(room.joinRequests.values()).map((r) => ({
            socketId: r.socketId,
            username: r.username,
            skinColor: r.skinColor,
            level: r.level || 1
          }))
        : [],
      players: Array.from(room.players.values()).map((p) => {
        const teamMeta = availableTeams.find((t) => t.id === p.teamId) || null;
        return {
          socketId: p.socketId,
          userId: p.userId,
          username: p.username,
          skinColor: p.skinColor,
          level: p.stats?.level || p.level || 1,
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

  /**
   * Processa envio de mensagem no chat da sala/partida:
   * - Histórico fica exclusivamente no cache em memória da sala (`room.chatHistory`)
   * - Morre automaticamente quando a sala é removida de `this.rooms`
   * - Limite estrito de 100 caracteres por mensagem
   * - Inclui a cor do personagem (`skinColor`) escolhida pelo jogador
   */
  handleChatMessage(socket, { text }) {
    const roomId = socket.currentRoomId;
    if (!roomId) {
      return { error: 'Você precisa estar em uma sala para usar o chat.' };
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      return { error: 'Esta sala não existe mais na memória.' };
    }

    const player = room.players.get(socket.id);
    if (!player) {
      return { error: 'Jogador não encontrado nesta sala.' };
    }

    const cleanText = String(text || '')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .substring(0, 100);

    if (!cleanText) {
      return { error: 'Digite uma mensagem válida (máx. 100 caracteres).' };
    }

    if (!Array.isArray(room.chatHistory)) {
      room.chatHistory = [];
    }

    const msgEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      senderSocketId: socket.id,
      senderUserId: player.userId || socket.userId || null,
      username: player.username || 'Jogador',
      skinColor: player.skinColor || '#00f2fe',
      text: cleanText,
      timestamp: Date.now()
    };

    room.chatHistory.push(msgEntry);
    if (room.chatHistory.length > 120) {
      room.chatHistory.shift();
    }

    this.io.to(room.id).emit('room:chat_message', {
      roomId: room.id,
      message: msgEntry
    });

    return { success: true, message: msgEntry };
  }

  /**
   * Salva no Redis APENAS os metadados da sala criada (sem dados de física da partida).
   * Tudo o que acontece dentro da partida permanece 100% na memória RAM.
   */
  syncRoomMetadataToRedis(room) {
    if (!room || !room.id) return;
    cacheRoomInRedis({
      id: room.id,
      mode: room.mode,
      hostId: room.hostId,
      hostName: room.hostName,
      maxPlayers: room.maxPlayers,
      teamSize: room.teamSize,
      friendlyFire: Boolean(room.friendlyFire),
      isOpenJoin: Boolean(room.isOpenJoin),
      totalRounds: room.totalRounds,
      selectedMapIds: room.selectedMapIds,
      selectedPowerupIds: room.selectedPowerupIds,
      playerSpeedMultiplier: room.playerSpeedMultiplier,
      powerupsEnabled: Boolean(room.powerupsEnabled),
      powerupSpawnInterval: room.powerupSpawnInterval,
      matchDuration: room.matchDuration,
      botCount: room.botCount,
      status: room.status,
      playersCount: room.players ? room.players.size : 0
    });
  }

  broadcastRoomState(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.syncRoomMetadataToRedis(room);
    this.io.to(roomId).emit('room:update', this.serializeRoom(room));
  }
}

module.exports = RoomManager;
