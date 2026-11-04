// server/routes/authRoutes.js
// ============================================================================
// Rotas de Autenticação (Registro, Login, Convidado), Persistência de
// Estatísticas (XP / Níveis) e Sistema Completo de Amigos:
// - Verifica rigorosamente no banco de dados (ou memória ativa) se o nickname
//   existe antes de enviar solicitação de amizade.
// - Envia solicitação pendente (não adiciona direto na lista de amigos).
// - Exige aprovação explícita do destinatário para virar amigo.
// - Inclui o nível (level) de cada jogador ao lado do nome na lista de amigos.
// ============================================================================

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getDbStatus } = require('../config/db');
const {
  cacheUserInRedis,
  getCachedUserFromRedis,
  getCachedUserIdByUsername
} = require('../config/redis');
const ENV = require('../config/env');

const router = express.Router();

// Armazenamento em memória controlado (LRU/TTL) para modo fallback e convidados
const memoryUsers = new Map();
const MAX_MEMORY_USERS = 1500;
const GUEST_TTL_MS = 2 * 60 * 60 * 1000;

function escapeRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pruneMemoryUsers() {
  const now = Date.now();
  for (const [key, user] of memoryUsers.entries()) {
    if (user.isGuest && now - (user.lastSeen || 0) > GUEST_TTL_MS) {
      memoryUsers.delete(key);
    }
  }
  while (memoryUsers.size > MAX_MEMORY_USERS) {
    const oldestKey = memoryUsers.keys().next().value;
    if (!oldestKey) break;
    memoryUsers.delete(oldestKey);
  }
}

function setMemoryUser(id, userObj) {
  if (memoryUsers.has(id)) {
    memoryUsers.delete(id);
  } else if (memoryUsers.size >= MAX_MEMORY_USERS) {
    pruneMemoryUsers();
  }
  userObj.lastSeen = Date.now();
  if (!Array.isArray(userObj.friends)) userObj.friends = [];
  if (!Array.isArray(userObj.friendRequests)) userObj.friendRequests = [];
  memoryUsers.set(id, userObj);
  cacheUserInRedis(userObj);
}

const cleanupTimer = setInterval(pruneMemoryUsers, 15 * 60 * 1000);
if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

function getXpForNextLevel(level = 1) {
  return Math.max(1, Number(level) || 1) * 200;
}

function normalizeStats(rawStats = {}) {
  const level = Math.max(1, Number(rawStats.level) || 1);
  const xp = Math.max(0, Number(rawStats.xp) || 0);
  return {
    wins: Math.max(0, Number(rawStats.wins) || 0),
    shoves: Math.max(0, Number(rawStats.shoves) || 0),
    kills: Math.max(0, Number(rawStats.kills) || 0),
    matches: Math.max(0, Number(rawStats.matches) || 0),
    xp,
    level,
    xpToNextLevel: getXpForNextLevel(level)
  };
}

function isMongoUserId(userId) {
  return (
    Boolean(userId) &&
    !String(userId).startsWith('guest_') &&
    !String(userId).startsWith('mem_') &&
    /^[a-f\d]{24}$/i.test(String(userId))
  );
}

/**
 * Localiza um usuário por ID no MongoDB ou no Map em memória.
 */
async function findUserById(userId) {
  if (!userId) return null;
  if (getDbStatus() && isMongoUserId(userId)) {
    try {
      const doc = await User.findById(userId);
      if (doc) return { source: 'mongo', doc };
    } catch (_) {}
  }
  if (memoryUsers.has(userId)) {
    return { source: 'memory', doc: memoryUsers.get(userId) };
  }
  const redisUser = await getCachedUserFromRedis(userId);
  if (redisUser) {
    memoryUsers.set(userId, redisUser);
    return { source: 'memory', doc: redisUser };
  }
  return null;
}

/**
 * Localiza um usuário pelo Nickname exato (case-insensitive) no banco de dados
 * ou na memória ativa.
 */
