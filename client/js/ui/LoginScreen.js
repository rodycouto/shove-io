// client/js/ui/LoginScreen.js
// ============================================================================
// Controlador Principal de UI:
// - Detecção de Celular/Touch para ocultar a aba de escolher teclas de PC
// - Configuração da Sala exibida SEMPRE AO LADO do menu principal (PC e Mobile)
// - Lista de Amigos com Status Online/Offline em tempo real e botão Convidar
// - Ping em tempo real no canto superior esquerdo
// - Sistema de Níveis, Barra de XP e Contagem de Vitórias, Partidas e Shoves
// - Lista Pública de Salas Criadas, Solicitações de Entrada e Expulsão (Kick)
// - Número de Rounds (Default: 3, Máx: 10) e Seleção de 1 ou mais Mapas
// - Apresentação do Mapa + Contagem Grande 5, 4, 3, 2, 1 - SHOVE!
// ============================================================================

import { LobbyBackgroundScene } from '../scenes/LobbyBackgroundScene.js';
import { GameScene } from '../scenes/GameScene.js';
import { ControlsConfig } from '../config/ControlsConfig.js';
import { SoundManager } from '../audio/SoundManager.js';

class LoginScreenController {
  constructor() {
    this.selectedColor = '#FF3366';
    this.currentUser = null;
    this.token = null;
    this.currentRoom = null;
    this.friendsList = [];
    this.pendingInviteRoomId = null;
    this.listeningControlAction = null;

    this.pendingUrlRoomId = this.extractRoomIdFromUrl();

    this.socket = window.io();
    this.soundManager = new SoundManager();
    this.controlsConfig = new ControlsConfig();
    this.bgScene = new LobbyBackgroundScene('bg-canvas');
    this.gameScene = new GameScene(
      'game-canvas',
      this.socket,
      this.controlsConfig,
      this.soundManager
    );

    this.detectMobileEnvironment();
    this.cacheDOM();
    this.startPingMonitor();
    this.bindAuthEvents();
    this.bindLobbyEvents();
    this.bindFriendsEvents();
    this.bindRoomConfigWindowEvents();
    this.bindSettingsEvents();
    this.bindSocketEvents();
    this.renderControlLabels();
    this.updateSoundButtonsUI();
    this.restoreSession();
  }

  /**
   * Detecta se o usuário está jogando pelo celular/tablet para ocultar
   * a aba de escolher teclas de teclado/mouse do computador.
   */
  detectMobileEnvironment() {
    const isCoarsePointer = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent || ''
    );
    this.isMobile = Boolean(isCoarsePointer || isMobileUA);
    if (this.isMobile) {
      document.body.classList.add('is-mobile-device');
    }
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

    // Banner Flutuante de Convite de Amigo
    this.friendInviteBanner = document.getElementById('friend-invite-banner');
    this.inviteSenderName = document.getElementById('invite-sender-name');
    this.inviteRoomCode = document.getElementById('invite-room-code');
    this.btnAcceptInvite = document.getElementById('btn-accept-invite');
    this.btnDeclineInvite = document.getElementById('btn-decline-invite');

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
    this.lobbyTabBtnSettings = document.getElementById('lobby-tab-btn-settings');
    this.lobbyViewPlay = document.getElementById('lobby-view-play');
    this.lobbyViewFriends = document.getElementById('lobby-view-friends');
    this.lobbyViewSettings = document.getElementById('lobby-view-settings');

    // Elementos da Aba de Amigos
    this.friendsOnlineCount = document.getElementById('friends-online-count');
    this.friendsTotalBadge = document.getElementById('friends-total-badge');
    this.formAddFriend = document.getElementById('form-add-friend');
    this.inputFriendName = document.getElementById('input-friend-name');
    this.friendsListUl = document.getElementById('friends-list-ul');

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

    // Janela Lateral "Configuração da Sala"
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

    // HUD da Partida, Apresentação do Mapa, Contagem 5s e Tela de Vitória 3D
    this.matchHud = document.getElementById('match-hud');
    this.hudMapName = document.getElementById('hud-map-name');
    this.hudMapDesc = document.getElementById('hud-map-desc');
    this.hudRoundPill = document.getElementById('hud-round-pill');
    this.hudTimerPill = document.getElementById('hud-timer-pill');
    this.hudPowerupTimerPill = document.getElementById('hud-powerup-timer-pill');
    this.hudSpeedPill = document.getElementById('hud-speed-pill');
    this.hudModePill = document.getElementById('hud-mode-pill');
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

