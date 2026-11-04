// server/models/User.js
// ============================================================================
// Schema Mongoose para persistência de usuários registrados no MongoDB.
// A lista de amigos (`friends`) e de solicitações (`friendRequests`) armazena
// APENAS o ID do usuário (String), garantindo que nickname, cor e nível sejam
// sempre consultados em tempo real e nunca fiquem desatualizados.
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
  stats: {
    wins: { type: Number, default: 0 },
    shoves: { type: Number, default: 0 },
    kills: { type: Number, default: 0 },
    matches: { type: Number, default: 0 },
    xp: { type: Number, default: 0 },
    level: { type: Number, default: 1 }
  },
  friends: {
    type: [String],
    default: []
  },
  friendRequests: {
    type: [String],
    default: []
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('User', UserSchema);