async function findUserByUsername(username) {
  const clean = String(username || '').trim();
  if (!clean) return null;

  if (getDbStatus()) {
    try {
      const doc = await User.findOne({
        username: new RegExp(`^${escapeRegex(clean)}$`, 'i')
      });
      if (doc) return { source: 'mongo', doc };
    } catch (_) {}
  }

  const lower = clean.toLowerCase();
  for (const u of memoryUsers.values()) {
    if (String(u.username || '').toLowerCase() === lower) {
      return { source: 'memory', doc: u };
    }
  }

  const cachedId = await getCachedUserIdByUsername(clean);
  if (cachedId) {
    const redisUser = await getCachedUserFromRedis(cachedId);
    if (redisUser) {
      memoryUsers.set(cachedId, redisUser);
      return { source: 'memory', doc: redisUser };
    }
  }
  return null;
}

/**
 * Extrai apenas o ID (String) de qualquer item salvo em `friends` ou `friendRequests`
 * (compatível com IDs puros e com documentos legados que tinham subobjetos).
 */
function extractStoredId(item) {
  if (!item) return '';
  if (typeof item === 'string') return item.trim();
  if (typeof item === 'object') {
    return String(item.userId || item.fromUserId || item._id || item.id || '').trim();
  }
  return '';
}

function normalizeIdList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const uniqueIds = [];
  const seen = new Set();
  for (const item of rawList) {
    const id = extractStoredId(item);
    if (id && !seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }
  return uniqueIds;
}

function extractUserSummary(record) {
  if (!record || !record.doc) return null;
  const d = record.doc;
  const id = record.source === 'mongo' ? d._id.toString() : d.id;
  const stats = normalizeStats(d.stats);
  return {
    id,
    username: d.username,
    skinColor: d.skinColor || '#FF3366',
    level: stats.level,
    stats,
    friends: normalizeIdList(d.friends),
    friendRequests: normalizeIdList(d.friendRequests)
  };
}

/**
 * Retorna a lista atualizada de amigos e solicitações pendentes de um jogador.
 * Como o banco salva apenas os IDs dos amigos, os dados (nickname, cor e nível)
 * são buscados em tempo real no registro atual de cada amigo!
 */
async function getFriendsState(userId) {
  const found = await findUserById(userId);
  if (!found) {
    return { friends: [], friendRequests: [] };
  }
  const summary = extractUserSummary(found);

  const enrichedFriends = (
    await Promise.all(
      summary.friends.map(async (friendId) => {
        const friendRecord = await findUserById(friendId);
        if (!friendRecord) return null;
        const fSum = extractUserSummary(friendRecord);
        return {
          userId: fSum.id,
          username: fSum.username,
          skinColor: fSum.skinColor,
          level: fSum.level
        };
      })
    )
  ).filter(Boolean);

  const enrichedRequests = (
    await Promise.all(
      summary.friendRequests.map(async (fromId) => {
        const reqRecord = await findUserById(fromId);
        if (!reqRecord) return null;
        const rSum = extractUserSummary(reqRecord);
        return {
          fromUserId: rSum.id,
          fromUsername: rSum.username,
          fromSkinColor: rSum.skinColor,
          fromLevel: rSum.level
        };
      })
    )
  ).filter(Boolean);

  return {
    friends: enrichedFriends,
    friendRequests: enrichedRequests
  };
}

/**
 * Envia uma solicitação de amizade após verificar se o nickname realmente existe
 * no banco de dados (ou memória ativa). Salva apenas o ID do remetente.
 */
