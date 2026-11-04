// client/js/ui/LoginScreen.js
// ============================================================================
// Controlador Principal de UI (v2.0):
// - Ícones oficiais do Lucide (https://lucide.dev/icons/) substituindo todos os emojis
// - Quantidade de Jogadores Online ao lado do Ping na tela inicial
// - Sistema de Amigos com verificação real no banco de dados e aprovação de convite
// - Nível do personagem (Nv. X) ao lado do nome na sala, nos amigos e na vitória
// - Suporte ao novo mapa Circo Saltitante (5 trampolins) e Luva de Boxe (KO 2s)
// - Remoção de velocidade/modo de jogo do HUD da partida e kill feed oculto no celular
// - Swipe horizontal no celular para acessar a Configuração da Sala
// ============================================================================

import { LobbyBackgroundScene } from '../scenes/LobbyBackgroundScene.js';
import { GameScene } from '../scenes/GameScene.js';
import { ControlsConfig } from '../config/ControlsConfig.js';
import { SoundManager } from '../audio/SoundManager.js';
import { lucideIcon } from './LucideIcons.js';

class LoginScreenController {
  constructor() {
    this.selectedColor = '#FF3366';
    this.currentUser = null;
    this.token = null;
    this.currentRoom = null;
    this.listeningControlAction = null;

    this.pendingUrlRoomId = this.extractRoomIdFromUrl();

    this.hudCache = {
      roundKey: '',
      timeRemaining: -1,
      powerupKey: '',
      aliveCount: -1,
      isGrabbed: false,
      escapePresses: -1
    };

    this.socket = window.io({
      transports: ['websocket', 'polling'],
      upgrade: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 2000
    });
    this.soundManager = new SoundManager();
    this.controlsConfig = new ControlsConfig();
    this.bgScene = new LobbyBackgroundScene('bg-canvas');
    this.gameScene = new GameScene(
      'game-canvas',
      this.socket,
      this.controlsConfig,
      this.soundManager
    );

    this.cacheDOM();
    this.initStaticIcons();
    this.startPingMonitor();
    this.bindAuthEvents();
    this.bindLobbyEvents();
    this.bindFriendsEvents();
    this.initRoomChatDOM();
    this.bindRoomConfigWindowEvents();
    this.bindRoomChatEvents();
    this.bindSettingsEvents();
    this.bindSocketEvents();
    this.renderControlLabels();
    this.updateSoundButtonsUI();
    this.restoreSession();
  }

  initRoomChatDOM() {
    this.roomChatWidget = document.getElementById('room-chat-widget');
    this.roomChatHeader = document.getElementById('room-chat-header');
    this.roomChatTitle = document.getElementById('room-chat-title');
    this.roomChatUnreadBadge = document.getElementById('room-chat-unread-badge');
    this.btnToggleRoomChat = document.getElementById('btn-toggle-room-chat');
    this.roomChatMessages = document.getElementById('room-chat-messages');
    this.roomChatForm = document.getElementById('room-chat-form');
    this.roomChatInput = document.getElementById('room-chat-input');
    this.roomChatCharCount = document.getElementById('room-chat-char-count');
    this.activeChatRoomId = null;
    this.renderedChatMessageIds = new Set();
    this.unreadChatCount = 0;
  }