  startPingMonitor() {
    const measure = () => {
      if (!this.socket.connected) {
        if (this.pingText) this.pingText.textContent = 'Ping: offline';
        if (this.pingDot) this.pingDot.style.background = '#ff3366';
        return;
      }
      const start = performance.now();
      this.socket.emit('ping:check', () => {
        const ms = Math.max(1, Math.round(performance.now() - start));
        if (this.pingText) this.pingText.textContent = `Ping: ${ms} ms`;
        if (this.pingDot) {
          const color = ms < 80 ? '#00e676' : ms < 160 ? '#ffd600' : '#ff3366';
          this.pingDot.style.background = color;
          this.pingDot.style.boxShadow = `0 0 8px ${color}`;
        }
      });
    };

    setInterval(measure, 2000);
    this.socket.on('connect', () => {
      measure();
      if (this.currentUser) {
        this.socket.emit('user:register_presence', this.currentUser);
      }
    });
  }

  updateSoundButtonsUI() {
    const muted = this.soundManager.muted;
    if (this.btnToggleSound) {
      this.btnToggleSound.textContent = muted ? '🔇 Mudo' : '🔊 Som';
    }
    if (this.btnHudSound) {
      this.btnHudSound.textContent = muted ? '🔇' : '🔊';
    }
  }

