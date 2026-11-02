// server/models/User.js
// ============================================================================
// Schema Mongoose para persistência de usuários registrados no MongoDB.
// Armazena credenciais, cor escolhida do Shover, lista de amigos (nicknames),
// estatísticas acumuladas (vitórias, partidas, shoves, kills) e Nível/XP.
// ============================================================================

const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 15
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  skinColor: {
    type: String,
    default: '#FF3366'
  },
  // Lista de amigos (armazena os nicknames adicionados pelo jogador)
  friends: {
    type: [String],
    default: []
  },
  stats: {
    wins: { type: Number, default: 0 },
    shoves: { type: Number, default: 0 },
    kills: { type: Number, default: 0 },
    matches: { type: Number, default: 0 },
    xp: { type: Number, default: 0 },
    level: { type: Number, default: 1 }
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('User', UserSchema);