async function sendFriendRequest(fromUserId, targetNickname) {
  const cleanTarget = String(targetNickname || '').trim();
  if (!cleanTarget) {
    return { error: 'Digite o nickname do jogador para enviar a solicitação!' };
  }

  const senderRecord = await findUserById(fromUserId);
  if (!senderRecord) {
    return { error: 'Sua sessão expirou. Faça login novamente.' };
  }
  const sender = extractUserSummary(senderRecord);

  const targetRecord = await findUserByUsername(cleanTarget);
  if (!targetRecord) {
    return {
      error: `O jogador "${cleanTarget}" não existe no banco de dados! Verifique o nickname digitado.`
    };
  }
  const target = extractUserSummary(targetRecord);

  if (sender.id === target.id || sender.username.toLowerCase() === target.username.toLowerCase()) {
    return { error: 'Você não pode enviar uma solicitação de amizade para si mesmo!' };
  }

  if (sender.friends.includes(target.id)) {
    return { error: `${target.username} já está na sua lista de amigos!` };
  }

  if (target.friendRequests.includes(sender.id)) {
    return { error: `Você já enviou uma solicitação para ${target.username}. Aguarde a aprovação!` };
  }

  const nextRequests = [...target.friendRequests, sender.id];
  targetRecord.doc.friendRequests = nextRequests;

  if (targetRecord.source === 'mongo') {
    await targetRecord.doc.save();
    cacheUserInRedis(extractUserSummary(targetRecord));
  } else {
    setMemoryUser(target.id, targetRecord.doc);
  }

  return {
    success: true,
    targetUserId: target.id,
    targetUsername: target.username,
    message: `Solicitação de amizade enviada para ${target.username}! Aguardando aprovação.`
  };
}

/**
 * Aprova ou recusa uma solicitação de amizade recebida.
 * No MongoDB e na memória, salva apenas o ID do amigo (`String`).
 */
async function respondToFriendRequest(userId, fromUserId, accept = true) {
  const userRecord = await findUserById(userId);
  if (!userRecord) {
    return { error: 'Usuário não encontrado.' };
  }
  const userSum = extractUserSummary(userRecord);

  const cleanFromId = String(fromUserId || '').trim();
  if (!userSum.friendRequests.includes(cleanFromId)) {
    return { error: 'Solicitação de amizade não encontrada ou já respondida.' };
  }

  userRecord.doc.friendRequests = userSum.friendRequests.filter((id) => id !== cleanFromId);

  const senderRecord = await findUserById(cleanFromId);
  const senderSum = senderRecord
    ? extractUserSummary(senderRecord)
    : {
        id: cleanFromId,
        username: 'Jogador',
        skinColor: '#FF3366',
        level: 1,
        friends: []
      };

  if (accept) {
    const nextUserFriends = [...userSum.friends];
    if (!nextUserFriends.includes(senderSum.id)) {
      nextUserFriends.push(senderSum.id);
    }
    userRecord.doc.friends = nextUserFriends;

    if (senderRecord) {
      const nextSenderFriends = [...senderSum.friends];
      if (!nextSenderFriends.includes(userSum.id)) {
        nextSenderFriends.push(userSum.id);
      }
      senderRecord.doc.friends = nextSenderFriends;
      if (senderRecord.source === 'mongo') {
        await senderRecord.doc.save();
        cacheUserInRedis(extractUserSummary(senderRecord));
      } else {
        setMemoryUser(senderSum.id, senderRecord.doc);
      }
    }
  } else {
    userRecord.doc.friends = userSum.friends;
  }

  if (userRecord.source === 'mongo') {
    await userRecord.doc.save();
    cacheUserInRedis(extractUserSummary(userRecord));
  } else {
    setMemoryUser(userSum.id, userRecord.doc);
  }

  return {
    success: true,
    accepted: Boolean(accept),
    friendUserId: senderSum.id,
    friendUsername: senderSum.username,
    message: accept
      ? `Você e ${senderSum.username} agora são amigos!`
      : `Solicitação de ${senderSum.username} recusada.`
  };
}

/**
 * Remove o ID do amigo de ambos os perfis.
 */
async function removeFriend(userId, friendUserId) {
  const userRecord = await findUserById(userId);
  if (!userRecord) return { error: 'Usuário não encontrado.' };

  const cleanFriendId = String(friendUserId || '').trim();
  const userSum = extractUserSummary(userRecord);
  userRecord.doc.friends = userSum.friends.filter((id) => id !== cleanFriendId);

  if (userRecord.source === 'mongo') {
    await userRecord.doc.save();
  } else {
    setMemoryUser(userId, userRecord.doc);
  }

  const friendRecord = await findUserById(cleanFriendId);
  if (friendRecord) {
    const friendSum = extractUserSummary(friendRecord);
    friendRecord.doc.friends = friendSum.friends.filter((id) => id !== String(userId).trim());
    if (friendRecord.source === 'mongo') {
      await friendRecord.doc.save();
    } else {
      setMemoryUser(cleanFriendId, friendRecord.doc);
    }
  }

  return { success: true, friendUserId: cleanFriendId };
}