  // ==========================================================================
  // EVENTOS DE LOGIN, CADASTRO E CONVIDADO
  // ==========================================================================
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
      this.socket.emit('user:logout');
      this.currentRoom = null;
      window.history.replaceState({}, '', '/');
      this.activeRoomPanel.classList.add('hidden');
      this.roomConfigWindow.classList.add('hidden');
      this.lobbyModeActions.classList.remove('hidden');
      this.lobbyLayoutContainer.classList.add('hidden');
      this.authCard.classList.remove('hidden');
    });
  }

  // ==========================================================================
  // EVENTOS DO SISTEMA DE AMIGOS (ONLINE/OFFLINE E CONVIDAR PARA PARTIDA)
  // ==========================================================================
  bindFriendsEvents() {
    if (this.formAddFriend) {
      this.formAddFriend.addEventListener('submit', (e) => {
        e.preventDefault();
        const friendUsername = this.inputFriendName.value.trim();
        if (!friendUsername) return;
        this.soundManager.playClick();

        this.socket.emit('friends:add', { friendUsername }, (res) => {
          if (res?.error) {
            this.showLobbyFeedback(res.error, 'error');
            return;
          }
          this.inputFriendName.value = '';
          if (this.currentUser && Array.isArray(res?.friends)) {
            this.currentUser.friends = res.friends;
            localStorage.setItem('shove_user', JSON.stringify(this.currentUser));
          }
          if (Array.isArray(res?.friendsList)) {
            this.renderFriendsList(res.friendsList);
          }
          this.showLobbyFeedback(`Amigo adicionado com sucesso!`, 'success');
        });
      });
    }

    // Botões de Aceitar ou Recusar Convite de Amigo Recebido
    if (this.btnAcceptInvite) {
      this.btnAcceptInvite.addEventListener('click', () => {
        this.soundManager.playClick();
        const targetRoom = this.pendingInviteRoomId;
        this.pendingInviteRoomId = null;
        this.friendInviteBanner.classList.add('hidden');
        if (targetRoom) {
          this.joinRoomByCode(targetRoom, true);
        }
      });
    }

    if (this.btnDeclineInvite) {
      this.btnDeclineInvite.addEventListener('click', () => {
        this.soundManager.playClick();
        this.pendingInviteRoomId = null;
        this.friendInviteBanner.classList.add('hidden');
      });
    }
  }

  /**
   * Renderiza a lista de amigos com indicador Online/Offline e botão Convidar para Partida.
   */
  renderFriendsList(list = []) {
    this.friendsList = Array.isArray(list) ? list : [];

    const onlineCount = this.friendsList.filter((f) => f.online).length;
    if (this.friendsOnlineCount) {
      this.friendsOnlineCount.textContent = String(onlineCount);
    }
    if (this.friendsTotalBadge) {
      this.friendsTotalBadge.textContent = `${this.friendsList.length} ${
        this.friendsList.length === 1 ? 'amigo' : 'amigos'
      }`;
    }

    if (!this.friendsListUl) return;
    this.friendsListUl.innerHTML = '';

    if (this.friendsList.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty-rooms-msg';
      li.textContent = 'Você ainda não adicionou amigos. Adicione pelo Nickname acima!';
      this.friendsListUl.appendChild(li);
      return;
    }

    this.friendsList.forEach((friend) => {
      const li = document.createElement('li');
      li.className = 'friend-item';

      const leftDiv = document.createElement('div');
      leftDiv.className = 'friend-left';

      const dot = document.createElement('span');
      dot.className = 'friend-avatar-dot';
      dot.style.background = friend.online ? friend.skinColor || '#00E676' : '#555e7a';
      leftDiv.appendChild(dot);

      const nameBlock = document.createElement('div');
      nameBlock.className = 'friend-name-block';
      const statusLabel = friend.online
        ? friend.inRoomId
          ? `🟢 Online (Na Sala #${friend.inRoomId})`
          : '🟢 Online'
        : '⚪ Offline';

      nameBlock.innerHTML = `
        <strong>${friend.username}</strong>
        <span class="friend-status-text ${friend.online ? 'online' : 'offline'}">${statusLabel}</span>
      `;
      leftDiv.appendChild(nameBlock);

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'friend-actions';

      // Botão Convidar para Partida (ativo quando o amigo está Online)
      const inviteBtn = document.createElement('button');
      inviteBtn.type = 'button';
      inviteBtn.className = 'btn-invite-friend';
      inviteBtn.disabled = !friend.online;
      inviteBtn.textContent = '📨 Convidar';
      inviteBtn.title = friend.online
        ? `Convidar ${friend.username} para sua partida`
        : `${friend.username} está Offline`;

      inviteBtn.addEventListener('click', () => {
        this.soundManager.playClick();
        this.socket.emit(
          'friends:invite',
          {
            friendUsername: friend.username,
            playerProfile: this.currentUser
          },
          (res) => {
            if (res?.error) {
              this.showLobbyFeedback(res.error, 'error');
              return;
            }
            if (res?.room) {
              this.renderRoomState(res.room);
            }
            this.showLobbyFeedback(res?.message || 'Convite enviado!', 'success');
          }
        );
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-remove-friend';
      removeBtn.textContent = '✖';
      removeBtn.title = `Remover ${friend.username}`;
      removeBtn.addEventListener('click', () => {
        this.soundManager.playClick();
        this.socket.emit('friends:remove', { friendUsername: friend.username }, (res) => {
          if (this.currentUser && Array.isArray(res?.friends)) {
            this.currentUser.friends = res.friends;
            localStorage.setItem('shove_user', JSON.stringify(this.currentUser));
          }
          if (Array.isArray(res?.friendsList)) {
            this.renderFriendsList(res.friendsList);
          }
        });
      });

      actionsDiv.appendChild(inviteBtn);
      actionsDiv.appendChild(removeBtn);

      li.appendChild(leftDiv);
      li.appendChild(actionsDiv);
      this.friendsListUl.appendChild(li);
    });
  }

  // ==========================================================================
  // EVENTOS DO LOBBY: CRIAR SALA, ENTRAR/PEDIR ENTRADA, PRONTO E LINK
  // ==========================================================================
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
        const target = btn.dataset.lobbyTab;
        // Bloqueia abertura da aba de teclas de PC caso esteja em dispositivo mobile
        if (this.isMobile && target === 'settings') return;

        this.soundManager.playClick();
        this.lobbyTabBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        this.lobbyViewPlay.classList.toggle('hidden', target !== 'play');
        if (this.lobbyViewFriends) {
          this.lobbyViewFriends.classList.toggle('hidden', target !== 'friends');
        }
        this.lobbyViewSettings.classList.toggle('hidden', target !== 'settings' || this.isMobile);
        this.listeningControlAction = null;
        this.renderControlLabels();

        if (target === 'friends') {
          this.socket.emit('friends:get_list', (list) => {
            if (Array.isArray(list)) this.renderFriendsList(list);
          });
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
        this.btnCopyRoomLink.textContent = '✅ Link Copiado!';
        setTimeout(() => {
          this.btnCopyRoomLink.textContent = '🔗 Copiar Link';
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
        window.history.replaceState({}, '', '/');
        this.activeRoomPanel.classList.add('hidden');
        this.roomConfigWindow.classList.add('hidden');
        this.lobbyModeActions.classList.remove('hidden');
      });
    });

    this.btnQuitMatch.addEventListener('click', () => {
      this.soundManager.playClick();
      this.socket.emit('room:leave');
      window.history.replaceState({}, '', '/');
      this.currentRoom = null;
      this.exitMatchToLobby();
    });

    this.btnBackToLobby.addEventListener('click', () => {
      this.soundManager.playClick();
      this.victoryScreenOverlay.classList.add('hidden');
      this.exitMatchToLobby();
    });
  }

  joinRoomByCode(code, fromInvite = false) {
    this.hideLobbyFeedback();
    // Garante que a aba "Jogar" fique visível ao entrar na sala
    this.lobbyTabBtns.forEach((b) => b.classList.toggle('active', b.dataset.lobbyTab === 'play'));
    this.lobbyViewPlay.classList.remove('hidden');
    if (this.lobbyViewFriends) this.lobbyViewFriends.classList.add('hidden');
    this.lobbyViewSettings.classList.add('hidden');

    this.socket.emit(
      'room:join_private',
      { roomId: code, playerProfile: this.currentUser, fromInvite },
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

    roomsList.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'public-room-item';

      const modeText = r.teamSize === 1 ? 'Solo' : `Times de ${r.teamSize}`;
      const metaDiv = document.createElement('div');
      metaDiv.className = 'public-room-meta';
      metaDiv.innerHTML = `
        <strong>#${r.id} • 👑 ${r.hostName}</strong>
        <span>${r.playersCount}/${r.maxPlayers} Jogadores • ${modeText} • ${r.totalRounds || 3} Rounds</span>
      `;

      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = `btn-room-action ${r.isOpenJoin ? 'open' : 'request'}`;
      actionBtn.textContent = r.isOpenJoin ? '🔓 Entrar' : '🙋 Pedir Entrada';

      actionBtn.addEventListener('click', () => {
        this.soundManager.playClick();
        this.joinRoomByCode(r.id);
      });

      li.appendChild(metaDiv);
      li.appendChild(actionBtn);
      this.publicRoomsList.appendChild(li);
    });
  }

  // ==========================================================================
  // EVENTOS DA JANELA LATERAL "CONFIGURAÇÃO DA SALA"
  // ==========================================================================
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

    if (this.cfgPowerupsToggle) {
      this.cfgPowerupsToggle.addEventListener('change', () => {
        sendConfigUpdate({ powerupsEnabled: this.cfgPowerupsToggle.checked });
      });
    }

    this.cfgSpawnPills.forEach((pill) => {
      pill.addEventListener('click', () => {
        sendConfigUpdate({ powerupSpawnInterval: Number(pill.dataset.spawn) || 15 });
      });
    });
  }

  // ==========================================================================
  // ABA DE CONFIGURAÇÕES DE CONTROLES (EXCLUSIVO PC)
  // ==========================================================================
  bindSettingsEvents() {
    this.bindKeyButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        if (this.isMobile) return;
        e.stopPropagation();
        this.soundManager.playClick();
        const action = btn.dataset.action;
        this.listeningControlAction = action;
        this.renderControlLabels();
        btn.textContent = 'Aperte tecla ou clique...';
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

  // ==========================================================================
  // EVENTOS EM TEMPO REAL DO SOCKET.IO
  // ==========================================================================
  bindSocketEvents() {
    this.socket.on('rooms:list', (list) => {
      this.renderPublicRoomsList(list);
    });

    // Atualização em tempo real do status Online/Offline dos Amigos
    this.socket.on('friends:list_update', (list) => {
      this.renderFriendsList(list);
    });

    // Quando um Amigo envia um convite para entrar na partida dele
    this.socket.on('friends:receive_invite', ({ roomId, fromUsername }) => {
      this.soundManager.playPowerupSpawn();
      this.pendingInviteRoomId = roomId;
      if (this.inviteSenderName) this.inviteSenderName.textContent = fromUsername;
      if (this.inviteRoomCode) this.inviteRoomCode.textContent = `#${roomId}`;
      if (this.friendInviteBanner) {
        this.friendInviteBanner.classList.remove('hidden');
      }
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
      window.history.replaceState({}, '', '/');
      this.activeRoomPanel.classList.add('hidden');
      this.roomConfigWindow.classList.add('hidden');
      this.lobbyModeActions.classList.remove('hidden');
      this.showLobbyFeedback(reason || 'Você foi expulso da sala pelo criador.', 'error');
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
      window.history.replaceState({}, '', '/');
      this.activeRoomPanel.classList.add('hidden');
      this.roomConfigWindow.classList.add('hidden');
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
        `🏆 Fim do Round ${currentRound}/${totalRounds}! Vencedor: ${roundWinnerName}`
      );
    });

    this.socket.on('match:state', (state) => {
      this.gameScene.onServerState(state);

      if (this.hudRoundPill && state.currentRound && state.totalRounds) {
        this.hudRoundPill.textContent = `🏆 Round ${state.currentRound}/${state.totalRounds}`;
      }

      if (typeof state.timeRemaining === 'number' && this.hudTimerPill) {
        const mins = String(Math.floor(state.timeRemaining / 60)).padStart(2, '0');
        const secs = String(state.timeRemaining % 60).padStart(2, '0');
        this.hudTimerPill.textContent = `⏱️ ${mins}:${secs}`;
      }

      if (this.hudPowerupTimerPill) {
        if (state.powerupsEnabled === false) {
          this.hudPowerupTimerPill.textContent = '🎁 Power-Ups: OFF';
        } else if (typeof state.nextPowerupIn === 'number') {
          this.hudPowerupTimerPill.textContent = `🎁 Novo Power-Up: ${state.nextPowerupIn}s`;
        }
      }

      if (typeof state.speedMultiplier === 'number' && this.hudSpeedPill) {
        this.hudSpeedPill.textContent = `⚡ ${state.speedMultiplier.toFixed(2)}x`;
      }

      if (state && Array.isArray(state.players)) {
        const aliveCount = state.players.filter((p) => p.alive).length;
        this.hudAlivePill.textContent = `🔥 ${aliveCount} Vivos`;

        const me = state.players.find((p) => p.id === this.socket.id);
        if (me && me.grabbedById) {
          this.hudEscapeBanner.classList.remove('hidden');
          this.hudEscapeCounter.textContent = `${me.escapePresses || 0}/5`;
        } else {
          this.hudEscapeBanner.classList.add('hidden');
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
        this.hudEscapeBanner.classList.remove('hidden');
        this.hudEscapeCounter.textContent = `0/5`;
      }
    });

    this.socket.on('match:escape_progress', ({ victimId, presses, required }) => {
      if (victimId === this.socket.id) {
        this.hudEscapeCounter.textContent = `${presses}/${required}`;
      }
    });

    this.socket.on('match:escaped', () => {
      this.soundManager.playEscapeStun();
      this.hudEscapeBanner.classList.add('hidden');
    });

    this.socket.on('match:thrown', (data) => {
      this.gameScene.spawnShockwave({ x: data.x, z: data.z, power: data.power });
      this.soundManager.playShove(data.power);
    });

    this.socket.on('match:powerup_spawned', () => {
      this.soundManager.playPowerupSpawn();
    });

    this.socket.on('match:powerup_collected', ({ powerupIcon, powerupName, playerId }) => {
      this.soundManager.playPowerupPickup();
      if (playerId === this.socket.id) {
        this.showPowerupToast(`${powerupIcon} Você pegou: ${powerupName}!`);
      }
    });

    this.socket.on('match:shock_fx', (shockData) => {
      this.soundManager.playShock();
      this.gameScene.spawnLightningBolt(shockData);
    });

    this.socket.on('match:eliminated', ({ victimName, killerName }) => {
      this.soundManager.playFall();
      this.pushKillFeedItem(
        killerName
          ? `💥 ${killerName} eliminou ${victimName}!`
          : `💫 ${victimName} foi eliminado!`
      );
    });

    this.socket.on('match:ended', (result) => {
      this.soundManager.playVictory();
      this.showFullVictoryScreen(result);
    });
  }

  pushKillFeedItem(text) {
    if (!this.killFeed) return;
    const div = document.createElement('div');
    div.className = 'kill-item';
    div.textContent = text;
    this.killFeed.prepend(div);
    setTimeout(() => div.remove(), 4500);
  }

  showPowerupToast(text) {
    if (!this.hudPowerupToast) return;
    this.hudPowerupToast.textContent = text;
    this.hudPowerupToast.classList.remove('hidden');
    clearTimeout(this.powerupToastTimer);
    this.powerupToastTimer = setTimeout(() => {
      this.hudPowerupToast.classList.add('hidden');
    }, 3200);
  }

  // ==========================================================================
  // RENDERIZAÇÃO DO ESTADO DA SALA, JANELA DE CONFIGURAÇÃO E EXPULSÃO
  // ==========================================================================
  renderRoomState(room) {
    if (!room) return;
    this.currentRoom = room;

    const isHost = room.hostId === this.socket.id;
    const isPrivate = room.mode === 'PRIVATE';

    if (isPrivate) {
      window.history.replaceState({}, '', `/room/${room.id}`);
      if (this.roomShareUrl) {
        this.roomShareUrl.textContent = `https://shove.discloud.dev/room/${room.id}`;
      }
    }

    this.lobbyModeActions.classList.add('hidden');
    this.activeRoomPanel.classList.remove('hidden');
    this.roomConfigWindow.classList.toggle('hidden', !isPrivate);

    this.roomCodeDisplay.textContent = room.id;
    this.roomModeDisplay.textContent =
      room.teamSize === 1 ? '👤 Solo (Individual)' : `👥 Times de ${room.teamSize}`;
    this.roomCountDisplay.textContent = `${room.players.length}/${room.maxPlayers} Jogadores`;

    if (room.teamSize > 1) {
      this.roomFfBadge.textContent = room.friendlyFire
        ? '💥 Fogo Amigo: ATIVADO'
        : '🛡️ Fogo Amigo: DESATIVADO';
    } else {
      this.roomFfBadge.textContent = '⚔️ Todos contra Todos';
    }

    if (this.roomRoundsBadge) {
      this.roomRoundsBadge.textContent = `🏆 ${room.totalRounds || 3} Rounds`;
    }
    if (this.roomAccessBadge) {
      this.roomAccessBadge.textContent = room.isOpenJoin ? '🔓 Entrada Livre' : '🔒 Por Solicitação';
    }

    this.brCountdownBanner.classList.toggle('hidden', room.mode !== 'BATTLEROYALE');

    if (this.joinRequestsBox && this.joinRequestsList) {
      const requests = Array.isArray(room.joinRequests) ? room.joinRequests : [];
      const showRequests = isHost && isPrivate && requests.length > 0;
      this.joinRequestsBox.classList.toggle('hidden', !showRequests);

      if (showRequests) {
        this.joinRequestsList.innerHTML = '';
        requests.forEach((req) => {
          const li = document.createElement('li');
          li.className = 'join-req-item';
          li.innerHTML = `<span>🙋 ${req.username} quer entrar</span>`;

          const btnsDiv = document.createElement('div');
          btnsDiv.className = 'join-req-btns';

          const btnAccept = document.createElement('button');
          btnAccept.type = 'button';
          btnAccept.className = 'btn-req-accept';
          btnAccept.textContent = '✅ Aceitar';
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
          btnReject.textContent = '❌ Recusar';
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
          this.joinRequestsList.appendChild(li);
        });
      }
    }

    if (isPrivate) {
      if (this.configHostTag) {
        this.configHostTag.classList.toggle('hidden', !isHost);
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

      if (this.cfgMapsChecklist && Array.isArray(room.allMapsCatalog)) {
        const selectedIds = Array.isArray(room.selectedMapIds) ? room.selectedMapIds : [];
        if (this.cfgMapsModeHint) {
          this.cfgMapsModeHint.textContent =
            selectedIds.length > 1 ? '🎲 Randômico (Muda a cada round)' : '📌 Mapa Fixo';
        }

        this.cfgMapsChecklist.innerHTML = '';
        room.allMapsCatalog.forEach((m) => {
          const isSelected = selectedIds.includes(m.id);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `map-check-btn ${isSelected ? 'selected' : ''}`;
          btn.disabled = !isHost;
          btn.innerHTML = `<span>${isSelected ? '✅' : '⬜'}</span> <span>${m.name}</span>`;

          btn.addEventListener('click', () => {
            if (!isHost) return;
            let nextIds = [...selectedIds];
            if (isSelected) {
              if (nextIds.length <= 1) {
                this.showLobbyFeedback('Mantenha pelo menos 1 mapa selecionado!', 'error');
                return;
              }
              nextIds = nextIds.filter((id) => id !== m.id);
            } else {
              nextIds.push(m.id);
            }
            this.soundManager.playClick();
            this.socket.emit('room:update_config', {
              roomId: room.id,
              selectedMapIds: nextIds
            });
          });

          this.cfgMapsChecklist.appendChild(btn);
        });
      }

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

      const pwrEnabled = room.powerupsEnabled !== false;
      this.cfgPowerupsToggle.checked = pwrEnabled;
      this.cfgPowerupsToggle.disabled = !isHost;
      this.cfgPowerupsState.textContent = pwrEnabled ? 'SIM' : 'NÃO';
      this.cfgPowerupIntervalBlock.classList.toggle('hidden', !pwrEnabled);

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
          <span>${team.icon} ${team.name}</span>
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

        this.teamButtonsGrid.appendChild(btn);
      });
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
          this.btnToggleReady.textContent = '✅ VOCÊ ESTÁ PRONTO! (Clique p/ desmarcar)';
          this.btnToggleReady.className = 'btn-success btn-3d';
        } else {
          this.btnToggleReady.textContent = '✋ CLICAR EM "PRONTO"';
          this.btnToggleReady.className = 'btn-accent btn-3d';
        }
      }
    }

    this.btnStartMatch.classList.toggle('hidden', !(isHost && isPrivate));
    if (isHost && isPrivate) {
      const canStart = Boolean(room.allRealReady);
      this.btnStartMatch.disabled = !canStart;
      this.btnStartMatch.textContent = canStart
        ? '🚀 COMEÇAR PARTIDA!'
        : `⏳ AGUARDANDO CONVIDADOS EM "PRONTO" (${readyGuests.length}/${guestRealPlayers.length})`;
    }

    this.waitingHostMsg.classList.toggle('hidden', isHost || !isPrivate);

    // Lista de jogadores na sala (com botão rápido +Amigo e botão Expulsar para o Criador)
    const myFriendNamesLower = new Set(
      (this.friendsList || []).map((f) => String(f.username).toLowerCase())
    );

    this.roomPlayersList.innerHTML = '';
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

      const prefix = p.teamIcon ? `${p.teamIcon} ` : '';
      const isPlayerHost = p.socketId === room.hostId;
      const hostCrown = isPlayerHost ? '👑 ' : '';
      leftDiv.appendChild(document.createTextNode(`${hostCrown}${prefix}${p.username}`));

      const rightDiv = document.createElement('div');
      rightDiv.className = 'player-right-actions';

      // Botão rápido para adicionar colega da sala como Amigo
      if (!p.isBot && p.socketId !== this.socket.id && !myFriendNamesLower.has(p.username.toLowerCase())) {
        const addFriendBtn = document.createElement('button');
        addFriendBtn.type = 'button';
        addFriendBtn.className = 'btn-quick-friend';
        addFriendBtn.textContent = '➕ Amigo';
        addFriendBtn.title = `Adicionar ${p.username} aos amigos`;
        addFriendBtn.addEventListener('click', () => {
          this.soundManager.playClick();
          this.socket.emit('friends:add', { friendUsername: p.username }, (res) => {
            if (Array.isArray(res?.friendsList)) {
              this.renderFriendsList(res.friendsList);
              this.renderRoomState(this.currentRoom);
            }
          });
        });
        rightDiv.appendChild(addFriendBtn);
      }

      const readySpan = document.createElement('span');
      if (p.isBot) {
        readySpan.className = 'ready-status-tag is-ready';
        readySpan.textContent = '🤖 BOT';
      } else if (isPlayerHost) {
        readySpan.className = 'ready-status-tag is-ready';
        readySpan.textContent = '👑 LÍDER';
      } else {
        readySpan.className = `ready-status-tag ${p.isReady ? 'is-ready' : 'not-ready'}`;
        readySpan.textContent = p.isReady ? '✅ PRONTO' : '⏳ NÃO PRONTO';
      }
      rightDiv.appendChild(readySpan);

      if (isHost && isPrivate && !p.isBot && !isPlayerHost) {
        const kickBtn = document.createElement('button');
        kickBtn.type = 'button';
        kickBtn.className = 'btn-kick-player';
        kickBtn.textContent = '🚫 Expulsar';
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
      this.roomPlayersList.appendChild(li);
    });
  }

  // ==========================================================================
  // TRANSIÇÃO ENTRE LOBBY, PARTIDA 3D E TELA DE VITÓRIA COM DADOS DE XP
  // ==========================================================================
  enterMatchArena(room, map, currentRound = 1, totalRounds = 3) {
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
      this.hudRoundPill.textContent = `🏆 Round ${currentRound}/${totalRounds}`;
    }

    this.hudMapName.textContent = `🗺️ ${map?.name || 'Arena Shove.io'}`;
    this.hudMapDesc.textContent = map?.description || 'Empurre seus adversários para fora!';

    if (room.teamSize > 1) {
      const ffText = room.friendlyFire ? '💥 Fogo Amigo ON' : '🛡️ Sem Fogo Amigo';
      this.hudModePill.textContent = `👥 Times de ${room.teamSize} (${ffText})`;
    } else {
      this.hudModePill.textContent = '👤 Individual (Solo)';
    }

    this.gameScene.startMatch({
      room,
      map,
      localSocketId: this.socket.id
    });
  }

  showFullVictoryScreen(result) {
    this.matchHud.classList.add('hidden');
    this.mapPresentationOverlay.classList.add('hidden');
    this.bigCountdownOverlay.classList.add('hidden');
    this.victoryScreenOverlay.classList.remove('hidden');

    if (result.winnerType === 'TEAM') {
      this.resultWinnerTitle.textContent = `🏆 VITÓRIA DO ${result.winnerName.toUpperCase()}!`;
      this.resultWinnerSubtitle.textContent =
        'Lado Esquerdo: Time Campeão • Lado Direito: Adversários Eliminados';
    } else {
      this.resultWinnerTitle.textContent = `🏆 ${result.winnerName.toUpperCase()} VENCEU A PARTIDA!`;
      this.resultWinnerSubtitle.textContent =
        'Lado Esquerdo: Grande Campeão • Lado Direito: Adversários Eliminados';
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
        ? `🎉 SUBIU PARA O NÍVEL ${st.level}!`
        : `⭐ Nível ${st.level || 1}`;
      if (this.xpCardLevel) this.xpCardLevel.textContent = levelLabel;
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
          <span>🥊 Shoves (${myXpReport.shoves}): +${myXpReport.xpFromShoves} XP</span>
          <span>💥 Kills (${myXpReport.kills}): +${myXpReport.xpFromKills} XP</span>
          <span>🏆 Rounds (${myXpReport.roundWins}): +${myXpReport.xpFromRounds} XP</span>
          <span>🎖️ Partida: +${myXpReport.xpFromWin} XP</span>
        `;
      }
    }

    this.gameScene.showVictoryStage(result);

    if (result.room) {
      this.currentRoom = result.room;
    }
  }

  exitMatchToLobby() {
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
      window.history.replaceState({}, '', '/');
      this.activeRoomPanel.classList.add('hidden');
      this.roomConfigWindow.classList.add('hidden');
      this.lobbyModeActions.classList.remove('hidden');
    }
  }

  // ==========================================================================
  // AUTENTICAÇÃO HTTP E REGISTRO DE PRESENÇA ONLINE DOS AMIGOS
  // ==========================================================================
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
      this.profileLevelBadge.textContent = `⭐ Nível ${level}`;
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

    // Garante que em celulares a aba de Controles de PC nunca apareça
    if (this.isMobile && this.lobbyTabBtnSettings) {
      this.lobbyTabBtnSettings.classList.add('hidden');
      this.lobbyViewSettings.classList.add('hidden');
    }

    this.refreshProfileBarStats();
    this.soundManager.startLobbyMusic();

    // Registra presença Online no servidor e carrega a lista de amigos
    this.socket.emit('user:register_presence', this.currentUser, (res) => {
      if (Array.isArray(res?.friendsList)) {
        this.renderFriendsList(res.friendsList);
      }
    });

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