  bindRoomChatEvents() {
    if (!this.roomChatWidget) return;

    const toggleMinimize = () => {
      const isMin = this.roomChatWidget.classList.toggle('minimized');
      if (this.btnToggleRoomChat) {
        this.btnToggleRoomChat.innerHTML = isMin
          ? lucideIcon('chevron-up', 15)
          : lucideIcon('chevron-down', 15);
      }
      if (!isMin) {
        this.unreadChatCount = 0;
        if (this.roomChatUnreadBadge) {
          this.roomChatUnreadBadge.classList.add('hidden');
        }
        if (this.roomChatMessages) {
          this.roomChatMessages.scrollTop = this.roomChatMessages.scrollHeight;
        }
      }
    };

    if (this.roomChatHeader) {
      this.roomChatHeader.addEventListener('click', (e) => {
        if (e.target.closest('#btn-toggle-room-chat')) return;
        toggleMinimize();
      });
    }

    if (this.btnToggleRoomChat) {
      this.btnToggleRoomChat.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMinimize();
      });
    }

    if (this.roomChatInput) {
      this.roomChatInput.addEventListener('input', () => {
        if (this.roomChatInput.value.length > 100) {
          this.roomChatInput.value = this.roomChatInput.value.substring(0, 100);
        }
        if (this.roomChatCharCount) {
          this.roomChatCharCount.textContent = `${this.roomChatInput.value.length}/100`;
        }
      });

      this.roomChatInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
      });
    }

    if (this.roomChatForm) {
      this.roomChatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!this.currentRoom || !this.roomChatInput) return;

        const rawText = this.roomChatInput.value.trim().substring(0, 100);
        if (!rawText) return;

        this.socket.emit('room:chat_send', { text: rawText }, (res) => {
          if (res?.error) {
            this.showLobbyFeedback(res.error, 'error');
          }
        });

        this.roomChatInput.value = '';
        if (this.roomChatCharCount) {
          this.roomChatCharCount.textContent = '0/100';
        }
      });
    }
  }

  syncRoomChatFromRoom(room, inMatch = false) {
    if (!this.roomChatWidget || !room || !room.id) return;

    this.roomChatWidget.classList.remove('hidden');
    this.roomChatWidget.classList.toggle('in-match-mode', Boolean(inMatch));

    if (this.roomChatTitle) {
      this.roomChatTitle.textContent = `CHAT DA SALA #${room.id}`;
    }

    if (this.isMobileDevice() && (inMatch || this.activeChatRoomId !== room.id)) {
      this.roomChatWidget.classList.add('minimized');
      if (this.btnToggleRoomChat) {
        this.btnToggleRoomChat.innerHTML = lucideIcon('chevron-up', 15);
      }
    }

    const history = Array.isArray(room.chatHistory) ? room.chatHistory : [];

    if (this.activeChatRoomId !== room.id) {
      this.activeChatRoomId = room.id;
      this.renderedChatMessageIds.clear();
      this.unreadChatCount = 0;
      if (this.roomChatUnreadBadge) {
        this.roomChatUnreadBadge.classList.add('hidden');
      }
      if (this.roomChatMessages) {
        this.roomChatMessages.innerHTML = '';
        if (history.length === 0) {
          this.roomChatMessages.innerHTML =
            '<div class="room-chat-empty">Histórico temporário da sala (máx. 100 caracteres por mensagem).</div>';
        }
      }
    }

    history.forEach((msg) => {
      if (!this.renderedChatMessageIds.has(msg.id)) {
        this.appendChatMessageToDOM(msg, false);
      }
    });
  }

  hideAndClearRoomChat() {
    this.activeChatRoomId = null;
    if (this.renderedChatMessageIds) {
      this.renderedChatMessageIds.clear();
    }
    this.unreadChatCount = 0;
    if (this.roomChatUnreadBadge) {
      this.roomChatUnreadBadge.classList.add('hidden');
    }
    if (this.roomChatMessages) {
      this.roomChatMessages.innerHTML =
        '<div class="room-chat-empty">Histórico temporário da sala (máx. 100 caracteres por mensagem).</div>';
    }
    if (this.roomChatInput) {
      this.roomChatInput.value = '';
    }
    if (this.roomChatCharCount) {
      this.roomChatCharCount.textContent = '0/100';
    }
    if (this.roomChatWidget) {
      this.roomChatWidget.classList.add('hidden');
      this.roomChatWidget.classList.remove('in-match-mode');
    }
  }

  appendChatMessageToDOM(msg, countUnread = true) {
    if (!this.roomChatMessages || !msg || !msg.id) return;
    if (this.renderedChatMessageIds.has(msg.id)) return;
    this.renderedChatMessageIds.add(msg.id);

    const emptyEl = this.roomChatMessages.querySelector('.room-chat-empty');
    if (emptyEl) emptyEl.remove();

    const item = document.createElement('div');
    item.className = 'room-chat-msg-item';
    const skinColor = msg.skinColor || '#00f2fe';
    item.style.borderLeftColor = skinColor;

    const authorSpan = document.createElement('span');
    authorSpan.className = 'room-chat-msg-author';
    authorSpan.style.color = skinColor;
    authorSpan.textContent = `${msg.username || 'Jogador'}:`;

    const textSpan = document.createElement('span');
    textSpan.className = 'room-chat-msg-text';
    const safeText = String(msg.text || '').substring(0, 100);
    textSpan.textContent = safeText;

    item.appendChild(authorSpan);
    item.appendChild(textSpan);

    // Detecta se a mensagem contém um link de sala ou do jogo (ex: https://shove.discloud.dev/room/ZR7Q)
    const roomLinkMatch = safeText.match(/(?:https?:\/\/[^\s]+)?\/room\/([A-Za-z0-9]{3,8})/i);
    if (roomLinkMatch) {
      const targetCode = roomLinkMatch[1].toUpperCase();
      const badge = document.createElement('div');
      badge.className = 'chat-room-link-badge';

      const infoDiv = document.createElement('div');
      infoDiv.className = 'chat-room-link-info';
      infoDiv.innerHTML = `
        <span class="chat-room-link-tag">SHOVE.IO ARENA • CONVITE</span>
        <strong class="chat-room-link-title">Sala #${targetCode}</strong>
        <span class="chat-room-link-sub">Clique para entrar direto na partida</span>
      `;

      const joinBtn = document.createElement('button');
      joinBtn.type = 'button';
      joinBtn.className = 'btn-chat-join-badge';
      joinBtn.innerHTML = `${lucideIcon('external-link', 12)} <span>ENTRAR</span>`;
      joinBtn.addEventListener('click', () => {
        this.soundManager.playClick();
        if (this.currentRoom && this.currentRoom.id === targetCode) {
          this.showLobbyFeedback(`Você já está na Sala #${targetCode}!`, 'success');
          return;
        }
        this.joinRoomByCode(targetCode);
      });

      badge.appendChild(infoDiv);
      badge.appendChild(joinBtn);
      item.appendChild(badge);
    }

    this.roomChatMessages.appendChild(item);
    this.roomChatMessages.scrollTop = this.roomChatMessages.scrollHeight;

    if (
      countUnread &&
      this.roomChatWidget &&
      this.roomChatWidget.classList.contains('minimized') &&
      this.roomChatUnreadBadge
    ) {
      this.unreadChatCount += 1;
      this.roomChatUnreadBadge.textContent = String(this.unreadChatCount);
      this.roomChatUnreadBadge.classList.remove('hidden');
    }
  }

  isMobileDevice() {
    return (
      window.innerWidth <= 820 ||
      window.matchMedia('(hover: none) and (pointer: coarse)').matches
    );
  }

  resetHudCache() {
    this.hudCache.roundKey = '';
    this.hudCache.timeRemaining = -1;
    this.hudCache.powerupKey = '';
    this.hudCache.aliveCount = -1;
    this.hudCache.isGrabbed = false;
    this.hudCache.escapePresses = -1;
  }

  extractRoomIdFromUrl() {
    const pathMatch = window.location.pathname.match(/^\/room\/([A-Za-z0-9_]+)/i);
    if (pathMatch && pathMatch[1]) {
      return pathMatch[1].toUpperCase();
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get('room')) {
      return params.get('room').trim().toUpperCase();
    }
    return null;
  }

  cacheDOM() {
    this.pingDot = document.getElementById('ping-dot');
    this.pingText = document.getElementById('ping-text');
    this.onlineWidget = document.getElementById('online-widget');
    this.onlineCountText = document.getElementById('online-count-text');

    this.lobbyUiWrapper = document.getElementById('lobby-ui-wrapper');
    this.authCard = document.getElementById('auth-card');
    this.lobbyLayoutContainer = document.getElementById('lobby-layout-container');
    this.lobbyCard = document.getElementById('lobby-card');
    this.roomConfigWindow = document.getElementById('room-config-window');

    this.feedbackBox = document.getElementById('auth-feedback');
    this.lobbyFeedbackBox = document.getElementById('lobby-feedback');

    this.tabButtons = document.querySelectorAll('.tab-btn');
    this.swatches = document.querySelectorAll('.swatch');
    this.formLogin = document.getElementById('form-login');
    this.formRegister = document.getElementById('form-register');
    this.formGuest = document.getElementById('form-guest');

    this.profileDot = document.getElementById('profile-color-dot');
    this.profileName = document.getElementById('profile-name');
    this.profileLevelBadge = document.getElementById('profile-level-badge');
    this.profileStats = document.getElementById('profile-stats');
    this.profileXpFill = document.getElementById('profile-xp-fill');
    this.profileXpText = document.getElementById('profile-xp-text');
    this.btnToggleSound = document.getElementById('btn-toggle-sound');
    this.btnLogout = document.getElementById('btn-logout');

    this.lobbyTabBtns = document.querySelectorAll('.lobby-tab-btn');
    this.lobbyViewPlay = document.getElementById('lobby-view-play');
    this.lobbyViewFriends = document.getElementById('lobby-view-friends');
    this.lobbyViewSettings = document.getElementById('lobby-view-settings');

    // Elementos da Aba de Amigos
    this.friendsPendingBadge = document.getElementById('friends-pending-badge');
    this.formAddFriend = document.getElementById('form-add-friend');
    this.inputFriendNickname = document.getElementById('input-friend-nickname');
    this.friendsFeedback = document.getElementById('friends-feedback');
    this.friendRequestsBox = document.getElementById('friend-requests-box');
    this.friendRequestsList = document.getElementById('friend-requests-list');
    this.friendsCountBadge = document.getElementById('friends-count-badge');
    this.friendsList = document.getElementById('friends-list');

    this.lobbyModeActions = document.getElementById('lobby-mode-actions');
    this.btnPlayBR = document.getElementById('btn-play-br');
    this.btnCreateRoom = document.getElementById('btn-create-room');
    this.btnJoinRoom = document.getElementById('btn-join-room');
    this.inputRoomCode = document.getElementById('input-room-code');

    this.publicRoomsCount = document.getElementById('public-rooms-count');
    this.publicRoomsList = document.getElementById('public-rooms-list');

    this.activeRoomPanel = document.getElementById('active-room-panel');
    this.roomCodeDisplay = document.getElementById('room-code-display');
    this.roomModeDisplay = document.getElementById('room-mode-display');
    this.roomCountDisplay = document.getElementById('room-count-display');
    this.roomShareUrl = document.getElementById('room-share-url');
    this.btnCopyRoomLink = document.getElementById('btn-copy-room-link');
    this.roomFfBadge = document.getElementById('room-ff-badge');
    this.roomRoundsBadge = document.getElementById('room-rounds-badge');
    this.roomAccessBadge = document.getElementById('room-access-badge');
    this.readyCounterBadge = document.getElementById('ready-counter-badge');
    this.roomPlayersList = document.getElementById('room-players-list');

    this.joinRequestsBox = document.getElementById('join-requests-box');
    this.joinRequestsList = document.getElementById('join-requests-list');

    this.brCountdownBanner = document.getElementById('br-countdown-banner');
    this.brTimerSeconds = document.getElementById('br-timer-seconds');
    this.brQuorumText = document.getElementById('br-quorum-text');
    this.brProgressFill = document.getElementById('br-progress-fill');

    this.teamPickerBox = document.getElementById('team-picker-box');
    this.teamButtonsGrid = document.getElementById('team-buttons-grid');

    this.btnToggleReady = document.getElementById('btn-toggle-ready');
    this.btnStartMatch = document.getElementById('btn-start-match');
    this.waitingHostMsg = document.getElementById('waiting-host-msg');
    this.btnLeaveRoom = document.getElementById('btn-leave-room');

    this.configHostTag = document.getElementById('config-host-tag');
    this.configWindowSub = document.getElementById('config-window-sub');
    this.cfgOpenJoinToggle = document.getElementById('cfg-open-join-toggle');
    this.cfgOpenJoinState = document.getElementById('cfg-open-join-state');
    this.btnRoundsMinus = document.getElementById('btn-rounds-minus');
    this.btnRoundsPlus = document.getElementById('btn-rounds-plus');
    this.cfgRoundsValue = document.getElementById('cfg-rounds-value');

    this.roomSizePills = document.querySelectorAll('#room-team-size-pills .size-pill');
    this.roomFfRow = document.getElementById('room-ff-row');
    this.roomFfToggle = document.getElementById('room-friendly-fire-toggle');
    this.roomFfStateLabel = document.getElementById('room-ff-state-label');

    this.cfgMapsChecklist = document.getElementById('cfg-maps-checklist');
    this.cfgMapsModeHint = document.getElementById('cfg-maps-mode-hint');
    this.cfgMapsSearch = document.getElementById('cfg-maps-search');
    this.btnMapsAll = document.getElementById('btn-maps-all');
    this.btnMapsNone = document.getElementById('btn-maps-none');

    this.cfgPowerupsChecklist = document.getElementById('cfg-powerups-checklist');
    this.cfgPowerupsSearch = document.getElementById('cfg-powerups-search');
    this.btnPowerupsAll = document.getElementById('btn-powerups-all');
    this.btnPowerupsNone = document.getElementById('btn-powerups-none');

    this.cfgSpeedPills = document.querySelectorAll('#cfg-speed-pills .cfg-pill');
    this.cfgDurationPills = document.querySelectorAll('#cfg-duration-pills .cfg-pill');
    this.btnBotsMinus = document.getElementById('btn-bots-minus');
    this.btnBotsPlus = document.getElementById('btn-bots-plus');
    this.cfgBotsValue = document.getElementById('cfg-bots-value');
    this.cfgPowerupsToggle = document.getElementById('cfg-powerups-toggle');
    this.cfgPowerupsState = document.getElementById('cfg-powerups-state');
    this.cfgPowerupIntervalBlock = document.getElementById('cfg-powerup-interval-block');
    this.cfgSpawnPills = document.querySelectorAll('#cfg-spawn-pills .cfg-pill');

    this.bindKeyButtons = document.querySelectorAll('.bind-key-btn');
    this.btnResetControls = document.getElementById('btn-reset-controls');

    this.matchHud = document.getElementById('match-hud');
    this.hudMapName = document.getElementById('hud-map-name');
    this.hudMapDesc = document.getElementById('hud-map-desc');
    this.hudRoundPill = document.getElementById('hud-round-pill');
    this.hudTimerPill = document.getElementById('hud-timer-pill');
    this.hudPowerupTimerPill = document.getElementById('hud-powerup-timer-pill');
    this.hudAlivePill = document.getElementById('hud-alive-pill');
    this.btnHudSound = document.getElementById('btn-hud-sound');
    this.btnQuitMatch = document.getElementById('btn-quit-match');

    this.mapPresentationOverlay = document.getElementById('map-presentation-overlay');
    this.presentationRoundBadge = document.getElementById('presentation-round-badge');
    this.presentationMapTitle = document.getElementById('presentation-map-title');
    this.presentationMapPeculiarity = document.getElementById('presentation-map-peculiarity');

    this.bigCountdownOverlay = document.getElementById('big-countdown-overlay');
    this.bigCountdownText = document.getElementById('big-countdown-text');

    this.hudEscapeBanner = document.getElementById('hud-escape-banner');
    this.hudEscapeCounter = document.getElementById('hud-escape-counter');
    this.hudPowerupToast = document.getElementById('hud-powerup-toast');
    this.killFeed = document.getElementById('kill-feed');

    this.victoryScreenOverlay = document.getElementById('victory-screen-overlay');
    this.resultWinnerTitle = document.getElementById('result-winner-title');
    this.resultWinnerSubtitle = document.getElementById('result-winner-subtitle');
    this.xpCardLevel = document.getElementById('xp-card-level');
    this.xpCardTotalGained = document.getElementById('xp-card-total-gained');
    this.xpCardBarFill = document.getElementById('xp-card-bar-fill');
    this.xpCardProgressText = document.getElementById('xp-card-progress-text');
    this.xpCardBreakdown = document.getElementById('xp-card-breakdown');
    this.btnBackToLobby = document.getElementById('btn-back-to-lobby');
  }

  initStaticIcons() {
    if (this.btnLogout) {
      this.btnLogout.innerHTML = `${lucideIcon('log-out', 14)} <span>Sair</span>`;
    }
    if (this.btnCopyRoomLink) {
      this.btnCopyRoomLink.innerHTML = `${lucideIcon('link', 13)} <span>Copiar Link</span>`;
    }
    if (this.btnResetControls) {
      this.btnResetControls.innerHTML = `${lucideIcon('rotate-ccw', 14)} <span>Restaurar Padrão (WASD/Setas + Espaço + Tecla E)</span>`;
    }
  }

  setOnlineWidgetVisible(visible) {
    if (!this.onlineWidget) return;
    this.onlineWidget.classList.toggle('hidden', !visible);
  }

  updateOnlineCountUI(count, force = false) {
    if (!this.onlineCountText || typeof count !== 'number') return;
    const now = performance.now();
    if (!force && this.lastOnlineUiUpdateAt && now - this.lastOnlineUiUpdateAt < 4800) {
      return;
    }
    this.lastOnlineUiUpdateAt = now;
    this.onlineCountText.textContent = `Online: ${Math.max(1, count)}`;
  }

  startPingMonitor() {
    let lastPingColor = '';
    const measure = () => {
      if (document.hidden) return;
      if (!this.socket.connected) {
        if (this.pingText) this.pingText.textContent = 'Ping: offline';
        if (this.pingDot && lastPingColor !== '#ff3366') {
          lastPingColor = '#ff3366';
          this.pingDot.style.background = '#ff3366';
        }
        return;
      }
      const start = performance.now();
      this.socket.emit('ping:check', () => {
        const ms = Math.max(1, Math.round(performance.now() - start));
        if (this.pingText) this.pingText.textContent = `Ping: ${ms} ms`;
        if (this.pingDot) {
          const color = ms < 80 ? '#00e676' : ms < 160 ? '#ffd600' : '#ff3366';
          if (color !== lastPingColor) {
            lastPingColor = color;
            this.pingDot.style.background = color;
            this.pingDot.style.boxShadow = `0 0 8px ${color}`;
          }
        }
      });
    };

    setInterval(measure, 2000);
    this.socket.on('connect', () => {
      measure();
      if (this.currentUser) {
        this.socket.emit('user:identify', this.currentUser, (res) => {
          if (res?.onlineCount) this.updateOnlineCountUI(res.onlineCount);
        });
      }
    });
  }

  updateSoundButtonsUI() {
    const muted = this.soundManager.muted;
    if (this.btnToggleSound) {
      this.btnToggleSound.innerHTML = muted
        ? `${lucideIcon('volume-x', 14)} <span>Mudo</span>`
        : `${lucideIcon('volume-2', 14)} <span>Som</span>`;
    }
    if (this.btnHudSound) {
      this.btnHudSound.innerHTML = muted
        ? lucideIcon('volume-x', 15)
        : lucideIcon('volume-2', 15);
    }
  }

  bindAuthEvents() {
    this.tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.soundManager.playClick();
        this.tabButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.hideFeedback();

        const tab = btn.dataset.tab;
        this.formLogin.classList.toggle('hidden', tab !== 'login');
        this.formRegister.classList.toggle('hidden', tab !== 'register');
        this.formGuest.classList.toggle('hidden', tab !== 'guest');
      });
    });

    this.swatches.forEach((swatch) => {
      swatch.addEventListener('click', () => {
        this.soundManager.playClick();
        this.swatches.forEach((s) => s.classList.remove('active'));
        swatch.classList.add('active');
        this.selectedColor = swatch.dataset.color;
        this.bgScene.setHeroColor(this.selectedColor);
      });
    });

    this.formLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.soundManager.playClick();
      const emailOrUsername = document.getElementById('login-user').value.trim();
      const password = document.getElementById('login-pass').value;
      await this.authenticate('/api/auth/login', {
        emailOrUsername,
        password,
        skinColor: this.selectedColor
      });
    });

    this.formRegister.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.soundManager.playClick();
      const username = document.getElementById('reg-username').value.trim();
      const email = document.getElementById('reg-email').value.trim();
      const password = document.getElementById('reg-pass').value;
      await this.authenticate('/api/auth/register', {
        username,
        email,
        password,
        skinColor: this.selectedColor
      });
    });

    this.formGuest.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.soundManager.playClick();
      const username = document.getElementById('guest-username').value.trim();
      await this.authenticate('/api/auth/guest', {
        username,
        skinColor: this.selectedColor
      });
    });

    this.btnLogout.addEventListener('click', () => {
      this.soundManager.playClick();
      this.soundManager.stopLobbyMusic();
      localStorage.removeItem('shove_token');
      localStorage.removeItem('shove_user');
      this.socket.emit('room:leave');
      this.currentRoom = null;
      this.hideAndClearRoomChat();
      window.history.replaceState({}, '', '/');
      this.activeRoomPanel.classList.add('hidden');
      this.roomConfigWindow.classList.add('hidden');
      this.lobbyLayoutContainer.classList.remove('has-config-open');
      this.lobbyModeActions.classList.remove('hidden');
      this.lobbyLayoutContainer.classList.add('hidden');
      this.authCard.classList.remove('hidden');
    });
  }

  bindLobbyEvents() {
    if (this.btnToggleSound) {
      this.btnToggleSound.addEventListener('click', () => {
        this.soundManager.toggleMute();
        this.updateSoundButtonsUI();
      });
    }
    if (this.btnHudSound) {
      this.btnHudSound.addEventListener('click', () => {
        this.soundManager.toggleMute();
        this.updateSoundButtonsUI();
      });
    }

    this.lobbyTabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.soundManager.playClick();
        this.lobbyTabBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.dataset.lobbyTab;
        this.lobbyViewPlay.classList.toggle('hidden', target !== 'play');
        if (this.lobbyViewFriends) {
          this.lobbyViewFriends.classList.toggle('hidden', target !== 'friends');
        }
        this.lobbyViewSettings.classList.toggle('hidden', target !== 'settings');
        this.listeningControlAction = null;
        this.renderControlLabels();

        if (target === 'friends' && this.currentUser) {
          this.socket.emit('friends:get', { userId: this.currentUser.id });
        }
      });
    });

    this.btnPlayBR.addEventListener('click', () => {
      this.soundManager.playClick();
      this.hideLobbyFeedback();
      this.socket.emit('room:join_battleroyale', this.currentUser, (res) => {
        if (res?.error) {
          this.showLobbyFeedback(res.error, 'error');
          return;
        }
        if (res?.room) this.renderRoomState(res.room);
      });
    });

    this.btnCreateRoom.addEventListener('click', () => {
      this.soundManager.playClick();
      this.hideLobbyFeedback();
      this.socket.emit(
        'room:create_private',
        { playerProfile: this.currentUser },
        (res) => {
          if (res?.error) {
            this.showLobbyFeedback(res.error, 'error');
            return;
          }
          if (res?.room) this.renderRoomState(res.room);
        }
      );
    });

    const handleJoinRoom = () => {
      this.soundManager.playClick();
      this.hideLobbyFeedback();
      const code = this.inputRoomCode.value.trim().toUpperCase();
      if (!code) {
        this.showLobbyFeedback('Digite o código de 4 letras da sala para entrar!', 'error');
        return;
      }
      this.joinRoomByCode(code);
    };

    this.btnJoinRoom.addEventListener('click', handleJoinRoom);
    this.inputRoomCode.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleJoinRoom();
      }
    });

    if (this.btnCopyRoomLink) {
      this.btnCopyRoomLink.addEventListener('click', () => {
        if (!this.currentRoom) return;
        this.soundManager.playClick();
        const fullLink = `${window.location.origin}/room/${this.currentRoom.id}`;
        navigator.clipboard?.writeText(fullLink).catch(() => {});
        this.btnCopyRoomLink.innerHTML = `${lucideIcon('check', 13)} <span>Copiado!</span>`;
        setTimeout(() => {
          this.btnCopyRoomLink.innerHTML = `${lucideIcon('link', 13)} <span>Copiar Link</span>`;
        }, 2000);
      });
    }

    if (this.btnToggleReady) {
      this.btnToggleReady.addEventListener('click', () => {
        if (!this.currentRoom) return;
        this.soundManager.playClick();
        this.socket.emit('room:toggle_ready', { roomId: this.currentRoom.id }, (res) => {
          if (res?.error) this.showLobbyFeedback(res.error, 'error');
        });
      });
    }

    this.btnStartMatch.addEventListener('click', () => {
      this.soundManager.playClick();
      this.socket.emit('room:start', (res) => {
        if (res?.error) this.showLobbyFeedback(res.error, 'error');
      });
    });

    this.btnLeaveRoom.addEventListener('click', () => {
      this.soundManager.playClick();
      this.socket.emit('room:leave', () => {
        this.currentRoom = null;
        this.hideAndClearRoomChat();
        window.history.replaceState({}, '', '/');
        this.activeRoomPanel.classList.add('hidden');
        this.roomConfigWindow.classList.add('hidden');
        this.lobbyLayoutContainer.classList.remove('has-config-open');
        this.lobbyModeActions.classList.remove('hidden');
      });
    });

    this.btnQuitMatch.addEventListener('click', () => {
      this.soundManager.playClick();
      this.socket.emit('room:leave');
      window.history.replaceState({}, '', '/');
      this.currentRoom = null;
      this.hideAndClearRoomChat();
      this.exitMatchToLobby();
    });

    this.btnBackToLobby.addEventListener('click', () => {
      this.soundManager.playClick();
      this.victoryScreenOverlay.classList.add('hidden');
      this.exitMatchToLobby();
    });
  }

  /**
   * Eventos da Aba de Amigos: verifica no banco antes de enviar convite e exige aprovação.
   */
  bindFriendsEvents() {
    if (!this.formAddFriend) return;

    this.formAddFriend.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!this.currentUser) return;
      this.soundManager.playClick();

      const targetNickname = (this.inputFriendNickname.value || '').trim();
      if (!targetNickname) {
        this.showFriendsFeedback('Digite o nickname do jogador!', 'error');
        return;
      }

      this.socket.emit(
        'friends:request',
        {
          fromUserId: this.currentUser.id,
          targetNickname
        },
        (res) => {
          if (res?.error) {
            this.showFriendsFeedback(res.error, 'error');
            return;
          }
          this.inputFriendNickname.value = '';
          this.showFriendsFeedback(
            res?.message || 'Solicitação de amizade enviada! Aguardando aprovação.',
            'success'
          );
        }
      );
    });
  }

  showFriendsFeedback(msg, type = 'error') {
    if (!this.friendsFeedback) return;
    this.friendsFeedback.textContent = msg;
    this.friendsFeedback.className = `feedback-msg ${type}`;
  }

  renderFriendsState({ friends = [], friendRequests = [] } = {}) {
    if (this.friendsPendingBadge) {
      this.friendsPendingBadge.textContent = String(friendRequests.length);
      this.friendsPendingBadge.classList.toggle('hidden', friendRequests.length === 0);
    }

    // 1. Solicitações de Amizade Pendentes (para o usuário aprovar ou recusar)
    if (this.friendRequestsBox && this.friendRequestsList) {
      this.friendRequestsBox.classList.toggle('hidden', friendRequests.length === 0);
      this.friendRequestsList.innerHTML = '';

      if (friendRequests.length > 0) {
        const reqFrag = document.createDocumentFragment();
        friendRequests.forEach((req) => {
          const li = document.createElement('li');
          li.className = 'join-req-item';

          const leftInfo = document.createElement('div');
          leftInfo.className = 'player-left-info';
          leftInfo.innerHTML = `
            <span class="dot" style="background:${req.fromSkinColor || '#FF3366'}"></span>
            <span class="player-name-truncate">${req.fromUsername}</span>
            <span class="player-level-tag">Nv. ${req.fromLevel || 1}</span>
          `;

          const btnsDiv = document.createElement('div');
          btnsDiv.className = 'join-req-btns';

          const btnAccept = document.createElement('button');
          btnAccept.type = 'button';
          btnAccept.className = 'btn-req-accept';
          btnAccept.innerHTML = `${lucideIcon('user-check', 12)} <span>Aceitar</span>`;
          btnAccept.addEventListener('click', () => {
            this.soundManager.playClick();
            this.socket.emit(
              'friends:respond',
              {
                userId: this.currentUser?.id,
                fromUserId: req.fromUserId,
                accept: true
              },
              (res) => {
                if (res?.message) this.showFriendsFeedback(res.message, 'success');
              }
            );
          });

          const btnReject = document.createElement('button');
          btnReject.type = 'button';
          btnReject.className = 'btn-req-reject';
          btnReject.innerHTML = `${lucideIcon('user-x', 12)} <span>Recusar</span>`;
          btnReject.addEventListener('click', () => {
            this.soundManager.playClick();
            this.socket.emit('friends:respond', {
              userId: this.currentUser?.id,
              fromUserId: req.fromUserId,
              accept: false
            });
          });

          btnsDiv.appendChild(btnAccept);
          btnsDiv.appendChild(btnReject);
          li.appendChild(leftInfo);
          li.appendChild(btnsDiv);
          reqFrag.appendChild(li);
        });
        this.friendRequestsList.appendChild(reqFrag);
      }
    }

    // 2. Lista de Amigos aprovados (Mostra Nome + Nível ao lado do nome)
    if (this.friendsCountBadge) {
      this.friendsCountBadge.textContent = `${friends.length} ${friends.length === 1 ? 'amigo' : 'amigos'}`;
    }
    if (!this.friendsList) return;

    this.friendsList.innerHTML = '';
    if (friends.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty-rooms-msg';
      li.textContent = 'Nenhum amigo adicionado ainda. Envie um convite acima!';
      this.friendsList.appendChild(li);
      return;
    }

    const frag = document.createDocumentFragment();
    friends.forEach((f) => {
      const li = document.createElement('li');
      li.className = 'public-room-item';

      const metaDiv = document.createElement('div');
      metaDiv.className = 'public-room-meta';
      const statusText = f.online
        ? f.roomId
          ? `Online • Na Sala #${f.roomId}`
          : 'Online no Lobby'
        : 'Offline';

      metaDiv.innerHTML = `
        <strong>
          <span class="dot" style="width:9px;height:9px;border-radius:50%;display:inline-block;background:${f.skinColor || '#00E5FF'}"></span>
          <span class="player-name-truncate">${f.username}</span>
          <span class="player-level-tag">Nv. ${f.level || 1}</span>
        </strong>
        <span>${statusText}</span>
      `;

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'join-req-btns';

      if (f.online && f.roomId) {
        const joinBtn = document.createElement('button');
        joinBtn.type = 'button';
        joinBtn.className = 'btn-room-action open';
        joinBtn.innerHTML = `${lucideIcon('gamepad-2', 12)} <span>Seguir</span>`;
        joinBtn.addEventListener('click', () => {
          this.soundManager.playClick();
          this.lobbyTabBtns.forEach((b) => {
            b.classList.toggle('active', b.dataset.lobbyTab === 'play');
          });
          this.lobbyViewPlay.classList.remove('hidden');
          this.lobbyViewFriends.classList.add('hidden');
          this.joinRoomByCode(f.roomId);
        });
        actionsDiv.appendChild(joinBtn);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-kick-player';
      removeBtn.title = `Remover ${f.username}`;
      removeBtn.innerHTML = lucideIcon('trash-2', 12);
      removeBtn.addEventListener('click', () => {
        this.soundManager.playClick();
        this.socket.emit('friends:remove', {
          userId: this.currentUser?.id,
          friendUserId: f.userId
        });
      });
      actionsDiv.appendChild(removeBtn);

      li.appendChild(metaDiv);
      li.appendChild(actionsDiv);
      frag.appendChild(li);
    });

    this.friendsList.appendChild(frag);
  }

  joinRoomByCode(code) {
    this.hideLobbyFeedback();
    this.socket.emit(
      'room:join_private',
      { roomId: code, playerProfile: this.currentUser },
      (res) => {
        if (res?.error) {
          this.showLobbyFeedback(res.error, 'error');
          window.history.replaceState({}, '', '/');
          return;
        }
        if (res?.pendingApproval) {
          this.showLobbyFeedback(res.message, 'success');
          return;
        }
        if (res?.room) this.renderRoomState(res.room);
      }
    );
  }

  renderPublicRoomsList(roomsList = []) {
    if (!this.publicRoomsList || !this.publicRoomsCount) return;

    this.publicRoomsCount.textContent = `${roomsList.length} ${roomsList.length === 1 ? 'sala' : 'salas'}`;
    this.publicRoomsList.innerHTML = '';

    if (roomsList.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty-rooms-msg';
      li.textContent = 'Nenhuma sala criada no momento. Crie uma acima!';
      this.publicRoomsList.appendChild(li);
      return;
    }

    const frag = document.createDocumentFragment();

    roomsList.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'public-room-item';

      const modeText = r.teamSize === 1 ? 'Solo' : `Times de ${r.teamSize}`;
      const metaDiv = document.createElement('div');
      metaDiv.className = 'public-room-meta';
      metaDiv.innerHTML = `
        <strong>
          #${r.id} • ${lucideIcon('crown', 12)}
          <span class="player-name-truncate">${r.hostName}</span>
          <span class="player-level-tag">Nv. ${r.hostLevel || 1}</span>
        </strong>
        <span>${r.playersCount}/${r.maxPlayers} Jogadores • ${modeText} • ${r.totalRounds || 3} Rounds</span>
      `;

      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = `btn-room-action ${r.isOpenJoin ? 'open' : 'request'}`;
      actionBtn.innerHTML = r.isOpenJoin
        ? `${lucideIcon('unlock', 12)} <span>Entrar</span>`
        : `${lucideIcon('hand', 12)} <span>Pedir</span>`;

      actionBtn.addEventListener('click', () => {
        this.soundManager.playClick();
        this.joinRoomByCode(r.id);
      });

      li.appendChild(metaDiv);
      li.appendChild(actionBtn);
      frag.appendChild(li);
    });

    this.publicRoomsList.appendChild(frag);
  }

  bindRoomConfigWindowEvents() {
    const sendConfigUpdate = (patch) => {
      if (!this.currentRoom || this.currentRoom.hostId !== this.socket.id) return;
      this.soundManager.playClick();
      this.socket.emit(
        'room:update_config',
        { roomId: this.currentRoom.id, ...patch },
        (res) => {
          if (res?.error) this.showLobbyFeedback(res.error, 'error');
        }
      );
    };

    if (this.cfgOpenJoinToggle) {
      this.cfgOpenJoinToggle.addEventListener('change', () => {
        sendConfigUpdate({ isOpenJoin: this.cfgOpenJoinToggle.checked });
      });
    }

    if (this.btnRoundsMinus) {
      this.btnRoundsMinus.addEventListener('click', () => {
        if (!this.currentRoom) return;
        const nextRounds = Math.max(1, (this.currentRoom.totalRounds || 3) - 1);
        sendConfigUpdate({ totalRounds: nextRounds });
      });
    }
    if (this.btnRoundsPlus) {
      this.btnRoundsPlus.addEventListener('click', () => {
        if (!this.currentRoom) return;
        const nextRounds = Math.min(10, (this.currentRoom.totalRounds || 3) + 1);
        sendConfigUpdate({ totalRounds: nextRounds });
      });
    }

    this.roomSizePills.forEach((pill) => {
      pill.addEventListener('click', () => {
        sendConfigUpdate({ teamSize: Number(pill.dataset.size) || 1 });
      });
    });

    if (this.roomFfToggle) {
      this.roomFfToggle.addEventListener('change', () => {
        sendConfigUpdate({ friendlyFire: this.roomFfToggle.checked });
      });
    }

    this.cfgSpeedPills.forEach((pill) => {
      pill.addEventListener('click', () => {
        sendConfigUpdate({ playerSpeedMultiplier: Number(pill.dataset.speed) || 1.0 });
      });
    });

    this.cfgDurationPills.forEach((pill) => {
      pill.addEventListener('click', () => {
        sendConfigUpdate({ matchDuration: Number(pill.dataset.duration) || 150 });
      });
    });

    if (this.btnBotsMinus) {
      this.btnBotsMinus.addEventListener('click', () => {
        if (!this.currentRoom) return;
        const nextBots = Math.max(0, (this.currentRoom.botCount || 0) - 1);
        sendConfigUpdate({ botCount: nextBots });
      });
    }
    if (this.btnBotsPlus) {
      this.btnBotsPlus.addEventListener('click', () => {
        if (!this.currentRoom) return;
        const nextBots = Math.min(14, (this.currentRoom.botCount || 0) + 1);
        sendConfigUpdate({ botCount: nextBots });
      });
    }

    if (this.btnMapsAll) {
      this.btnMapsAll.addEventListener('click', () => {
        if (!this.currentRoom || !Array.isArray(this.currentRoom.allMapsCatalog)) return;
        sendConfigUpdate({
          selectedMapIds: this.currentRoom.allMapsCatalog.map((m) => m.id)
        });
      });
    }

    if (this.btnMapsNone) {
      this.btnMapsNone.addEventListener('click', () => {
        if (!this.currentRoom) return;
        sendConfigUpdate({ selectedMapIds: [] });
      });
    }

    if (this.cfgMapsSearch) {
      this.cfgMapsSearch.addEventListener('input', () => {
        if (this.currentRoom) this.renderMapsCatalogChecklist(this.currentRoom);
      });
    }

    if (this.btnPowerupsAll) {
      this.btnPowerupsAll.addEventListener('click', () => {
        if (!this.currentRoom || !Array.isArray(this.currentRoom.allPowerupsCatalog)) return;
        sendConfigUpdate({
          selectedPowerupIds: this.currentRoom.allPowerupsCatalog.map((p) => p.id || p.type)
        });
      });
    }

    if (this.btnPowerupsNone) {
      this.btnPowerupsNone.addEventListener('click', () => {
        if (!this.currentRoom) return;
        sendConfigUpdate({ selectedPowerupIds: [] });
      });
    }

    if (this.cfgPowerupsSearch) {
      this.cfgPowerupsSearch.addEventListener('input', () => {
        if (this.currentRoom) this.renderPowerupsCatalogChecklist(this.currentRoom);
      });
    }

    this.cfgSpawnPills.forEach((pill) => {
      pill.addEventListener('click', () => {
        sendConfigUpdate({ powerupSpawnInterval: Number(pill.dataset.spawn) || 15 });
      });
    });
  }

  bindSettingsEvents() {
    this.bindKeyButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.soundManager.playClick();
        const action = btn.dataset.action;
        this.listeningControlAction = action;
        this.renderControlLabels();
        btn.textContent = 'Aperte tecla...';
        btn.classList.add('listening');
      });

      btn.addEventListener('mousedown', (e) => {
        if (!this.listeningControlAction) return;
        e.preventDefault();
        e.stopPropagation();
        const mouseCode = `Mouse${e.button}`;
        this.controlsConfig.setBinding(this.listeningControlAction, mouseCode);
        this.listeningControlAction = null;
        this.renderControlLabels();
        this.soundManager.playClick();
      });
    });

    window.addEventListener('keydown', (e) => {
      if (!this.listeningControlAction) return;
      e.preventDefault();
      if (e.code === 'Escape') {
        this.listeningControlAction = null;
        this.renderControlLabels();
        return;
      }
      this.controlsConfig.setBinding(this.listeningControlAction, e.code);
      this.listeningControlAction = null;
      this.renderControlLabels();
      this.soundManager.playClick();
    });

    this.btnResetControls.addEventListener('click', () => {
      this.controlsConfig.resetToDefaults();
      this.listeningControlAction = null;
      this.renderControlLabels();
      this.soundManager.playClick();
      this.showLobbyFeedback('Controles restaurados para o padrão!', 'success');
    });
  }

  renderControlLabels() {
    this.bindKeyButtons.forEach((btn) => {
      const action = btn.dataset.action;
      btn.classList.remove('listening');
      const code = this.controlsConfig.bindings[action];
      btn.textContent = ControlsConfig.formatKeyLabel(code);
    });
  }

  bindSocketEvents() {
    this.socket.on('server:online_count', ({ onlineCount }) => {
      this.updateOnlineCountUI(onlineCount);
    });

    this.socket.on('friends:updated', (data) => {
      this.renderFriendsState(data);
    });

    this.socket.on('rooms:list', (list) => {
      this.renderPublicRoomsList(list);
    });

    this.socket.on('room:update', (room) => {
      this.renderRoomState(room);
    });

    this.socket.on('room:join_accepted', ({ room }) => {
      this.soundManager.playClick();
      this.hideLobbyFeedback();
      this.renderRoomState(room);
    });

    this.socket.on('room:join_rejected', ({ reason }) => {
      this.showLobbyFeedback(reason || 'Solicitação recusada pelo criador da sala.', 'error');
    });

    this.socket.on('room:kicked', ({ reason }) => {
      this.currentRoom = null;
      this.hideAndClearRoomChat();
      window.history.replaceState({}, '', '/');
      this.activeRoomPanel.classList.add('hidden');
      this.roomConfigWindow.classList.add('hidden');
      this.lobbyLayoutContainer.classList.remove('has-config-open');
      this.lobbyModeActions.classList.remove('hidden');
      this.showLobbyFeedback(reason || 'Você foi expulso da sala pelo criador.', 'error');
    });

    this.socket.on('room:chat_message', ({ roomId, message }) => {
      if (!this.currentRoom || this.currentRoom.id !== roomId || !message) return;
      if (!Array.isArray(this.currentRoom.chatHistory)) {
        this.currentRoom.chatHistory = [];
      }
      const alreadyExists = this.currentRoom.chatHistory.some((m) => m.id === message.id);
      if (!alreadyExists) {
        this.currentRoom.chatHistory.push(message);
      }
      this.appendChatMessageToDOM(message);
    });

    this.socket.on('room:br_countdown', (data) => {
      if (!this.brCountdownBanner) return;
      this.brCountdownBanner.classList.remove('hidden');
      this.brTimerSeconds.textContent = `${data.countdown}s`;
      this.brQuorumText.textContent = `Reais: ${data.realPlayers}/${data.minRealPlayers} mín.`;
      const pct = Math.min(100, Math.round((data.realPlayers / data.minRealPlayers) * 100));
      this.brProgressFill.style.width = `${pct}%`;
    });

    this.socket.on('room:cancelled', ({ reason }) => {
      this.currentRoom = null;
      this.hideAndClearRoomChat();
      window.history.replaceState({}, '', '/');
      this.activeRoomPanel.classList.add('hidden');
      this.roomConfigWindow.classList.add('hidden');
      this.lobbyLayoutContainer.classList.remove('has-config-open');
      this.lobbyModeActions.classList.remove('hidden');
      this.showLobbyFeedback(reason || 'Partida cancelada por falta de jogadores.', 'error');
    });

    this.socket.on('room:started', ({ room, map, currentRound, totalRounds }) => {
      this.currentRoom = room;
      this.soundManager.stopLobbyMusic();
      this.soundManager.playClick();
      this.enterMatchArena(room, map, currentRound, totalRounds);
    });

    this.socket.on('match:map_presentation', ({ currentRound, totalRounds, map, durationMs }) => {
      if (!this.mapPresentationOverlay) return;
      this.bigCountdownOverlay.classList.add('hidden');
      this.presentationRoundBadge.textContent = `ROUND ${currentRound || 1} DE ${totalRounds || 3}`;
      this.presentationMapTitle.textContent = map?.name || 'Arena Shove.io';
      this.presentationMapPeculiarity.textContent =
        map?.description || 'Prepare-se para jogar seus rivais para fora!';
      this.mapPresentationOverlay.classList.remove('hidden');

      clearTimeout(this.mapIntroTimer);
      this.mapIntroTimer = setTimeout(() => {
        this.mapPresentationOverlay.classList.add('hidden');
      }, durationMs || 3500);
    });

    this.socket.on('match:pre_countdown', ({ count, text }) => {
      if (!this.bigCountdownOverlay) return;
      this.mapPresentationOverlay.classList.add('hidden');
      this.bigCountdownOverlay.classList.remove('hidden');
      this.bigCountdownText.textContent = text;

      const isShove = count === 0;
      this.soundManager.playCountdownBeep(isShove);

      if (isShove) {
        clearTimeout(this.countdownHideTimer);
        this.countdownHideTimer = setTimeout(() => {
          this.bigCountdownOverlay.classList.add('hidden');
        }, 900);
      }
    });

    this.socket.on('match:round_ended', ({ currentRound, totalRounds, roundWinnerName }) => {
      this.showPowerupToast(
        `Fim do Round ${currentRound}/${totalRounds}! Vencedor: ${roundWinnerName}`
      );
    });

    // Evento de salto nos 5 trampolins do mapa Circo Saltitante
    this.socket.on('match:trampoline_jump', (jumpData) => {
      this.soundManager.playTrampolineJump();
      this.gameScene.onTrampolineJump(jumpData);
    });

    // Evento de nocaute de 2 segundos da Luva de Boxe
    this.socket.on('match:knockout_fx', (koData) => {
      this.soundManager.playBoxingKnockout();
      this.gameScene.spawnShockwave({ x: koData.x, z: koData.z, power: 1.25, isMega: true });
      if (koData.targetId === this.socket.id) {
        this.showPowerupToast(`NOCAUTE! ${koData.attackerName} derrubou você por 2s!`);
      } else if (koData.attackerId === this.socket.id) {
        this.showPowerupToast(`NOCAUTE! Você derrubou ${koData.targetName} por 2s!`);
      }
    });

    this.socket.on('match:state', (state) => {
      this.gameScene.onServerState(state);

      if (this.hudRoundPill && state.currentRound && state.totalRounds) {
        const roundKey = `${state.currentRound}/${state.totalRounds}`;
        if (roundKey !== this.hudCache.roundKey) {
          this.hudCache.roundKey = roundKey;
          this.hudRoundPill.innerHTML = `${lucideIcon('trophy', 13)} <span>Round ${roundKey}</span>`;
        }
      }

      if (typeof state.timeRemaining === 'number' && this.hudTimerPill) {
        if (state.timeRemaining !== this.hudCache.timeRemaining) {
          this.hudCache.timeRemaining = state.timeRemaining;
          const mins = String(Math.floor(state.timeRemaining / 60)).padStart(2, '0');
          const secs = String(state.timeRemaining % 60).padStart(2, '0');
          this.hudTimerPill.innerHTML = `${lucideIcon('clock', 13)} <span>${mins}:${secs}</span>`;
        }
      }

      if (this.hudPowerupTimerPill) {
        const powerupKey =
          state.powerupsEnabled === false ? 'OFF' : String(state.nextPowerupIn ?? '');
        if (powerupKey !== this.hudCache.powerupKey) {
          this.hudCache.powerupKey = powerupKey;
          if (state.powerupsEnabled === false) {
            this.hudPowerupTimerPill.innerHTML = `${lucideIcon('gift', 13)} <span>Power-Ups: OFF</span>`;
          } else if (typeof state.nextPowerupIn === 'number') {
            this.hudPowerupTimerPill.innerHTML = `${lucideIcon('gift', 13)} <span>Power-Up: ${state.nextPowerupIn}s</span>`;
          }
        }
      }

      if (state && Array.isArray(state.players)) {
        let aliveCount = 0;
        let me = null;
        const myId = this.socket.id;

        for (let i = 0; i < state.players.length; i++) {
          const p = state.players[i];
          if (p.alive) aliveCount++;
          if (p.id === myId) me = p;
        }

        if (aliveCount !== this.hudCache.aliveCount && this.hudAlivePill) {
          this.hudCache.aliveCount = aliveCount;
          this.hudAlivePill.innerHTML = `${lucideIcon('flame', 13)} <span>${aliveCount} Vivos</span>`;
        }

        const isGrabbed = Boolean(me && me.grabbedById);
        const escapePresses = me ? me.escapePresses || 0 : 0;

        if (isGrabbed !== this.hudCache.isGrabbed) {
          this.hudCache.isGrabbed = isGrabbed;
          this.hudEscapeBanner.classList.toggle('hidden', !isGrabbed);
        }
        if (isGrabbed && escapePresses !== this.hudCache.escapePresses) {
          this.hudCache.escapePresses = escapePresses;
          this.hudEscapeCounter.textContent = `${escapePresses}/5`;
        }
      }
    });

    this.socket.on('match:shove_fx', (fxData) => {
      this.gameScene.spawnShockwave(fxData);
      if (fxData.isMega) {
        this.soundManager.playMegaShove();
      } else {
        this.soundManager.playShove(fxData.power);
      }
    });

    this.socket.on('match:grabbed', ({ victimId }) => {
      this.soundManager.playGrab();
      if (victimId === this.socket.id) {
        this.hudCache.isGrabbed = true;
        this.hudCache.escapePresses = 0;
        this.hudEscapeBanner.classList.remove('hidden');
        this.hudEscapeCounter.textContent = `0/5`;
      }
    });

    this.socket.on('match:escape_progress', ({ victimId, presses, required }) => {
      if (victimId === this.socket.id) {
        this.hudCache.escapePresses = presses;
        this.hudEscapeCounter.textContent = `${presses}/${required}`;
      }
    });

    this.socket.on('match:escaped', () => {
      this.soundManager.playEscapeStun();
      this.hudCache.isGrabbed = false;
      this.hudEscapeBanner.classList.add('hidden');
    });

    this.socket.on('match:thrown', (data) => {
      this.gameScene.spawnShockwave({ x: data.x, z: data.z, power: data.power });
      this.soundManager.playShove(data.power);
    });

    this.socket.on('match:powerup_spawned', () => {
      this.soundManager.playPowerupSpawn();
    });

    this.socket.on('match:powerup_collected', ({ powerupName, playerId }) => {
      this.soundManager.playPowerupPickup();
      if (playerId === this.socket.id) {
        this.showPowerupToast(`Você pegou: ${powerupName}!`);
      }
    });

    this.socket.on('match:shock_fx', (shockData) => {
      this.soundManager.playShock();
      this.gameScene.spawnLightningBolt(shockData);
    });

    // No celular, não exibe o feedback de usuários eliminados
    this.socket.on('match:eliminated', ({ victimName, killerName }) => {
      this.soundManager.playFall();
      if (this.isMobileDevice()) return;
      this.pushKillFeedItem(
        killerName
          ? `${killerName} eliminou ${victimName}!`
          : `${victimName} foi eliminado!`
      );
    });

    this.socket.on('match:ended', (result) => {
      this.soundManager.playVictory();
      this.showFullVictoryScreen(result);
    });
  }

  pushKillFeedItem(text) {
    if (!this.killFeed || this.isMobileDevice()) return;
    const div = document.createElement('div');
    div.className = 'kill-item icon-text-inline';
    div.innerHTML = `${lucideIcon('swords', 13)} <span>${text}</span>`;
    this.killFeed.prepend(div);
    setTimeout(() => div.remove(), 4500);
  }

  showPowerupToast(text) {
    if (!this.hudPowerupToast) return;
    this.hudPowerupToast.innerHTML = `${lucideIcon('sparkles', 14)} <span>${text}</span>`;
    this.hudPowerupToast.classList.remove('hidden');
    clearTimeout(this.powerupToastTimer);
    this.powerupToastTimer = setTimeout(() => {
      this.hudPowerupToast.classList.add('hidden');
    }, 3200);
  }

  renderMapsCatalogChecklist(room) {
    if (!this.cfgMapsChecklist || !room || !Array.isArray(room.allMapsCatalog)) return;
    const isHost = room.hostId === this.socket.id;
    const selectedIds = Array.isArray(room.selectedMapIds) ? room.selectedMapIds : [];
    const totalCount = room.allMapsCatalog.length;

    if (this.cfgMapsModeHint) {
      this.cfgMapsModeHint.innerHTML = `${lucideIcon('map', 12)} <span>${selectedIds.length}/${totalCount} selecionados</span>`;
    }
    if (this.btnMapsAll) this.btnMapsAll.disabled = !isHost;
    if (this.btnMapsNone) this.btnMapsNone.disabled = !isHost;

    const query = (this.cfgMapsSearch?.value || '').trim().toLowerCase();
    const filteredMaps = query
      ? room.allMapsCatalog.filter((m) => m.name.toLowerCase().includes(query))
      : room.allMapsCatalog;

    this.cfgMapsChecklist.innerHTML = '';
    const mapFrag = document.createDocumentFragment();

    filteredMaps.forEach((m) => {
      const isSelected = selectedIds.includes(m.id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `map-check-btn ${isSelected ? 'selected' : ''}`;
      btn.disabled = !isHost;
      btn.title = m.description || m.name;
      btn.innerHTML = `${lucideIcon(isSelected ? 'check-square' : 'square', 14)} <span>${m.name}</span>`;

      btn.addEventListener('click', () => {
        if (!isHost) return;
        const nextIds = isSelected
          ? selectedIds.filter((id) => id !== m.id)
          : [...selectedIds, m.id];
        this.soundManager.playClick();
        this.socket.emit('room:update_config', {
          roomId: room.id,
          selectedMapIds: nextIds
        });
      });

      mapFrag.appendChild(btn);
    });

    this.cfgMapsChecklist.appendChild(mapFrag);
  }

  renderPowerupsCatalogChecklist(room) {
    if (!this.cfgPowerupsChecklist || !room) return;
    const isHost = room.hostId === this.socket.id;
    const catalog = Array.isArray(room.allPowerupsCatalog) ? room.allPowerupsCatalog : [];
    const selectedIds = Array.isArray(room.selectedPowerupIds)
      ? room.selectedPowerupIds
      : catalog.map((p) => p.id || p.type);
    const totalCount = catalog.length;

    if (this.cfgPowerupsState) {
      this.cfgPowerupsState.innerHTML = `${lucideIcon('sparkles', 12)} <span>${selectedIds.length}/${totalCount} selecionados</span>`;
    }
    if (this.btnPowerupsAll) this.btnPowerupsAll.disabled = !isHost;
    if (this.btnPowerupsNone) this.btnPowerupsNone.disabled = !isHost;

    const query = (this.cfgPowerupsSearch?.value || '').trim().toLowerCase();
    const filteredPowerups = query
      ? catalog.filter((p) => p.name.toLowerCase().includes(query))
      : catalog;

    this.cfgPowerupsChecklist.innerHTML = '';
    const pwrFrag = document.createDocumentFragment();

    filteredPowerups.forEach((p) => {
      const pId = p.id || p.type;
      const isSelected = selectedIds.includes(pId);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `map-check-btn ${isSelected ? 'selected' : ''}`;
      btn.disabled = !isHost;
      btn.innerHTML = `${lucideIcon(isSelected ? 'check-square' : 'square', 14)} <span>${p.name}</span>`;

      btn.addEventListener('click', () => {
        if (!isHost) return;
        const nextIds = isSelected
          ? selectedIds.filter((id) => id !== pId)
          : [...selectedIds, pId];
        this.soundManager.playClick();
        this.socket.emit('room:update_config', {
          roomId: room.id,
          selectedPowerupIds: nextIds
        });
      });

      pwrFrag.appendChild(btn);
    });

    this.cfgPowerupsChecklist.appendChild(pwrFrag);
  }

  renderRoomState(room) {
    if (!room) return;
    this.currentRoom = room;
    this.setOnlineWidgetVisible(true);
    this.syncRoomChatFromRoom(room, false);

    const isHost = room.hostId === this.socket.id;
    const isPrivate = room.mode === 'PRIVATE';

    if (isPrivate) {
      window.history.replaceState({}, '', `/room/${room.id}`);
      if (this.roomShareUrl) {
        this.roomShareUrl.textContent = `${window.location.origin}/room/${room.id}`;
      }
    }

    this.lobbyModeActions.classList.add('hidden');
    this.activeRoomPanel.classList.remove('hidden');
    this.roomConfigWindow.classList.toggle('hidden', !isPrivate);
    this.lobbyLayoutContainer.classList.toggle('has-config-open', isPrivate);

    this.roomCodeDisplay.textContent = room.id;
    this.roomModeDisplay.innerHTML =
      room.teamSize === 1
        ? `${lucideIcon('user', 13)} <span>Solo</span>`
        : `${lucideIcon('users', 13)} <span>Times de ${room.teamSize}</span>`;
    this.roomCountDisplay.textContent = `${room.players.length}/${room.maxPlayers} Jogadores`;

    if (room.teamSize > 1) {
      this.roomFfBadge.innerHTML = room.friendlyFire
        ? `${lucideIcon('flame', 12)} <span>Fogo Amigo: ON</span>`
        : `${lucideIcon('shield', 12)} <span>Fogo Amigo: OFF</span>`;
    } else {
      this.roomFfBadge.innerHTML = `${lucideIcon('swords', 12)} <span>Todos contra Todos</span>`;
    }

    if (this.roomRoundsBadge) {
      this.roomRoundsBadge.innerHTML = `${lucideIcon('trophy', 12)} <span>${room.totalRounds || 3} Rounds</span>`;
    }
    if (this.roomAccessBadge) {
      this.roomAccessBadge.innerHTML = room.isOpenJoin
        ? `${lucideIcon('unlock', 12)} <span>Entrada Livre</span>`
        : `${lucideIcon('lock', 12)} <span>Por Solicitação</span>`;
    }

    this.brCountdownBanner.classList.toggle('hidden', room.mode !== 'BATTLEROYALE');

    if (this.joinRequestsBox && this.joinRequestsList) {
      const requests = Array.isArray(room.joinRequests) ? room.joinRequests : [];
      const showRequests = isHost && isPrivate && requests.length > 0;
      this.joinRequestsBox.classList.toggle('hidden', !showRequests);

      if (showRequests) {
        this.joinRequestsList.innerHTML = '';
        const reqFrag = document.createDocumentFragment();
        requests.forEach((req) => {
          const li = document.createElement('li');
          li.className = 'join-req-item';
          li.innerHTML = `
            <span class="player-left-info">
              ${lucideIcon('hand', 13)}
              <span class="player-name-truncate">${req.username}</span>
              <span class="player-level-tag">Nv. ${req.level || 1}</span>
            </span>
          `;

          const btnsDiv = document.createElement('div');
          btnsDiv.className = 'join-req-btns';

          const btnAccept = document.createElement('button');
          btnAccept.type = 'button';
          btnAccept.className = 'btn-req-accept';
          btnAccept.innerHTML = `${lucideIcon('check', 12)} <span>Aceitar</span>`;
          btnAccept.addEventListener('click', () => {
            this.soundManager.playClick();
            this.socket.emit('room:respond_join', {
              roomId: room.id,
              requesterSocketId: req.socketId,
              accept: true
            });
          });

          const btnReject = document.createElement('button');
          btnReject.type = 'button';
          btnReject.className = 'btn-req-reject';
          btnReject.innerHTML = `${lucideIcon('x', 12)} <span>Recusar</span>`;
          btnReject.addEventListener('click', () => {
            this.soundManager.playClick();
            this.socket.emit('room:respond_join', {
              roomId: room.id,
              requesterSocketId: req.socketId,
              accept: false
            });
          });

          btnsDiv.appendChild(btnAccept);
          btnsDiv.appendChild(btnReject);
          li.appendChild(btnsDiv);
          reqFrag.appendChild(li);
        });
        this.joinRequestsList.appendChild(reqFrag);
      }
    }

    if (isPrivate) {
      if (this.configHostTag) {
        this.configHostTag.classList.toggle('hidden', !isHost);
        this.configHostTag.innerHTML = `${lucideIcon('crown', 12)} <span>Criador da Sala</span>`;
      }
      if (this.configWindowSub) {
        this.configWindowSub.textContent = isHost
          ? 'Como você quer criar sua sala?'
          : 'A partida seguirá as configurações abaixo';
      }

      if (this.cfgOpenJoinToggle) {
        this.cfgOpenJoinToggle.checked = Boolean(room.isOpenJoin);
        this.cfgOpenJoinToggle.disabled = !isHost;
      }
      if (this.cfgOpenJoinState) {
        this.cfgOpenJoinState.textContent = room.isOpenJoin ? 'SIM (Aberta)' : 'NÃO (Pedir)';
      }

      if (this.cfgRoundsValue) {
        this.cfgRoundsValue.textContent = String(room.totalRounds || 3);
      }
      if (this.btnRoundsMinus) this.btnRoundsMinus.disabled = !isHost;
      if (this.btnRoundsPlus) this.btnRoundsPlus.disabled = !isHost;

      this.roomSizePills.forEach((pill) => {
        pill.classList.toggle('active', Number(pill.dataset.size) === room.teamSize);
        pill.disabled = !isHost;
      });

      this.roomFfRow.classList.toggle('hidden', room.teamSize <= 1);
      this.roomFfToggle.checked = Boolean(room.friendlyFire);
      this.roomFfToggle.disabled = !isHost;
      this.roomFfStateLabel.textContent = room.friendlyFire ? 'SIM' : 'NÃO';

      this.renderMapsCatalogChecklist(room);
      this.renderPowerupsCatalogChecklist(room);

      this.cfgSpeedPills.forEach((pill) => {
        pill.classList.toggle(
          'active',
          Math.abs(Number(pill.dataset.speed) - (room.playerSpeedMultiplier || 1.0)) < 0.05
        );
        pill.disabled = !isHost;
      });

      this.cfgDurationPills.forEach((pill) => {
        pill.classList.toggle('active', Number(pill.dataset.duration) === (room.matchDuration || 150));
        pill.disabled = !isHost;
      });

      this.cfgBotsValue.textContent = String(room.botCount ?? 0);
      this.btnBotsMinus.disabled = !isHost;
      this.btnBotsPlus.disabled = !isHost;

      const selectedPwrIds = Array.isArray(room.selectedPowerupIds) ? room.selectedPowerupIds : [];
      const pwrEnabled = room.powerupsEnabled !== false && selectedPwrIds.length > 0;
      if (this.cfgPowerupIntervalBlock) {
        this.cfgPowerupIntervalBlock.classList.toggle('hidden', !pwrEnabled);
      }

      this.cfgSpawnPills.forEach((pill) => {
        pill.classList.toggle(
          'active',
          Number(pill.dataset.spawn) === (room.powerupSpawnInterval || 15)
        );
        pill.disabled = !isHost;
      });
    }

    if (room.teamSize > 1 && Array.isArray(room.availableTeams)) {
      this.teamPickerBox.classList.remove('hidden');
      this.teamButtonsGrid.innerHTML = '';
      const teamFrag = document.createDocumentFragment();

      const myPlayer = room.players.find((p) => p.socketId === this.socket.id);

      room.availableTeams.forEach((team) => {
        const membersCount = room.players.filter((p) => p.teamId === team.id).length;
        const isMyTeam = myPlayer && myPlayer.teamId === team.id;
        const isFull = membersCount >= room.teamSize && !isMyTeam;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `team-choice-btn ${isMyTeam ? 'selected' : ''}`;
        btn.style.borderColor = isMyTeam ? '#ffffff' : team.color;
        btn.style.background = isMyTeam ? `${team.color}44` : 'rgba(255,255,255,0.06)';
        btn.disabled = isFull;

        btn.innerHTML = `
          <span class="icon-text-inline">${lucideIcon(team.icon || 'shield', 13)} <span>${team.name}</span></span>
          <span>${membersCount}/${room.teamSize}</span>
        `;

        btn.addEventListener('click', () => {
          this.soundManager.playClick();
          this.socket.emit(
            'room:select_team',
            { roomId: room.id, teamId: team.id },
            (res) => {
              if (res?.error) this.showLobbyFeedback(res.error, 'error');
            }
          );
        });

        teamFrag.appendChild(btn);
      });
      this.teamButtonsGrid.appendChild(teamFrag);
    } else {
      this.teamPickerBox.classList.add('hidden');
    }

    const guestRealPlayers = room.players.filter((p) => !p.isBot && p.socketId !== room.hostId);
    const readyGuests = guestRealPlayers.filter((p) => p.isReady);

    if (this.readyCounterBadge) {
      this.readyCounterBadge.textContent =
        guestRealPlayers.length === 0
          ? 'Criador pronto para iniciar'
          : `Convidados Prontos: ${readyGuests.length}/${guestRealPlayers.length}`;
    }

    const me = room.players.find((p) => p.socketId === this.socket.id);
    if (this.btnToggleReady) {
      const showReadyButton = isPrivate && !isHost;
      this.btnToggleReady.classList.toggle('hidden', !showReadyButton);
      if (showReadyButton) {
        if (me?.isReady) {
          this.btnToggleReady.innerHTML = `${lucideIcon('x', 15)} <span>Cancelar Pronto</span>`;
          this.btnToggleReady.className = 'btn-success btn-3d';
        } else {
          this.btnToggleReady.innerHTML = `${lucideIcon('check', 15)} <span>Estou Pronto!</span>`;
          this.btnToggleReady.className = 'btn-accent btn-3d';
        }
      }
    }

    this.btnStartMatch.classList.toggle('hidden', !(isHost && isPrivate));
    if (isHost && isPrivate) {
      const canStart = Boolean(room.allRealReady);
      this.btnStartMatch.disabled = !canStart;
      this.btnStartMatch.innerHTML = canStart
        ? `${lucideIcon('rocket', 16)} <span>COMEÇAR PARTIDA!</span>`
        : `${lucideIcon('clock', 15)} <span>Aguardando convidados (${readyGuests.length}/${guestRealPlayers.length})</span>`;
    }

    this.waitingHostMsg.classList.toggle('hidden', isHost || !isPrivate);

    // Lista de jogadores dentro da sala mostrando o Nível (Nv. X) ao lado do nome!
    this.roomPlayersList.innerHTML = '';
    const playersFrag = document.createDocumentFragment();

    room.players.forEach((p) => {
      const li = document.createElement('li');
      if (p.teamColor) {
        li.style.borderColor = p.teamColor;
      }

      const leftDiv = document.createElement('div');
      leftDiv.className = 'player-left-info';

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.skinColor;
      leftDiv.appendChild(dot);

      const isPlayerHost = p.socketId === room.hostId;
      const roleIcon = isPlayerHost
        ? lucideIcon('crown', 13)
        : p.isBot
          ? lucideIcon('bot', 13)
          : p.teamIcon
            ? lucideIcon(p.teamIcon, 13)
            : '';

      const nameWrap = document.createElement('span');
      nameWrap.className = 'player-name-truncate icon-text-inline';
      nameWrap.innerHTML = `${roleIcon} <span>${p.username}</span>`;
      leftDiv.appendChild(nameWrap);

      const levelBadge = document.createElement('span');
      levelBadge.className = 'player-level-tag';
      levelBadge.textContent = `Nv. ${p.level || p.stats?.level || 1}`;
      leftDiv.appendChild(levelBadge);

      const rightDiv = document.createElement('div');
      rightDiv.className = 'player-right-actions';

      const readySpan = document.createElement('span');
      if (p.isBot) {
        readySpan.className = 'ready-status-tag is-ready';
        readySpan.innerHTML = `${lucideIcon('bot', 11)} <span>BOT</span>`;
      } else if (isPlayerHost) {
        readySpan.className = 'ready-status-tag is-ready';
        readySpan.innerHTML = `${lucideIcon('crown', 11)} <span>LÍDER</span>`;
      } else {
        readySpan.className = `ready-status-tag ${p.isReady ? 'is-ready' : 'not-ready'}`;
        readySpan.innerHTML = p.isReady
          ? `${lucideIcon('check', 11)} <span>PRONTO</span>`
          : `${lucideIcon('clock', 11)} <span>AGUARDANDO</span>`;
      }
      rightDiv.appendChild(readySpan);

      if (isHost && isPrivate && !p.isBot && !isPlayerHost) {
        const kickBtn = document.createElement('button');
        kickBtn.type = 'button';
        kickBtn.className = 'btn-kick-player';
        kickBtn.innerHTML = `${lucideIcon('ban', 11)} <span>Expulsar</span>`;
        kickBtn.title = `Expulsar ${p.username} da sala`;
        kickBtn.addEventListener('click', () => {
          this.soundManager.playClick();
          this.socket.emit('room:kick_player', {
            roomId: room.id,
            targetSocketId: p.socketId
          });
        });
        rightDiv.appendChild(kickBtn);
      }

      li.appendChild(leftDiv);
      li.appendChild(rightDiv);
      playersFrag.appendChild(li);
    });

    this.roomPlayersList.appendChild(playersFrag);
  }

  enterMatchArena(room, map, currentRound = 1, totalRounds = 3) {
    this.resetHudCache();
    this.setOnlineWidgetVisible(false);
    this.syncRoomChatFromRoom(room || this.currentRoom, true);
    this.bgScene.setPaused(true);
    this.lobbyUiWrapper.classList.add('hidden');
    this.victoryScreenOverlay.classList.add('hidden');
    this.hudEscapeBanner.classList.add('hidden');
    this.hudPowerupToast.classList.add('hidden');
    this.matchHud.classList.remove('hidden');

    if (currentRound === 1) {
      this.killFeed.innerHTML = '';
    }

    if (this.hudRoundPill) {
      const rk = `${currentRound}/${totalRounds}`;
      this.hudCache.roundKey = rk;
      this.hudRoundPill.innerHTML = `${lucideIcon('trophy', 13)} <span>Round ${rk}</span>`;
    }

    this.hudMapName.innerHTML = `${lucideIcon('map', 14)} <span>${map?.name || 'Arena Shove.io'}</span>`;
    this.hudMapDesc.textContent = map?.description || 'Empurre seus adversários para fora!';

    this.gameScene.startMatch({
      room,
      map,
      localSocketId: this.socket.id
    });
  }

  showFullVictoryScreen(result) {
    this.setOnlineWidgetVisible(false);
    this.matchHud.classList.add('hidden');
    this.mapPresentationOverlay.classList.add('hidden');
    this.bigCountdownOverlay.classList.add('hidden');
    this.victoryScreenOverlay.classList.remove('hidden');

    if (result.winnerType === 'TEAM') {
      this.resultWinnerTitle.innerHTML = `${lucideIcon('trophy', 22)} <span>VITÓRIA DO ${result.winnerName.toUpperCase()}!</span>`;
    } else {
      this.resultWinnerTitle.innerHTML = `${lucideIcon('trophy', 22)} <span>${result.winnerName.toUpperCase()} VENCEU A PARTIDA!</span>`;
    }

    const myXpReport = result.xpReportBySocket ? result.xpReportBySocket[this.socket.id] : null;
    if (myXpReport) {
      const st = myXpReport.updatedStats || {};
      if (this.currentUser) {
        this.currentUser.stats = st;
        localStorage.setItem('shove_user', JSON.stringify(this.currentUser));
        this.refreshProfileBarStats();
      }

      const levelLabel = myXpReport.leveledUp
        ? `${lucideIcon('sparkles', 16)} <span>SUBIU PARA O NÍVEL ${st.level}!</span>`
        : `${lucideIcon('star', 16)} <span>Nível ${st.level || 1}</span>`;
      if (this.xpCardLevel) this.xpCardLevel.innerHTML = levelLabel;
      if (this.xpCardTotalGained) {
        this.xpCardTotalGained.textContent = `+${myXpReport.totalXpGained} XP`;
      }

      const xpToNext = st.xpToNextLevel || (st.level || 1) * 200;
      const pct = Math.min(100, Math.round(((st.xp || 0) / xpToNext) * 100));
      if (this.xpCardBarFill) this.xpCardBarFill.style.width = `${pct}%`;
      if (this.xpCardProgressText) {
        this.xpCardProgressText.textContent = `${st.xp || 0} / ${xpToNext} XP para o Nível ${(st.level || 1) + 1}`;
      }
      if (this.xpCardBreakdown) {
        this.xpCardBreakdown.innerHTML = `
          <span>Shoves (${myXpReport.shoves}): +${myXpReport.xpFromShoves} XP</span>
          <span>Kills (${myXpReport.kills}): +${myXpReport.xpFromKills} XP</span>
          <span>Rounds (${myXpReport.roundWins}): +${myXpReport.xpFromRounds} XP</span>
          <span>Partida: +${myXpReport.xpFromWin} XP</span>
        `;
      }
    }

    this.gameScene.showVictoryStage(result);

    if (result.room) {
      this.currentRoom = result.room;
    }
  }

  exitMatchToLobby() {
    this.setOnlineWidgetVisible(true);
    this.gameScene.stopMatch();
    this.matchHud.classList.add('hidden');
    this.victoryScreenOverlay.classList.add('hidden');
    this.lobbyUiWrapper.classList.remove('hidden');
    this.bgScene.setPaused(false);

    this.soundManager.startLobbyMusic();
    this.refreshProfileBarStats();

    if (
      this.currentRoom &&
      this.currentRoom.mode === 'PRIVATE' &&
      this.currentRoom.status === 'WAITING'
    ) {
      this.renderRoomState(this.currentRoom);
    } else {
      this.currentRoom = null;
      this.hideAndClearRoomChat();
      window.history.replaceState({}, '', '/');
      this.activeRoomPanel.classList.add('hidden');
      this.roomConfigWindow.classList.add('hidden');
      this.lobbyLayoutContainer.classList.remove('has-config-open');
      this.lobbyModeActions.classList.remove('hidden');
    }
  }

  async authenticate(endpoint, payload) {
    try {
      this.hideFeedback();
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      if (!response.ok) {
        this.showFeedback(data.error || 'Falha na autenticação.', 'error');
        return;
      }

      this.token = data.token;
      this.currentUser = data.user;
      localStorage.setItem('shove_token', this.token);
      localStorage.setItem('shove_user', JSON.stringify(this.currentUser));

      this.enterLobby();
    } catch (err) {
      this.showFeedback('Erro de conexão com o servidor.', 'error');
    }
  }

  async restoreSession() {
    const savedUser = localStorage.getItem('shove_user');
    const savedToken = localStorage.getItem('shove_token');
    if (savedUser && savedToken) {
      try {
        this.currentUser = JSON.parse(savedUser);
        this.token = savedToken;
        this.selectedColor = this.currentUser.skinColor || '#FF3366';
        this.bgScene.setHeroColor(this.selectedColor);
        this.enterLobby();
        return;
      } catch (e) {
        localStorage.removeItem('shove_user');
        localStorage.removeItem('shove_token');
      }
    }

    if (this.pendingUrlRoomId) {
      await this.authenticate('/api/auth/guest', {
        username: '',
        skinColor: this.selectedColor
      });
    }
  }

  refreshProfileBarStats() {
    if (!this.currentUser) return;
    this.profileDot.style.background = this.currentUser.skinColor;
    this.profileName.textContent = this.currentUser.username;

    const st = this.currentUser.stats || {};
    const wins = st.wins || 0;
    const matches = st.matches || 0;
    const shoves = st.shoves || 0;
    const level = st.level || 1;
    const xp = st.xp || 0;
    const xpNext = st.xpToNextLevel || level * 200;

    this.profileStats.textContent = `${wins} Vitórias • ${matches} Partidas • ${shoves} Shoves`;
    if (this.profileLevelBadge) {
      this.profileLevelBadge.innerHTML = `${lucideIcon('star', 11)} <span>Nv. ${level}</span>`;
    }
    if (this.profileXpFill) {
      const pct = Math.min(100, Math.round((xp / xpNext) * 100));
      this.profileXpFill.style.width = `${pct}%`;
    }
    if (this.profileXpText) {
      this.profileXpText.textContent = `${xp} / ${xpNext} XP`;
    }
  }

  enterLobby() {
    this.authCard.classList.add('hidden');
    this.lobbyLayoutContainer.classList.remove('hidden');

    this.refreshProfileBarStats();
    this.soundManager.startLobbyMusic();

    if (this.currentUser) {
      this.socket.emit('user:identify', this.currentUser, (res) => {
        if (res?.onlineCount) this.updateOnlineCountUI(res.onlineCount);
      });
    }

    this.socket.emit('rooms:get_list', (list) => {
      if (Array.isArray(list)) this.renderPublicRoomsList(list);
    });

    if (this.pendingUrlRoomId) {
      const targetRoomId = this.pendingUrlRoomId;
      this.pendingUrlRoomId = null;
      this.joinRoomByCode(targetRoomId);
    }
  }

  showFeedback(msg, type = 'error') {
    this.feedbackBox.textContent = msg;
    this.feedbackBox.className = `feedback-msg ${type}`;
  }

  hideFeedback() {
    this.feedbackBox.classList.add('hidden');
  }

  showLobbyFeedback(msg, type = 'error') {
    if (!this.lobbyFeedbackBox) return;
    this.lobbyFeedbackBox.textContent = msg;
    this.lobbyFeedbackBox.className = `feedback-msg ${type}`;
  }

  hideLobbyFeedback() {
    if (!this.lobbyFeedbackBox) return;
    this.lobbyFeedbackBox.classList.add('hidden');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new LoginScreenController();
});
