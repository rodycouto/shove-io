// client/js/audio/SoundManager.js
// ============================================================================
// Sintetizador de Áudio Procedural (Web Audio API) para o Shove.io.
// Inclui som de salto nos trampolins (Circo Saltitante) e soco/nocaute da
// Luva de Boxe (Boxing Glove KO).
// ============================================================================

export class SoundManager {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('shove_io_muted') === 'true';
    this.unlocked = false;

    this.lobbyMusicActive = false;
    this.lobbyMusicTimer = null;
    this.lobbyStep = 0;

    const unlock = () => {
      this.ensureContext();
      if (this.lobbyMusicActive && !this.lobbyMusicTimer && !this.muted) {
        this.scheduleLobbyMusicLoop();
      }
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
  }

  ensureContext() {
    if (this.muted) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this.unlocked = true;
    return this.ctx;
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('shove_io_muted', String(this.muted));
    if (this.muted) {
      if (this.lobbyMusicTimer) {
        clearInterval(this.lobbyMusicTimer);
        this.lobbyMusicTimer = null;
      }
    } else {
      this.ensureContext();
      this.playClick();
      if (this.lobbyMusicActive) {
        this.scheduleLobbyMusicLoop();
      }
    }
    return this.muted;
  }

  startLobbyMusic() {
    this.lobbyMusicActive = true;
    if (this.muted) return;
    this.scheduleLobbyMusicLoop();
  }

  stopLobbyMusic() {
    this.lobbyMusicActive = false;
    if (this.lobbyMusicTimer) {
      clearInterval(this.lobbyMusicTimer);
      this.lobbyMusicTimer = null;
    }
  }

  scheduleLobbyMusicLoop() {
    if (this.lobbyMusicTimer) {
      clearInterval(this.lobbyMusicTimer);
      this.lobbyMusicTimer = null;
    }

    const melodyNotes = [
      523.25, 659.25, 783.99, 659.25,
      587.33, 698.46, 880.00, 698.46,
      523.25, 659.25, 783.99, 1046.50,
      987.77, 783.99, 659.25, 587.33
    ];
    const bassNotes = [
      130.81, 130.81, 196.00, 196.00,
      146.83, 146.83, 220.00, 220.00,
      130.81, 130.81, 196.00, 196.00,
      196.00, 174.61, 164.81, 146.83
    ];

    this.lobbyMusicTimer = setInterval(() => {
      if (!this.lobbyMusicActive || this.muted) return;
      const ctx = this.ensureContext();
      if (!ctx || ctx.state !== 'running') return;

      const now = ctx.currentTime;
      const idx = this.lobbyStep % melodyNotes.length;
      this.lobbyStep++;

      const leadOsc = ctx.createOscillator();
      const leadGain = ctx.createGain();
      leadOsc.type = 'triangle';
      leadOsc.frequency.setValueAtTime(melodyNotes[idx], now);
      leadGain.gain.setValueAtTime(0.045, now);
      leadGain.gain.exponentialRampToValueAtTime(0.001, now + 0.19);
      leadOsc.connect(leadGain);
      leadGain.connect(ctx.destination);
      leadOsc.start(now);
      leadOsc.stop(now + 0.19);

      if (idx % 2 === 0) {
        const bassOsc = ctx.createOscillator();
        const bassGain = ctx.createGain();
        bassOsc.type = 'sine';
        bassOsc.frequency.setValueAtTime(bassNotes[idx], now);
        bassGain.gain.setValueAtTime(0.06, now);
        bassGain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
        bassOsc.connect(bassGain);
        bassGain.connect(ctx.destination);
        bassOsc.start(now);
        bassOsc.stop(now + 0.32);
      }
    }, 220);
  }