async function updateUserMatchStats(userId, currentStats = {}, deltas = {}) {
  const base = normalizeStats(currentStats);
  const previousLevel = base.level;

  base.wins += Number(deltas.wins) || 0;
  base.matches += Number(deltas.matches) || 0;
  base.shoves += Number(deltas.shoves) || 0;
  base.kills += Number(deltas.kills) || 0;
  base.xp += Number(deltas.xpGained) || 0;

  while (base.xp >= getXpForNextLevel(base.level)) {
    base.xp -= getXpForNextLevel(base.level);
    base.level += 1;
  }
  base.xpToNextLevel = getXpForNextLevel(base.level);

  if (isMongoUserId(userId) && getDbStatus()) {
    try {
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            'stats.wins': base.wins,
            'stats.matches': base.matches,
            'stats.shoves': base.shoves,
            'stats.kills': base.kills,
            'stats.xp': base.xp,
            'stats.level': base.level
          }
        }
      );
    } catch (err) {
      console.warn('[Stats Update DB Warning]:', err.message);
    }
  } else if (userId && memoryUsers.has(userId)) {
    const mem = memoryUsers.get(userId);
    mem.stats = { ...base };
    setMemoryUser(userId, mem);
  }

  return {
    stats: base,
    previousLevel,
    newLevel: base.level,
    leveledUp: base.level > previousLevel
  };
}

function generateToken(userPayload) {
  return jwt.sign(userPayload, ENV.JWT_SECRET, { expiresIn: ENV.JWT_EXPIRES_IN });
}

// ============================================================================
// POST /api/auth/register — Criação de nova conta de jogador
// ============================================================================
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, skinColor } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
    }

    const cleanUsername = String(username).trim();
    const cleanEmail = String(email).trim().toLowerCase();

    if (cleanUsername.length < 3 || cleanUsername.length > 15) {
      return res.status(400).json({ error: 'O Nickname deve ter entre 3 e 15 caracteres.' });
    }

    if (String(password).length < 4) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 4 caracteres.' });
    }

    const salt = await bcrypt.genSalt(ENV.BCRYPT_SALT_ROUNDS);
    const passwordHash = await bcrypt.hash(password, salt);

    if (getDbStatus()) {
      const existingUser = await User.findOne({
        $or: [
          { email: cleanEmail },
          { username: new RegExp(`^${escapeRegex(cleanUsername)}$`, 'i') }
        ]
      }).lean();

      if (existingUser) {
        return res.status(409).json({ error: 'Nickname ou E-mail já está em uso!' });
      }

      const newUser = await User.create({
        username: cleanUsername,
        email: cleanEmail,
        passwordHash,
        skinColor: skinColor || '#FF3366',
        stats: { wins: 0, shoves: 0, kills: 0, matches: 0, xp: 0, level: 1 },
        friends: [],
        friendRequests: []
      });

      const payload = {
        id: newUser._id.toString(),
        username: newUser.username,
        skinColor: newUser.skinColor,
        stats: normalizeStats(newUser.stats),
        isGuest: false
      };
      cacheUserInRedis({ ...payload, friends: [], friendRequests: [] });

      return res.status(201).json({ token: generateToken(payload), user: payload });
    } else {
      for (const u of memoryUsers.values()) {
        if (
          !u.isGuest &&
          (u.email === cleanEmail || u.username.toLowerCase() === cleanUsername.toLowerCase())
        ) {
          return res.status(409).json({ error: 'Nickname ou E-mail já cadastrado na sessão!' });
        }
      }

      const id = 'mem_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
      const memUser = {
        id,
        username: cleanUsername,
        email: cleanEmail,
        passwordHash,
        skinColor: skinColor || '#FF3366',
        stats: normalizeStats({ wins: 0, shoves: 0, kills: 0, matches: 0, xp: 0, level: 1 }),
        friends: [],
        friendRequests: [],
        isGuest: false
      };
      setMemoryUser(id, memUser);

      const payload = {
        id: memUser.id,
        username: memUser.username,
        skinColor: memUser.skinColor,
        stats: memUser.stats,
        isGuest: false
      };

      return res.status(201).json({ token: generateToken(payload), user: payload });
    }
  } catch (err) {
    console.error('[Auth Register Error]:', err);
    return res.status(500).json({ error: 'Erro interno ao criar conta.' });
  }
});

