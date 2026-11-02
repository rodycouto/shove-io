// client/js/config/ControlsConfig.js
// ============================================================================
// Gerenciador de Mapeamento de Teclas e Botões do Mouse para PC.
// Por padrão utiliza:
// - WASD / Setas para movimentação
// - ESPAÇO para Empurrar (Shove) e também para Escapar quando levantado
// - Tecla E (ou Clique Direito do Mouse) para Segurar/Levantar adversário (Grab)
// Permite personalizar qualquer botão na aba de Configurações (localStorage).
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

  /**
   * Carrega as configurações salvas pelo usuário no navegador.
   */
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

  /**
   * Salva o mapeamento atual no localStorage.
   */
  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
    } catch (e) {
      console.warn('[ControlsConfig] Não foi possível salvar controles no localStorage.');
    }
  }

  /**
   * Define uma nova tecla ou botão de mouse (ex: 'KeyE', 'Mouse0', 'Space') para uma ação.
   * @param {'up'|'down'|'left'|'right'|'shove'|'grab'} action
   * @param {string} code
   */
  setBinding(action, code) {
    if (!action || !code) return;
    this.bindings[action] = code;
    this.save();
  }

  /**
   * Restaura os controles para o padrão de fábrica (WASD/Setas + Espaço + Tecla E).
   */
  resetToDefaults() {
    this.bindings = { ...DEFAULT_CONTROLS };
    this.save();
    return this.bindings;
  }

  /**
   * Verifica se um determinado código de tecla/mouse ativa uma ação.
   * Mantém as Setas Direcionais sempre ativas caso o usuário esteja com o WASD padrão,
   * e Clique Direito (Mouse2) ativo junto com a Tecla E por padrão para Segurar.
   */
  matchesAction(action, code) {
    if (this.bindings[action] === code) return true;

    // Suporte nativo simultâneo às Setas quando o padrão WASD está selecionado
    if (action === 'up' && this.bindings.up === 'KeyW' && code === 'ArrowUp') return true;
    if (action === 'down' && this.bindings.down === 'KeyS' && code === 'ArrowDown') return true;
    if (action === 'left' && this.bindings.left === 'KeyA' && code === 'ArrowLeft') return true;
    if (action === 'right' && this.bindings.right === 'KeyD' && code === 'ArrowRight') return true;

    // Quando o botão de Segurar está no padrão (KeyE), também aceita Clique Direito (Mouse2)
    if (action === 'grab' && this.bindings.grab === 'KeyE' && code === 'Mouse2') return true;

    return false;
  }

  /**
   * Converte códigos técnicos (KeyW, ArrowUp, Mouse0) em rótulos amigáveis e infantis.
   */
  static formatKeyLabel(code) {
    if (!code) return '---';
    const map = {
      Space: 'ESPAÇO ⎵',
      ArrowUp: 'SETA ↑',
      ArrowDown: 'SETA ↓',
      ArrowLeft: 'SETA ←',
      ArrowRight: 'SETA →',
      ShiftLeft: 'SHIFT ESQ.',
      ShiftRight: 'SHIFT DIR.',
      ControlLeft: 'CTRL ESQ.',
      ControlRight: 'CTRL DIR.',
      Enter: 'ENTER ↵',
      Mouse0: 'CLIQUE ESQ. 🖱️',
      Mouse1: 'BOTÃO MEIO 🖱️',
      Mouse2: 'CLIQUE DIR. 🖱️'
    };

    if (map[code]) return map[code];
    if (code.startsWith('Key')) {
      const letter = code.replace('Key', '');
      if (letter === 'W') return 'W / ↑';
      if (letter === 'S') return 'S / ↓';
      if (letter === 'A') return 'A / ←';
      if (letter === 'D') return 'D / →';
      if (letter === 'E') return 'TECLA E / 🖱️ DIR.';
      return `TECLA ${letter}`;
    }
    if (code.startsWith('Digit')) {
      return `TECLA ${code.replace('Digit', '')}`;
    }
    return code.toUpperCase();
  }
}