  playCountdownBeep(isFinalShove = false) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    if (isFinalShove) {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.28);
      gain.gain.setValueAtTime(0.28, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.32);
    } else {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.14);
    }
  }

  playClick() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(780, ctx.currentTime + 0.06);

    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.06);
  }

  playShove(power = 0.6) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    const startFreq = 180 + power * 140;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.22);

    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.22);
  }

  playMegaShove() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(320, now);
    osc1.frequency.exponentialRampToValueAtTime(38, now + 0.45);

    osc2.type = 'square';
    osc2.frequency.setValueAtTime(160, now);
    osc2.frequency.exponentialRampToValueAtTime(28, now + 0.45);

    gain.gain.setValueAtTime(0.38, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);
    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.45);
    osc2.stop(now + 0.45);
  }

  /**
   * Som de impacto pesado e gongo de nocaute da Luva de Boxe (KO 2s).
   */
  playBoxingKnockout() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const punchOsc = ctx.createOscillator();
    const punchGain = ctx.createGain();
    punchOsc.type = 'sawtooth';
    punchOsc.frequency.setValueAtTime(240, now);
    punchOsc.frequency.exponentialRampToValueAtTime(32, now + 0.28);
    punchGain.gain.setValueAtTime(0.4, now);
    punchGain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    punchOsc.connect(punchGain);
    punchGain.connect(ctx.destination);
    punchOsc.start(now);
    punchOsc.stop(now + 0.28);

    // Som de sino de ringue de boxe logo após o soco
    const bellOsc = ctx.createOscillator();
    const bellGain = ctx.createGain();
    bellOsc.type = 'triangle';
    bellOsc.frequency.setValueAtTime(1180, now + 0.08);
    bellGain.gain.setValueAtTime(0.22, now + 0.08);
    bellGain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    bellOsc.connect(bellGain);
    bellGain.connect(ctx.destination);
    bellOsc.start(now + 0.08);
    bellOsc.stop(now + 0.55);
  }

  /**
   * Som de mola elástica (Boing!) ao saltar nos 5 trampolins do Circo Saltitante.
   */
  playTrampolineJump() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(190, now);
    osc.frequency.exponentialRampToValueAtTime(680, now + 0.26);

    gain.gain.setValueAtTime(0.24, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.26);
  }

  playGrab() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(240, now);
    osc.frequency.exponentialRampToValueAtTime(580, now + 0.16);

    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.16);
  }

  playStruggle() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.setValueAtTime(540, now + 0.03);

    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  playEscapeStun() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const notes = [520, 680, 440, 620];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.055);
      gain.gain.setValueAtTime(0.18, now + idx * 0.055);
      gain.gain.exponentialRampToValueAtTime(0.001, now + (idx + 1) * 0.055);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.055);
      osc.stop(now + (idx + 1) * 0.055);
    });
  }

  playShock() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    for (let i = 0; i < 6; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      const start = now + i * 0.045;
      osc.frequency.setValueAtTime(700 + (i % 2) * 450, start);
      osc.frequency.exponentialRampToValueAtTime(220, start + 0.04);

      gain.gain.setValueAtTime(0.22, start);
      gain.gain.exponentialRampToValueAtTime(0.01, start + 0.04);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.045);
    }
  }

  playPowerupPickup() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const freqs = [440, 554.37, 659.25, 880];
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const t = now + i * 0.05;
      osc.frequency.setValueAtTime(f, t);
      gain.gain.setValueAtTime(0.18, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.12);
    });
  }

  playPowerupSpawn() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, now);
    osc.frequency.exponentialRampToValueAtTime(990, now + 0.18);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.18);
  }

  playFall() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(480, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.45);

    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.45);
  }

  playVictory() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const melody = [
      { f: 523.25, d: 0.14, t: 0.0 },
      { f: 659.25, d: 0.14, t: 0.15 },
      { f: 783.99, d: 0.14, t: 0.30 },
      { f: 1046.5, d: 0.45, t: 0.45 }
    ];

    melody.forEach((n) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(n.f, now + n.t);
      gain.gain.setValueAtTime(0.25, now + n.t);
      gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + n.d);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.t);
      osc.stop(now + n.t + n.d);
    });
  }
}