// ============================================================================
// POST /api/auth/login — Autenticação de usuário existente
// ============================================================================
router.post('/login', async (req, res) => {
  try {
    const { emailOrUsername, password, skinColor } = req.body;

    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'Informe seu usuário/e-mail e senha.' });
    }

    const queryText = String(emailOrUsername).trim();

    if (getDbStatus()) {
      const user = await User.findOne({
        $or: [
          { email: queryText.toLowerCase() },
          { username: new RegExp(`^${escapeRegex(queryText)}$`, 'i') }
        ]
      });

      if (!user) {
        return res.status(401).json({ error: 'Usuário não encontrado.' });
      }

      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) {
        return res.status(401).json({ error: 'Senha incorreta!' });
      }

      if (skinColor && skinColor !== user.skinColor) {
        user.skinColor = skinColor;
        await user.save();
      }

      const payload = {
        id: user._id.toString(),
        username: user.username,
        skinColor: user.skinColor,
        stats: normalizeStats(user.stats),
        isGuest: false
      };
      cacheUserInRedis({
        ...payload,
        friends: normalizeIdList(user.friends),
        friendRequests: normalizeIdList(user.friendRequests)
      });

      return res.json({ token: generateToken(payload), user: payload });
    } else {
      let foundUser = null;
      for (const u of memoryUsers.values()) {
        if (
          !u.isGuest &&
          (u.email === queryText.toLowerCase() ||
            u.username.toLowerCase() === queryText.toLowerCase())
        ) {
          foundUser = u;
          break;
        }
      }

      if (!foundUser) {
        return res.status(401).json({ error: 'Usuário não encontrado (Modo Memória).' });
      }

      const isValid = await bcrypt.compare(password, foundUser.passwordHash);
      if (!isValid) {
        return res.status(401).json({ error: 'Senha incorreta!' });
      }

      if (skinColor) foundUser.skinColor = skinColor;
      setMemoryUser(foundUser.id, foundUser);

      const payload = {
        id: foundUser.id,
        username: foundUser.username,
        skinColor: foundUser.skinColor,
        stats: normalizeStats(foundUser.stats),
        isGuest: false
      };

      return res.json({ token: generateToken(payload), user: payload });
    }
  } catch (err) {
    console.error('[Auth Login Error]:', err);
    return res.status(500).json({ error: 'Erro interno ao realizar login.' });
  }
});

// ============================================================================
// POST /api/auth/guest — Entrada rápida sem cadastro (Convidado)
// ============================================================================
router.post('/guest', (req, res) => {
  const { username, skinColor } = req.body;
  const cleanName = (username || '').trim() || `Shover_${Math.floor(100 + Math.random() * 900)}`;

  const id = 'guest_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  const stats = normalizeStats({ wins: 0, shoves: 0, kills: 0, matches: 0, xp: 0, level: 1 });

  const payload = {
    id,
    username: cleanName.substring(0, 15),
    skinColor: skinColor || '#00E5FF',
    stats,
    isGuest: true
  };

  setMemoryUser(id, { ...payload, friends: [], friendRequests: [] });
  return res.json({ token: generateToken(payload), user: payload });
});

router.updateUserMatchStats = updateUserMatchStats;
router.normalizeStats = normalizeStats;
router.getFriendsState = getFriendsState;
router.sendFriendRequest = sendFriendRequest;
router.respondToFriendRequest = respondToFriendRequest;
router.removeFriend = removeFriend;
router.setMemoryUser = setMemoryUser;
router.findUserById = findUserById;

module.exports = router;
