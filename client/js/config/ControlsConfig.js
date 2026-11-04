// client/js/config/ControlsConfig.js
// ============================================================================
// Gerenciador de Mapeamento de Teclas e Botões do Mouse para PC.
// Sem emojis (utiliza texto limpo combinado aos ícones Lucide na interface).
// ============================================================================

const STORAGE_KEY = 'shove_io_custom_controls_v2';

export const DEFAULT_CONTROLS = {
  up: 'KeyW',
  down: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  shove: 'Space',
  grab: 'KeyE'
};

export class ControlsConfig {
  constructor() {
    this.bindings = { ...DEFAULT_CONTROLS };
    this.load();
  }

  load() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        this.bindings = { ...DEFAULT_CONTROLS, ...parsed };
      }
    } catch (e) {
      this.bindings = { ...DEFAULT_CONTROLS };
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
    } catch (e) {
      console.warn('[ControlsConfig] Não foi possível salvar controles no localStorage.');
    }
  }

  setBinding(action, code) {
    if (!action || !code) return;
    this.bindings[action] = code;
    this.save();
  }

  resetToDefaults() {
    this.bindings = { ...DEFAULT_CONTROLS };
    this.save();
    return this.bindings;
  }

  matchesAction(action, code) {
    if (this.bindings[action] === code) return true;

    if (action === 'up' && this.bindings.up === 'KeyW' && code === 'ArrowUp') return true;
    if (action === 'down' && this.bindings.down === 'KeyS' && code === 'ArrowDown') return true;
    if (action === 'left' && this.bindings.left === 'KeyA' && code === 'ArrowLeft') return true;
    if (action === 'right' && this.bindings.right === 'KeyD' && code === 'ArrowRight') return true;

    if (action === 'grab' && this.bindings.grab === 'KeyE' && code === 'Mouse2') return true;

    return false;
  }

  static formatKeyLabel(code) {
    if (!code) return '---';
    const map = {
      Space: 'ESPAÇO',
      ArrowUp: 'SETA CIMA',
      ArrowDown: 'SETA BAIXO',
      ArrowLeft: 'SETA ESQ.',
      ArrowRight: 'SETA DIR.',
      ShiftLeft: 'SHIFT ESQ.',
      ShiftRight: 'SHIFT DIR.',
      ControlLeft: 'CTRL ESQ.',
      ControlRight: 'CTRL DIR.',
      Enter: 'ENTER',
      Mouse0: 'CLIQUE ESQ.',
      Mouse1: 'BOTÃO MEIO',
      Mouse2: 'CLIQUE DIR.'
    };

    if (map[code]) return map[code];
    if (code.startsWith('Key')) {
      const letter = code.replace('Key', '');
      if (letter === 'W') return 'W / SETA CIMA';
      if (letter === 'S') return 'S / SETA BAIXO';
      if (letter === 'A') return 'A / SETA ESQ.';
      if (letter === 'D') return 'D / SETA DIR.';
      if (letter === 'E') return 'TECLA E / CLIQUE DIR.';
      return `TECLA ${letter}`;
    }
    if (code.startsWith('Digit')) {
      return `TECLA ${code.replace('Digit', '')}`;
    }
    return code.toUpperCase();
  }
}
