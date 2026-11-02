// server/routes/authRoutes.js
// ============================================================================
// Rotas de autenticação (Registro, Login, Convidado), Lista de Amigos e
// Persistência de Estatísticas (Vitórias, Partidas, Shoves, Kills, XP e Níveis).
// ============================================================================

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getDbStatus } = require('../config/db');
const ENV = require('../config/env');

const router = express.Router();

// Armazenamento em memória para modo fallback ou convidados ativos na sessão
const memoryUsers = new Map();

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

/**
 * Atualiza e persiste as estatísticas e o XP/Nível de um jogador ao término da partida.
 */
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

  if (userId && !String(userId).startsWith('guest_') && !String(userId).startsWith('mem_') && getDbStatus()) {
    try {
      await User.findByIdAndUpdate(userId, {
        $set: {
          'stats.wins': base.wins,
          'stats.matches': base.matches,
          'stats.shoves': base.shoves,
          'stats.kills': base.kills,
          'stats.xp': base.xp,
          'stats.level': base.level
        }
      });
    } catch (err) {
      console.warn('[Stats Update DB Warning]:', err.message);
    }
  } else if (userId && memoryUsers.has(userId)) {
    const mem = memoryUsers.get(userId);
    mem.stats = { ...base };
  }

  return {
    stats: base,
    previousLevel,
    newLevel: base.level,
    leveledUp: base.level > previousLevel
  };
}

/**
 * Salva a lista atualizada de amigos de um usuário no MongoDB ou em memória.
 */
async function saveUserFriendsList(userId, friendsArray = []) {
  const cleanList = Array.from(new Set(friendsArray.map((f) => String(f).trim()).filter(Boolean)));

  if (userId && !String(userId).startsWith('guest_') && !String(userId).startsWith('mem_') && getDbStatus()) {
    try {
      await User.findByIdAndUpdate(userId, { $set: { friends: cleanList } });
    } catch (err) {
      console.warn('[Friends Save DB Warning]:', err.message);
    }
  } else if (userId && memoryUsers.has(userId)) {
    memoryUsers.get(userId).friends = cleanList;
  }

  return cleanList;
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
        $or: [{ email: cleanEmail }, { username: cleanUsername }]
      });
      if (existingUser) {
        return res.status(409).json({ error: 'Nickname ou E-mail já está em uso!' });
      }

      const newUser = await User.create({
        username: cleanUsername,
        email: cleanEmail,
        passwordHash,
        skinColor: skinColor || '#FF3366',
        friends: [],
        stats: { wins: 0, shoves: 0, kills: 0, matches: 0, xp: 0, level: 1 }
      });

      const payload = {
        id: newUser._id.toString(),
        username: newUser.username,
        skinColor: newUser.skinColor,
        friends: newUser.friends || [],
        stats: normalizeStats(newUser.stats),
        isGuest: false
      };

      return res.status(201).json({ token: generateToken(payload), user: payload });
    } else {
      for (const u of memoryUsers.values()) {
        if (u.email === cleanEmail || u.username.toLowerCase() === cleanUsername.toLowerCase()) {
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
        friends: [],
        stats: normalizeStats({ wins: 0, shoves: 0, kills: 0, matches: 0, xp: 0, level: 1 }),
        isGuest: false
      };
      memoryUsers.set(id, memUser);

      const payload = {
        id: memUser.id,
        username: memUser.username,
        skinColor: memUser.skinColor,
        friends: memUser.friends,
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
          { username: queryText }
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
        friends: user.friends || [],
        stats: normalizeStats(user.stats),
        isGuest: false
      };

      return res.json({ token: generateToken(payload), user: payload });
    } else {
      let foundUser = null;
      for (const u of memoryUsers.values()) {
        if (
          u.email === queryText.toLowerCase() ||
          u.username.toLowerCase() === queryText.toLowerCase()
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

      const payload = {
        id: foundUser.id,
        username: foundUser.username,
        skinColor: foundUser.skinColor,
        friends: foundUser.friends || [],
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
    friends: [],
    stats,
    isGuest: true
  };

  memoryUsers.set(id, payload);
  return res.json({ token: generateToken(payload), user: payload });
});

router.updateUserMatchStats = updateUserMatchStats;
router.saveUserFriendsList = saveUserFriendsList;
router.normalizeStats = normalizeStats;

module.exports = router;