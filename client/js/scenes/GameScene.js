// client/js/scenes/GameScene.js
// ============================================================================
// Cena 3D Principal da Partida e Palco 3D de Vitória em Tela Cheia (Three.js v2.0).
// Inclui:
// 1. Personagens redesenhados em Low-Poly Arcade (MeshLambertMaterial flatShading,
//    78% menos polígonos) para máxima fluidez no celular e PC.
// 2. Extrapolação de Velocidade (vx, vy, vz) + Predição Local entre pacotes de
//    30Hz para reduzir drasticamente a sensação de ping.
// 3. Novo Mapa "Circo Saltitante": renderização e animação de mola dos 5 Trampolins.
// 4. Novo Power-Up "Luva de Boxe": luva 3D vermelha equipada na mão direita e
//    animação de Nocaute (personagem fica deitado no chão por 2 segundos!).
// 5. Barra de carregamento "FORÇA" flutuando diretamente em cima da cabeça do
//    personagem (projetada em coordenadas de tela 3D -> 2D).
// 6. Exibição do Nível ("Nv. X") ao lado do nome nos crachás 3D da partida e na
//    tela de Vencedores e Perdedores (sem emojis, com desenho vetorial).
// ============================================================================

import * as THREE from '/vendor/three/three.module.js';

export class GameScene {
  constructor(canvasId, socket, controlsConfig, soundManager) {
    this.canvas = document.getElementById(canvasId);
    this.socket = socket;
    this.controlsConfig = controlsConfig;
    this.soundManager = soundManager;

    this.isActive = false;
    this.isVictoryStage = false;
    this.combatLocked = true;
    this.localSocketId = null;
    this.currentMap = null;
    this.baseArenaRadius = 12.0;
    this.currentArenaRadius = 12.0;

    this.playerMeshes = new Map();
    this.playerMetaCache = new Map();
    this.powerupMeshes = new Map();
    this.trampolineMeshes = [];
    this.victoryActors = [];
    this.shockwavePool = [];
    this.activeShockwaves = [];
    this.lightningBolts = [];
    this.abyssRings = [];
    this.abyssParticles = null;

    this.pressedCodes = new Set();
    this.touchMove = { x: 0, z: 0 };
    this.isChargingShove = false;
    this.isChargingGrab = false;
    this.localChargePower = 0;
    this.isLocalGrabbed = false;

    // Estado da Câmera Dinâmica (PC e Celular: gira o mapa ao arrastar para o lado e move frente/trás)
    this.cameraYaw = 0;
    this.cameraDistance = 21.0;
    this.cameraForwardOffset = 0.0;
    this.isDraggingCamera = false;
    this.cameraDragMoved = false;
    this.lastCameraPointer = { x: 0, y: 0 };
    this.cameraTouchId = null;

    // Estado da Cena de Vitória (queda do céu, impacto no chão, levantar + confete e chuva após 1s)
    this.victoryStageElapsed = 0;
    this.victoryAllStoodUpAt = null;
    this.victoryWeatherActive = false;
    this.confettiItems = [];
    this.rainItems = [];
    this.partyLightMeshes = [];
    this.tearItems = [];

    this.lastInputSentAt = 0;
    this.lastSentInput = {
      moveX: 0,
      moveZ: 0,
      charging: false,
      grabCharging: false
    };

    // Elementos DOM da barra "FORÇA" que flutua em cima da cabeça do personagem
    this.chargeContainerEl = document.getElementById('hud-charge-container');
    this.chargeBarEl = document.getElementById('hud-charge-fill');
    this.lastChargePct = -1;
    this.tempHeadVec = new THREE.Vector3();

    this.clock = new THREE.Clock();

    this.initSharedAssets();
    this.initThree();
    this.initShockwavePool(16);
    this.bindInputListeners();
    this.bindMobileControls();
    this.animate();
  }

  /**
   * Geometrias Low-Poly compartilhadas para reduzir consumo de GPU e VRAM.
   */
  initSharedAssets() {
    const markShared = (geo) => {
      geo.userData = { shared: true };
      return geo;
    };

    const shockGunGeo = new THREE.ConeGeometry(0.2, 0.58, 6);
    shockGunGeo.rotateX(Math.PI / 2);

    const stunRingGeo = new THREE.TorusGeometry(0.52, 0.06, 6, 12);
    stunRingGeo.rotateX(Math.PI / 2);

    const crownGeo = new THREE.CylinderGeometry(0.36, 0.28, 0.22, 6, 1, false);

    const pwrRingGeo = new THREE.RingGeometry(0.55, 0.78, 16);
    pwrRingGeo.rotateX(-Math.PI / 2);

    const swRingNormal = new THREE.RingGeometry(0.5, 0.95, 20);
    swRingNormal.rotateX(-Math.PI / 2);

    const swRingMega = new THREE.RingGeometry(0.5, 1.4, 24);
    swRingMega.rotateX(-Math.PI / 2);

    const baseRingNormal = new THREE.RingGeometry(0.68, 0.88, 18);
    baseRingNormal.rotateX(-Math.PI / 2);

    const baseRingLocal = new THREE.RingGeometry(0.68, 0.98, 20);
    baseRingLocal.rotateX(-Math.PI / 2);

    // Luva de Boxe Low-Poly (punho acolchoado + cano da luva)
    const boxingGloveGeo = new THREE.DodecahedronGeometry(0.38, 0);

    // Geometrias dos Trampolins (Circo Saltitante)
    const trampBaseGeo = new THREE.CylinderGeometry(1.38, 1.48, 0.24, 16);
    const trampPadGeo = new THREE.CylinderGeometry(1.18, 1.18, 0.14, 16);
    const trampRingGeo = new THREE.RingGeometry(1.16, 1.36, 20);
    trampRingGeo.rotateX(-Math.PI / 2);

    this.sharedGeos = {
      torso: markShared(new THREE.CylinderGeometry(0.46, 0.56, 0.92, 8)),
      head: markShared(new THREE.CylinderGeometry(0.38, 0.46, 0.34, 8)),
      visor: markShared(new THREE.BoxGeometry(0.62, 0.22, 0.24)),
      hand: markShared(new THREE.IcosahedronGeometry(0.22, 0)),
      boxingGlove: markShared(boxingGloveGeo),
      heavyShield: markShared(new THREE.CylinderGeometry(0.9, 0.9, 1.6, 10, 1, true)),
      shockCage: markShared(new THREE.IcosahedronGeometry(1.1, 0)),
      shockGun: markShared(shockGunGeo),
      stunRing: markShared(stunRingGeo),
      crown: markShared(crownGeo),
      powerupCrystal: markShared(new THREE.OctahedronGeometry(0.62, 0)),
      powerupRing: markShared(pwrRingGeo),
      shockwaveNormal: markShared(swRingNormal),
      shockwaveMega: markShared(swRingMega),
      baseRingNormal: markShared(baseRingNormal),
      baseRingLocal: markShared(baseRingLocal),
      trampBase: markShared(trampBaseGeo),
      trampPad: markShared(trampPadGeo),
      trampRing: markShared(trampRingGeo)
    };
  }

  disposeObject3D(obj) {
    if (!obj) return;
    obj.traverse((node) => {
      if (node.geometry && !node.geometry.userData?.shared) {
        node.geometry.dispose();
      }
      if (node.material) {
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        for (const m of mats) {
          if (!m || m.userData?.shared) continue;
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    });
  }

  clearAndDisposeGroup(group) {
    if (!group) return;
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      this.disposeObject3D(child);
    }
  }

  initThree() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070f);
    this.scene.fog = new THREE.FogExp2(0x05070f, 0.015);

    this.camera = new THREE.PerspectiveCamera(
      52,
      window.innerWidth / window.innerHeight,
      0.1,
      260
    );
    this.camera.position.set(0, 18, 22);
    this.camera.lookAt(0, 0, 0);

    const isMobileDevice = window.innerWidth <= 820 || 'ontouchstart' in window;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: !isMobileDevice,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobileDevice ? 1.5 : 2));
    this.renderer.shadowMap.enabled = !isMobileDevice;
    if (!isMobileDevice) {
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    this.scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xfff8e7, 1.3);
    dirLight.position.set(15, 28, 15);
    dirLight.castShadow = !isMobileDevice;
    if (!isMobileDevice) {
      dirLight.shadow.mapSize.width = 1024;
      dirLight.shadow.mapSize.height = 1024;
    }
    this.scene.add(dirLight);

    this.abyssGroup = new THREE.Group();
    this.scene.add(this.abyssGroup);

    this.arenaGroup = new THREE.Group();
    this.scene.add(this.arenaGroup);

    this.powerupsGroup = new THREE.Group();
    this.scene.add(this.powerupsGroup);

    this.playersGroup = new THREE.Group();
    this.scene.add(this.playersGroup);

    this.fxGroup = new THREE.Group();
    this.scene.add(this.fxGroup);

    this.victoryGroup = new THREE.Group();
    this.scene.add(this.victoryGroup);

    window.addEventListener('resize', () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.fov = w < h ? 66 : 52;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
  }

  initShockwavePool(size = 16) {
    for (let i = 0; i < size; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00e5ff,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide
      });
      mat.userData = { shared: true };
      const mesh = new THREE.Mesh(this.sharedGeos.shockwaveNormal, mat);
      mesh.visible = false;
      this.fxGroup.add(mesh);
      this.shockwavePool.push({
        mesh,
        mat,
        scale: 1,
        maxScale: 3,
        inUse: false
      });
    }
  }

  resetFxPool() {
    for (const sw of this.activeShockwaves) {
      sw.mesh.visible = false;
      sw.inUse = false;
    }
    this.activeShockwaves.length = 0;

    for (const bolt of this.lightningBolts) {
      this.fxGroup.remove(bolt.line);
      this.disposeObject3D(bolt.line);
    }
    this.lightningBolts.length = 0;
  }

  startMatch({ room, map, localSocketId }) {
    this.localSocketId = localSocketId;
    this.currentMap = map;
    this.baseArenaRadius = map?.physics?.radius || 12.0;
    this.currentArenaRadius = this.baseArenaRadius;

    this.isVictoryStage = false;
    this.combatLocked = true;
    this.clearVictoryStage();
    this.resetFxPool();

    this.pressedCodes.clear();
    this.touchMove = { x: 0, z: 0 };
    this.cameraForwardOffset = 0;
    this.isDraggingCamera = false;
    this.isChargingShove = false;
    this.isChargingGrab = false;
    this.localChargePower = 0;
    this.isLocalGrabbed = false;
    this.lastInputSentAt = 0;
    this.lastSentInput = { moveX: 0, moveZ: 0, charging: false, grabCharging: false };

    this.buildArenaFromMap(map);
    this.clearPlayers();
    this.clearPowerups();

    this.playerMetaCache.clear();
    if (room && Array.isArray(room.players)) {
      this.teamColorLookup = new Map();
      if (Array.isArray(room.availableTeams)) {
        room.availableTeams.forEach((t) => this.teamColorLookup.set(t.id, t));
      }
      room.players.forEach((p) => {
        const id = p.id || p.socketId;
        this.playerMetaCache.set(id, p);
        this.ensurePlayerMesh(p);
      });
    }

    this.canvas.classList.remove('hidden');
    this.isActive = true;
  }

  stopMatch() {
    this.isActive = false;
    this.isVictoryStage = false;
    this.pressedCodes.clear();
    this.touchMove = { x: 0, z: 0 };
    this.isChargingShove = false;
    this.isChargingGrab = false;
    this.isLocalGrabbed = false;
    this.clearPlayers();
    this.clearPowerups();
    this.clearVictoryStage();
    this.resetFxPool();
    this.canvas.classList.add('hidden');
  }

  buildAbyssEnvironment(theme, radius, sides) {
    this.clearAndDisposeGroup(this.abyssGroup);
    this.abyssRings = [];
    this.abyssParticles = null;

    const borderColor = new THREE.Color(theme.borderColor || '#ff3366');
    const centerColor = new THREE.Color(theme.centerColor || '#00e5ff');

    const numDepthLevels = 6;
    for (let i = 1; i <= numDepthLevels; i++) {
      const depthY = -4.2 * i;
      const ringRadius = radius * (1.28 + i * 0.14);
      const ringGeo = new THREE.RingGeometry(
        ringRadius,
        ringRadius + 0.45,
        Math.min(18, Math.max(10, sides))
      );
      ringGeo.rotateX(-Math.PI / 2);

      const fade = Math.max(0.06, 0.34 - i * 0.045);
      const ringMat = new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? centerColor : borderColor,
        transparent: true,
        opacity: fade,
        side: THREE.DoubleSide
      });

      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.position.y = depthY;
      this.abyssGroup.add(ringMesh);
      this.abyssRings.push({ mesh: ringMesh, speed: (i % 2 === 0 ? 1 : -1) * (0.15 + i * 0.03) });
    }

    const monolithMat = new THREE.MeshLambertMaterial({
      color: 0x0c1021,
      flatShading: true
    });
    const monolithCount = 8;
    for (let i = 0; i < monolithCount; i++) {
      const angle = (i / monolithCount) * Math.PI * 2;
      const dist = radius + 11 + (i % 3) * 4;
      const height = 28 + (i % 4) * 8;
      const mGeo = new THREE.CylinderGeometry(1.1, 2.1, height, 5);
      const mMesh = new THREE.Mesh(mGeo, monolithMat);
      mMesh.position.set(
        Math.cos(angle) * dist,
        -height * 0.55 - 3,
        Math.sin(angle) * dist
      );
      this.abyssGroup.add(mMesh);
    }

    const particleCount = 90;
    const positions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = radius * 1.15 + Math.random() * 18;
      positions[i * 3] = Math.cos(ang) * r;
      positions[i * 3 + 1] = -36 + Math.random() * 44;
      positions[i * 3 + 2] = Math.sin(ang) * r;
    }

    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const pMat = new THREE.PointsMaterial({
      color: borderColor,
      size: 0.35,
      transparent: true,
      opacity: 0.65
    });

    this.abyssParticles = new THREE.Points(pGeo, pMat);
    this.abyssGroup.add(this.abyssParticles);
  }

  /**
   * Exibe o Campo Final de Vitória Exclusivo com 2 Lados (NÃO usa mapas da partida):
   * - Lado Esquerdo (Vencedores): Feliz, em festa, pista iluminada com luzes coloridas e confetes!
   * - Lado Direito (Perdedores): Triste, escuro, chuvoso, com poças d'água e personagens chorando!
   * - Os bonecos caem do céu em seus respectivos lados, batem no chão e se levantam;
   *   logo depois de 1s, começam as luzes de festa + confetes e a chuva + choro!
   */
  showVictoryStage(result) {
    this.isVictoryStage = true;
    this.isActive = true;
    this.pressedCodes.clear();
    this.isChargingShove = false;
    this.isChargingGrab = false;

    if (this.chargeContainerEl) {
      this.chargeContainerEl.classList.add('hidden');
    }

    // Remove completamente qualquer mapa da partida e abismo
    this.clearPlayers();
    this.clearPowerups();
    this.resetFxPool();
    this.clearAndDisposeGroup(this.arenaGroup);
    this.clearAndDisposeGroup(this.abyssGroup);
    this.abyssRings = [];
    this.abyssParticles = null;
    this.trampolineMeshes = [];
    this.clearVictoryStage();

    this.scene.background = new THREE.Color(0x070913);
    this.scene.fog = new THREE.FogExp2(0x070913, 0.015);

    // ========================================================================
    // 1. LADO ESQUERDO (VENCEDORES): PALCO FELIZ EM FESTA COM PISTA ILUMINADA
    // ========================================================================
    const winStageGeo = new THREE.BoxGeometry(9.4, 1.2, 8.6);
    const winStageMat = new THREE.MeshLambertMaterial({
      color: 0x1b2a4a,
      flatShading: true
    });
    const winStage = new THREE.Mesh(winStageGeo, winStageMat);
    winStage.position.set(-5.0, -0.6, 0);
    this.victoryGroup.add(winStage);

    // Borda neon dourada do lado em festa
    const winBorderGeo = new THREE.BoxGeometry(9.65, 0.14, 8.85);
    const winBorderMat = new THREE.MeshBasicMaterial({ color: 0xffd600 });
    const winBorder = new THREE.Mesh(winBorderGeo, winBorderMat);
    winBorder.position.set(-5.0, -0.04, 0);
    this.victoryGroup.add(winBorder);

    // Ladrilhos coloridos de pista de dança / festa no lado dos vencedores
    const danceColors = [0xff3366, 0x00e676, 0x00e5ff, 0xffd600, 0xaa00ff, 0xff6d00];
    const tileGeo = new THREE.PlaneGeometry(2.3, 2.1);
    tileGeo.rotateX(-Math.PI / 2);
    let tileIdx = 0;
    for (let gx = -1; gx <= 1; gx++) {
      for (let gz = -1; gz <= 1; gz++) {
        const tileMat = new THREE.MeshBasicMaterial({
          color: danceColors[tileIdx % danceColors.length],
          transparent: true,
          opacity: 0.42,
          side: THREE.DoubleSide
        });
        const tile = new THREE.Mesh(tileGeo, tileMat);
        tile.position.set(-5.0 + gx * 2.6, 0.02, gz * 2.35);
        this.victoryGroup.add(tile);
        this.partyLightMeshes.push({
          mesh: tile,
          mat: tileMat,
          baseColorHex: danceColors[tileIdx % danceColors.length],
          phase: tileIdx * 0.8,
          isBeam: false
        });
        tileIdx++;
      }
    }

    // ========================================================================
    // 2. LADO DIREITO (PERDEDORES): PALCO TRISTE, ESCURO E CHUVOSO
    // ========================================================================
    const loseStageGeo = new THREE.BoxGeometry(9.4, 1.2, 8.6);
    const loseStageMat = new THREE.MeshLambertMaterial({
      color: 0x141824,
      flatShading: true
    });
    const loseStage = new THREE.Mesh(loseStageGeo, loseStageMat);
    loseStage.position.set(5.0, -0.6, 0);
    this.victoryGroup.add(loseStage);

    const loseBorderGeo = new THREE.BoxGeometry(9.65, 0.12, 8.85);
    const loseBorderMat = new THREE.MeshBasicMaterial({ color: 0x334155 });
    const loseBorder = new THREE.Mesh(loseBorderGeo, loseBorderMat);
    loseBorder.position.set(5.0, -0.05, 0);
    this.victoryGroup.add(loseBorder);

    // Poças d'água frias no chão triste dos perdedores
    const puddleMat = new THREE.MeshBasicMaterial({
      color: 0x1e3a5f,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide
    });
    const puddles = [
      { x: 3.4, z: 1.5, r: 1.45 },
      { x: 6.2, z: -1.2, r: 1.65 },
      { x: 4.8, z: -2.4, r: 1.15 },
      { x: 5.9, z: 2.2, r: 1.25 }
    ];
    puddles.forEach((p) => {
      const pGeo = new THREE.CircleGeometry(p.r, 16);
      pGeo.rotateX(-Math.PI / 2);
      const pMesh = new THREE.Mesh(pGeo, puddleMat);
      pMesh.position.set(p.x, 0.02, p.z);
      this.victoryGroup.add(pMesh);
    });

    this.victoryStageElapsed = 0;
    this.victoryAllStoodUpAt = null;
    this.victoryWeatherActive = false;

    const winners = Array.isArray(result?.winnersList) ? result.winnersList : [];
    winners.forEach((w, idx) => {
      const isMe = w.id === this.localSocketId;
      const lvl = w.level || 1;
      const actor = this.createVictoryShoverMesh(
        w.skinColor || '#00E676',
        `${w.username} • Nv.${lvl}`,
        '#FFD600',
        true,
        isMe
      );
      const row = Math.floor(idx / 3);
      const col = idx % 3;
      const colsInRow = Math.min(3, winners.length - row * 3);
      const offsetX = (col - (colsInRow - 1) / 2) * 2.15;
      const offsetZ = (row - 0.3) * 1.95;

      const startSkyY = 18.0 + (idx % 3) * 1.35;
      actor.group.position.set(-5.0 + offsetX, startSkyY, offsetZ);
      actor.group.rotation.y = 0.18;
      this.victoryGroup.add(actor.group);
      this.victoryActors.push({
        ...actor,
        isWinner: true,
        baseY: 0,
        vy: -2.0,
        state: 'FALLING',
        impactElapsed: 0,
        getUpElapsed: 0,
        phase: idx * 0.9
      });
    });

    const losers = Array.isArray(result?.losersList) ? result.losersList : [];
    losers.forEach((l, idx) => {
      const isMe = l.id === this.localSocketId;
      const lvl = l.level || 1;
      const actor = this.createVictoryShoverMesh(
        l.skinColor || '#FF3366',
        `${l.username} • Nv.${lvl}`,
        isMe ? '#FFD600' : '#9aa5ce',
        false,
        isMe
      );
      const cols = 4;
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const colsInRow = Math.min(cols, losers.length - row * cols);
      const offsetX = (col - (colsInRow - 1) / 2) * 1.85;
      const offsetZ = (row - 0.5) * 1.85;

      const startSkyY = 18.2 + (idx % 4) * 1.25;
      actor.group.position.set(5.0 + offsetX, startSkyY, offsetZ);
      actor.group.rotation.y = -0.18;
      this.victoryGroup.add(actor.group);
      this.victoryActors.push({
        ...actor,
        isWinner: false,
        baseY: 0,
        vy: -2.0,
        state: 'FALLING',
        impactElapsed: 0,
        getUpElapsed: 0,
        phase: idx * 0.7
      });
    });

    this.cameraYaw = 0;
    this.cameraForwardOffset = 0;
    this.cameraDistance = 17.5;
    this.camera.position.set(0, 6.8, 17.5);
    this.camera.lookAt(0, 1.0, 0);
  }

  /**
   * Inicia (1s após os personagens baterem no chão e se levantarem):
   * - Lado Esquerdo (Vencedores): Feixes de luzes de festa + Confetes coloridos caindo!
   * - Lado Direito (Perdedores): Tempestade de chuva + Lágrimas caindo dos olhos dos perdedores!
   */
  startVictoryWeather() {
    if (this.victoryWeatherActive) return;
    this.victoryWeatherActive = true;

    // 1. Luzes de Festa (Spotlights / Cones de Luz) no lado dos Vencedores (Esquerda)
    const beamColors = [0xffd600, 0x00e676, 0x00e5ff, 0xff3366];
    const beamGeo = new THREE.ConeGeometry(2.2, 9.5, 12, 1, true);
    for (let b = 0; b < 4; b++) {
      const beamMat = new THREE.MeshBasicMaterial({
        color: beamColors[b % beamColors.length],
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.set(-7.4 + b * 1.65, 4.75, (b % 2 === 0 ? -1 : 1) * 1.2);
      this.victoryGroup.add(beam);
      this.partyLightMeshes.push({
        mesh: beam,
        mat: beamMat,
        baseX: beam.position.x,
        phase: b * 1.3,
        isBeam: true
      });
    }

    // 2. Confetes coloridos caindo no lado dos Vencedores (Esquerda)
    const confettiColors = [0xffd600, 0x00e676, 0x00e5ff, 0xff3366, 0xaa00ff, 0xff6d00];
    const confettiGeo = new THREE.PlaneGeometry(0.28, 0.16);

    for (let i = 0; i < 90; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: confettiColors[i % confettiColors.length],
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(confettiGeo, mat);
      mesh.position.set(
        -5.0 + (Math.random() - 0.5) * 8.2,
        7.0 + Math.random() * 9.0,
        (Math.random() - 0.5) * 7.4
      );
      mesh.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      );
      this.victoryGroup.add(mesh);
      this.confettiItems.push({
        mesh,
        speedY: 2.6 + Math.random() * 2.2,
        swaySpeed: 2.0 + Math.random() * 2.5,
        swayAmp: 0.6 + Math.random() * 0.8,
        rotSpeedX: (Math.random() - 0.5) * 6,
        rotSpeedY: (Math.random() - 0.5) * 6,
        rotSpeedZ: (Math.random() - 0.5) * 6,
        phase: Math.random() * Math.PI * 2
      });
    }

    // 3. Nuvem escura de tempestade no topo do lado dos Perdedores (Direita)
    const cloudMat = new THREE.MeshLambertMaterial({
      color: 0x1e293b,
      flatShading: true,
      transparent: true,
      opacity: 0.92
    });
    for (let c = 0; c < 6; c++) {
      const puffGeo = new THREE.DodecahedronGeometry(1.65 + (c % 2) * 0.45, 0);
      const puff = new THREE.Mesh(puffGeo, cloudMat);
      puff.position.set(2.6 + c * 0.95, 8.8 + (c % 2) * 0.35, (c % 3 - 1) * 1.15);
      this.victoryGroup.add(puff);
    }

    // 4. Gotas de chuva caindo no lado dos Perdedores (Direita)
    const rainDropGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.68, 4);
    const rainDropMat = new THREE.MeshBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.8
    });

    for (let i = 0; i < 100; i++) {
      const drop = new THREE.Mesh(rainDropGeo, rainDropMat);
      drop.position.set(
        5.0 + (Math.random() - 0.5) * 8.2,
        1.0 + Math.random() * 7.8,
        (Math.random() - 0.5) * 7.4
      );
      this.victoryGroup.add(drop);
      this.rainItems.push({
        mesh: drop,
        speedY: 15.0 + Math.random() * 6.0
      });
    }

    // 5. Lágrimas 3D jorrando dos olhos dos Perdedores (Personagens Chorando)
    const tearGeo = new THREE.SphereGeometry(0.075, 6, 6);
    const tearMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff });

    for (const actor of this.victoryActors) {
      if (!actor.isWinner) {
        for (let t = 0; t < 6; t++) {
          const side = t % 2 === 0 ? -1 : 1;
          const tearMesh = new THREE.Mesh(tearGeo, tearMat);
          tearMesh.position.set(side * 0.22, 1.12 - (t * 0.16), 0.42);
          actor.body.add(tearMesh);
          this.tearItems.push({
            mesh: tearMesh,
            side,
            offsetY: (t / 6) * 0.95,
            speed: 1.15 + (t % 3) * 0.2,
            phase: t * 0.9 + actor.phase
          });
        }
      }
    }
  }

  createVictoryShoverMesh(colorHex, labelText, borderColor, isWinner, isLocal = false) {
    const group = new THREE.Group();

    const bodyMat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(colorHex),
      flatShading: true
    });

    const body = new THREE.Group();
    const torso = new THREE.Mesh(this.sharedGeos.torso, bodyMat);
    torso.position.y = 0.56;
    body.add(torso);

    const head = new THREE.Mesh(this.sharedGeos.head, bodyMat);
    head.position.y = 1.18;
    body.add(head);

    const visorMat = new THREE.MeshBasicMaterial({
      color: isWinner ? 0xffffff : 0xbae6fd
    });
    const visor = new THREE.Mesh(this.sharedGeos.visor, visorMat);
    visor.position.set(0, 1.18, 0.36);
    body.add(visor);

    const leftHand = new THREE.Mesh(this.sharedGeos.hand, bodyMat);
    const rightHand = new THREE.Mesh(this.sharedGeos.hand, bodyMat);
    leftHand.position.set(-0.75, 0.85, 0.28);
    rightHand.position.set(0.75, 0.85, 0.28);
    body.add(leftHand, rightHand);

    if (isWinner) {
      const crownMat = new THREE.MeshBasicMaterial({ color: 0xffd600 });
      const crown = new THREE.Mesh(this.sharedGeos.crown, crownMat);
      crown.position.y = 1.52;
      body.add(crown);
    }

    group.add(body);

    const nameplate = this.createNameplateSprite(labelText, borderColor, 2.85, isLocal);
    nameplate.position.set(0, 2.35, 0);
    group.add(nameplate);

    return { group, body, visor, leftHand, rightHand };
  }

  clearVictoryStage() {
    this.clearAndDisposeGroup(this.victoryGroup);
    this.victoryActors = [];
    this.confettiItems = [];
    this.rainItems = [];
    this.partyLightMeshes = [];
    this.tearItems = [];
    this.victoryWeatherActive = false;
    this.victoryAllStoodUpAt = null;
    this.victoryStageElapsed = 0;
  }

  buildArenaFromMap(map) {
    this.clearAndDisposeGroup(this.arenaGroup);
    this.trampolineMeshes = [];

    const theme = map?.theme || {};
    const physics = map?.physics || {};
    const radius = physics.radius || 12.0;
    const sides = physics.sides || 12;
    const innerHole = physics.innerHoleRadius || 0;

    this.scene.background = new THREE.Color(theme.background || '#060812');
    this.scene.fog = new THREE.FogExp2(theme.background || '#060812', 0.014);

    this.buildAbyssEnvironment(theme, radius, sides);

    this.scalablePlatformGroup = new THREE.Group();

    const platformMat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(theme.platformColor || '#232946'),
      flatShading: true
    });

    if (innerHole > 0) {
      const shape = new THREE.Shape();
      shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
      const holePath = new THREE.Path();
      holePath.absarc(0, 0, innerHole, 0, Math.PI * 2, true);
      shape.holes.push(holePath);

      const extrudeGeo = new THREE.ExtrudeGeometry(shape, {
        depth: 2.6,
        bevelEnabled: false,
        curveSegments: sides
      });
      extrudeGeo.rotateX(Math.PI / 2);
      const donutMesh = new THREE.Mesh(extrudeGeo, platformMat);
      donutMesh.position.y = 0;
      this.scalablePlatformGroup.add(donutMesh);

      const innerRingGeo = new THREE.RingGeometry(innerHole, innerHole + 0.55, sides);
      innerRingGeo.rotateX(-Math.PI / 2);
      const innerRingMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(theme.centerColor || '#ff4081'),
        side: THREE.DoubleSide
      });
      const innerRing = new THREE.Mesh(innerRingGeo, innerRingMat);
      innerRing.position.y = 0.03;
      this.scalablePlatformGroup.add(innerRing);
    } else {
      const cylGeo = new THREE.CylinderGeometry(radius, radius * 0.65, 3.8, sides);
      const platformMesh = new THREE.Mesh(cylGeo, platformMat);
      platformMesh.position.y = -1.9;
      this.scalablePlatformGroup.add(platformMesh);

      const centerGeo = new THREE.RingGeometry(2.4, 2.9, sides);
      centerGeo.rotateX(-Math.PI / 2);
      const centerMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(theme.centerColor || '#00e5ff'),
        side: THREE.DoubleSide
      });
      const centerRing = new THREE.Mesh(centerGeo, centerMat);
      centerRing.position.y = 0.03;
      this.scalablePlatformGroup.add(centerRing);
    }

    const outerRingGeo = new THREE.RingGeometry(radius - 0.65, radius, sides);
    outerRingGeo.rotateX(-Math.PI / 2);
    const outerRingMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(theme.borderColor || '#ff3366'),
      side: THREE.DoubleSide
    });
    const outerRing = new THREE.Mesh(outerRingGeo, outerRingMat);
    outerRing.position.y = 0.03;
    this.scalablePlatformGroup.add(outerRing);

    this.arenaGroup.add(this.scalablePlatformGroup);

    // Pilares elásticos (Templo dos Pilares)
    if (Array.isArray(physics.pillars) && physics.pillars.length > 0) {
      const pillarMat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(theme.borderColor || '#00e676'),
        flatShading: true
      });
      const ringMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(theme.centerColor || '#ffd600')
      });

      physics.pillars.forEach((pil) => {
        const pGroup = new THREE.Group();
        const pGeo = new THREE.CylinderGeometry(pil.radius, pil.radius, 2.6, 10);
        const pMesh = new THREE.Mesh(pGeo, pillarMat);
        pMesh.position.y = 1.3;
        pGroup.add(pMesh);

        const torusGeo = new THREE.TorusGeometry(pil.radius + 0.08, 0.12, 8, 16);
        torusGeo.rotateX(Math.PI / 2);
        const torusMesh = new THREE.Mesh(torusGeo, ringMat);
        torusMesh.position.y = 1.0;
        pGroup.add(torusMesh);

        pGroup.position.set(pil.x, 0, pil.z);
        this.arenaGroup.add(pGroup);
      });
    }

    // 5 Trampolins Elásticos (Novo Mapa: Circo Saltitante)
    if (Array.isArray(physics.trampolines) && physics.trampolines.length > 0) {
      const baseMat = new THREE.MeshLambertMaterial({
        color: 0x1a1e36,
        flatShading: true
      });
      const padMat = new THREE.MeshBasicMaterial({
        color: 0xff007f
      });
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffd600,
        side: THREE.DoubleSide
      });

      physics.trampolines.forEach((tramp) => {
        const tGroup = new THREE.Group();
        const scaleRatio = (tramp.radius || 1.3) / 1.3;

        const baseMesh = new THREE.Mesh(this.sharedGeos.trampBase, baseMat);
        baseMesh.position.y = 0.12;
        tGroup.add(baseMesh);

        const padGroup = new THREE.Group();
        const padMesh = new THREE.Mesh(this.sharedGeos.trampPad, padMat);
        padMesh.position.y = 0.26;
        padGroup.add(padMesh);

        const ringMesh = new THREE.Mesh(this.sharedGeos.trampRing, ringMat);
        ringMesh.position.y = 0.34;
        padGroup.add(ringMesh);

        tGroup.add(padGroup);
        tGroup.scale.set(scaleRatio, 1, scaleRatio);
        tGroup.position.set(tramp.x, 0, tramp.z);

        this.arenaGroup.add(tGroup);
        this.trampolineMeshes.push({
          group: tGroup,
          padGroup,
          bounceEnergy: 0
        });
      });
    }

    // Visual Lunar de Crateras Brilhantes para o novo mapa "Lua Cintilante"
    if (map?.id === 'map_sparkling_moon' || physics.lowGravity) {
      const craterMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(theme.borderColor || '#38bdf8'),
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide
      });
      const craters = [
        { x: -4.2, z: -3.5, r: 1.5 },
        { x: 4.6, z: 3.2, r: 1.8 },
        { x: -3.8, z: 4.4, r: 1.2 },
        { x: 3.9, z: -4.1, r: 1.4 }
      ];
      craters.forEach((c) => {
        const cGeo = new THREE.RingGeometry(c.r * 0.65, c.r, 16);
        cGeo.rotateX(-Math.PI / 2);
        const cMesh = new THREE.Mesh(cGeo, craterMat);
        cMesh.position.set(c.x, 0.04, c.z);
        this.arenaGroup.add(cMesh);
      });
    }
  }

  /**
   * Anima o trampolim quando um jogador salta nele no mapa Circo Saltitante.
   */
  onTrampolineJump({ trampIndex, x, z }) {
    if (!this.isActive || this.isVictoryStage) return;
    const trampObj = this.trampolineMeshes[trampIndex];
    if (trampObj) {
      trampObj.bounceEnergy = 1.0;
    }
    this.spawnShockwave({ x, z, power: 0.7, isMega: false });
  }

  clearPlayers() {
    this.clearAndDisposeGroup(this.playersGroup);
    this.playerMeshes.clear();
  }

  clearPowerups() {
    this.clearAndDisposeGroup(this.powerupsGroup);
    this.powerupMeshes.clear();
  }

  /**
   * Cria um Sprite 2D com o nickname + nível do jogador e marcadores vetoriais (sem emojis).
   */
  createNameplateSprite(text, borderColor = '#ffffff', scaleW = 2.8, isLocalPlayer = false) {
    const canvas = document.createElement('canvas');
    canvas.width = 280;
    canvas.height = 80;
    const ctx = canvas.getContext('2d');

    const finalBorder = isLocalPlayer ? '#FFD600' : borderColor;

    ctx.fillStyle = isLocalPlayer ? 'rgba(20, 18, 6, 0.92)' : 'rgba(10, 14, 28, 0.84)';
    ctx.strokeStyle = finalBorder;
    ctx.lineWidth = isLocalPlayer ? 5 : 4;
    ctx.beginPath();
    ctx.roundRect(8, 6, 264, 44, 20);
    ctx.fill();
    ctx.stroke();

    ctx.font = isLocalPlayer
      ? '900 19px system-ui, sans-serif'
      : 'bold 17px system-ui, sans-serif';
    ctx.fillStyle = isLocalPlayer ? '#FFD600' : '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const safeText = String(text || 'Jogador').substring(0, 24);
    ctx.fillText(safeText, 140, 29);

    if (isLocalPlayer) {
      ctx.fillStyle = '#FFD600';
      ctx.beginPath();
      ctx.moveTo(128, 56);
      ctx.lineTo(152, 56);
      ctx.lineTo(140, 74);
      ctx.closePath();
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    const finalWidth = isLocalPlayer ? scaleW * 1.18 : scaleW;
    const finalHeight = isLocalPlayer ? 0.92 : 0.74;
    sprite.scale.set(finalWidth, finalHeight, 1);
    sprite.position.set(0, isLocalPlayer ? 2.48 : 2.32, 0);
    sprite.renderOrder = isLocalPlayer ? 999 : 10;
    return sprite;
  }

  /**
   * Cria o modelo 3D Low-Poly do jogador, incluindo a Luva de Boxe 3D e suporte
   * à rotação de Nocaute (deitado no chão por 2 segundos).
   */
  ensurePlayerMesh(pData) {
    const id = pData.id || pData.socketId;
    if (this.playerMeshes.has(id)) {
      return this.playerMeshes.get(id);
    }

    const cachedMeta = this.playerMetaCache.get(id) || {};
    const username = pData.username || cachedMeta.username || 'Jogador';
    const skinColor = pData.skinColor || cachedMeta.skinColor || '#FF3366';
    const level = pData.level || cachedMeta.level || cachedMeta.stats?.level || 1;
    const teamId = pData.teamId !== undefined ? pData.teamId : cachedMeta.teamId;

    const isLocal = id === this.localSocketId;
    const group = new THREE.Group();

    // visualRoot agrupa o corpo e as mãos para podermos deitar o personagem no chão
    // durante os 2 segundos de nocaute da Luva de Boxe!
    const visualRoot = new THREE.Group();
    group.add(visualRoot);

    const bodyMat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(skinColor),
      flatShading: true,
      transparent: true,
      opacity: 1.0
    });

    const torso = new THREE.Mesh(this.sharedGeos.torso, bodyMat);
    torso.position.y = 0.56;
    visualRoot.add(torso);

    const head = new THREE.Mesh(this.sharedGeos.head, bodyMat);
    head.position.y = 1.18;
    visualRoot.add(head);

    const visorMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0
    });
    const visor = new THREE.Mesh(this.sharedGeos.visor, visorMat);
    visor.position.set(0, 1.18, 0.36);
    visualRoot.add(visor);

    const handMat = bodyMat.clone();
    const leftHand = new THREE.Mesh(this.sharedGeos.hand, handMat);
    leftHand.position.set(-0.72, 0.88, 0.3);
    const rightHand = new THREE.Mesh(this.sharedGeos.hand, handMat);
    rightHand.position.set(0.72, 0.88, 0.3);
    visualRoot.add(leftHand, rightHand);

    // Luva de Boxe 3D equipada sobre a mão direita quando o jogador pega o power-up
    const boxingGloveMat = new THREE.MeshLambertMaterial({
      color: 0xff1744,
      flatShading: true
    });
    const boxingGloveMesh = new THREE.Mesh(this.sharedGeos.boxingGlove, boxingGloveMat);
    boxingGloveMesh.position.set(0, 0, 0.14);
    boxingGloveMesh.visible = false;
    rightHand.add(boxingGloveMesh);

    const heavyShieldMat = new THREE.MeshBasicMaterial({
      color: 0xffd600,
      wireframe: true,
      transparent: true,
      opacity: 0.75
    });
    const heavyShield = new THREE.Mesh(this.sharedGeos.heavyShield, heavyShieldMat);
    heavyShield.position.y = 0.95;
    heavyShield.visible = false;
    group.add(heavyShield);

    const shockCageMat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      wireframe: true
    });
    const shockCage = new THREE.Mesh(this.sharedGeos.shockCage, shockCageMat);
    shockCage.position.y = 1.0;
    shockCage.visible = false;
    group.add(shockCage);

    const shockGunMat = new THREE.MeshBasicMaterial({ color: 0xaa00ff });
    const shockGun = new THREE.Mesh(this.sharedGeos.shockGun, shockGunMat);
    shockGun.position.set(0.82, 1.05, 0.62);
    shockGun.visible = false;
    visualRoot.add(shockGun);

    const stunRingMat = new THREE.MeshBasicMaterial({ color: 0xffd600 });
    const stunRing = new THREE.Mesh(this.sharedGeos.stunRing, stunRingMat);
    stunRing.position.y = 1.95;
    stunRing.visible = false;
    group.add(stunRing);

    const teamMeta = teamId && this.teamColorLookup ? this.teamColorLookup.get(teamId) : null;
    const ringColor = isLocal ? '#FFD600' : teamMeta ? teamMeta.color : '#ffffff';

    const baseRingMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(ringColor),
      side: THREE.DoubleSide
    });
    const baseRing = new THREE.Mesh(
      isLocal ? this.sharedGeos.baseRingLocal : this.sharedGeos.baseRingNormal,
      baseRingMat
    );
    baseRing.position.y = 0.04;
    group.add(baseRing);

    const labelText = `${username} • Nv.${level}`;
    const nameplate = this.createNameplateSprite(labelText, ringColor, 2.8, isLocal);
    group.add(nameplate);

    this.playersGroup.add(group);

    const meshRecord = {
      id,
      group,
      visualRoot,
      bodyMat,
      visorMat,
      handMat,
      leftHand,
      rightHand,
      boxingGloveMesh,
      heavyShield,
      shockCage,
      shockGun,
      stunRing,
      baseRing,
      nameplate,
      baseColorHex: skinColor,
      targetPos: new THREE.Vector3(pData.x || 0, pData.y || 0, pData.z || 0),
      vel: new THREE.Vector3(0, 0, 0),
      targetRot: pData.ry || 0,
      charge: 0,
      grabbedTargetId: null,
      grabbedById: null,
      stunned: false,
      invisible: false,
      heavy: false,
      shocked: false,
      knockedOut: false,
      hasMegaShove: false,
      hasShockWeapon: false,
      hasBoxingGlove: false,
      alive: true
    };

    group.position.copy(meshRecord.targetPos);
    this.playerMeshes.set(id, meshRecord);
    return meshRecord;
  }

  syncPowerupMeshes(powerupsList = []) {
    const activeIds = new Set();

    powerupsList.forEach((pwr) => {
      activeIds.add(pwr.id);
      let meshGroup = this.powerupMeshes.get(pwr.id);

      if (!meshGroup) {
        meshGroup = new THREE.Group();

        const mat = new THREE.MeshLambertMaterial({
          color: new THREE.Color(pwr.color || '#00E5FF'),
          emissive: new THREE.Color(pwr.color || '#00E5FF'),
          emissiveIntensity: 0.35,
          flatShading: true
        });
        const crystal = new THREE.Mesh(this.sharedGeos.powerupCrystal, mat);
        meshGroup.add(crystal);

        const ringMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(pwr.color || '#00E5FF'),
          side: THREE.DoubleSide
        });
        const ring = new THREE.Mesh(this.sharedGeos.powerupRing, ringMat);
        ring.position.y = -0.55;
        meshGroup.add(ring);

        const label = this.createNameplateSprite(pwr.name, pwr.color, 2.4, false);
        label.position.set(0, 1.15, 0);
        meshGroup.add(label);

        meshGroup.userData = { crystal };
        this.powerupsGroup.add(meshGroup);
        this.powerupMeshes.set(pwr.id, meshGroup);
      }

      meshGroup.position.set(pwr.x, pwr.y, pwr.z);
    });

    for (const [id, meshGroup] of this.powerupMeshes.entries()) {
      if (!activeIds.has(id)) {
        this.powerupsGroup.remove(meshGroup);
        this.disposeObject3D(meshGroup);
        this.powerupMeshes.delete(id);
      }
    }
  }

  onServerState(state) {
    if (!this.isActive || this.isVictoryStage || !state) return;

    this.combatLocked = Boolean(state.combatLocked);

    if (typeof state.arenaRadius === 'number') {
      this.currentArenaRadius = state.arenaRadius;
      if (this.scalablePlatformGroup && this.baseArenaRadius > 0) {
        const scale = this.currentArenaRadius / this.baseArenaRadius;
        this.scalablePlatformGroup.scale.set(scale, 1, scale);
      }
    }

    if (Array.isArray(state.powerups)) {
      this.syncPowerupMeshes(state.powerups);
    }

    if (Array.isArray(state.players)) {
      for (let i = 0; i < state.players.length; i++) {
        const p = state.players[i];
        const record = this.ensurePlayerMesh(p);
        record.targetPos.set(p.x, p.y, p.z);
        record.vel.set(p.vx || 0, p.vy || 0, p.vz || 0);
        record.targetRot = p.ry;
        record.charge = p.charge || 0;
        record.grabbedTargetId = p.grabbedTargetId;
        record.grabbedById = p.grabbedById;
        record.stunned = Boolean(p.stunned);
        record.invisible = Boolean(p.invisible);
        record.heavy = Boolean(p.heavy);
        record.shocked = Boolean(p.shocked);
        record.knockedOut = Boolean(p.knockedOut);
        record.hasMegaShove = Boolean(p.hasMegaShove);
        record.hasShockWeapon = Boolean(p.hasShockWeapon);
        record.hasBoxingGlove = Boolean(p.hasBoxingGlove);
        record.alive = p.alive;

        const isLocal = p.id === this.localSocketId;
        if (!p.alive) {
          record.alive = false;
          record.group.visible = false;
          if (isLocal) {
            this.localChargePower = 0;
            this.isLocalGrabbed = false;
          }
          continue;
        }
        if (record.invisible && !isLocal) {
          record.group.visible = false;
        } else {
          record.group.visible = true;
          const targetOpacity = record.invisible && isLocal ? 0.42 : 1.0;
          if (record.bodyMat.opacity !== targetOpacity) {
            record.bodyMat.opacity = targetOpacity;
            record.visorMat.opacity = targetOpacity;
            record.handMat.opacity = targetOpacity;
          }
        }

        record.heavyShield.visible = record.heavy;
        record.shockCage.visible = record.shocked;
        record.shockGun.visible = record.hasShockWeapon;
        record.boxingGloveMesh.visible = record.hasBoxingGlove;
        record.stunRing.visible = record.stunned || record.knockedOut;

        if (record.hasMegaShove) {
          record.handMat.color.setHex(0xffd600);
        } else {
          record.handMat.color.set(record.baseColorHex);
        }

        if (isLocal) {
          this.localChargePower = p.charge || 0;
          this.isLocalGrabbed = Boolean(p.grabbedById);
        }
      }
    }
  }

  spawnShockwave({ x, z, power = 0.6, isMega = false }) {
    if (!this.isActive || this.isVictoryStage) return;

    let item = null;
    for (let i = 0; i < this.shockwavePool.length; i++) {
      if (!this.shockwavePool[i].inUse) {
        item = this.shockwavePool[i];
        break;
      }
    }
    if (!item) return;

    item.inUse = true;
    item.scale = 1;
    item.maxScale = isMega ? 6.5 : 2.8 + power * 1.8;
    item.mesh.geometry = isMega ? this.sharedGeos.shockwaveMega : this.sharedGeos.shockwaveNormal;
    item.mat.color.setHex(isMega ? 0xffd600 : power > 0.75 ? 0xff3366 : 0x00e5ff);
    item.mat.opacity = 0.95;
    item.mesh.position.set(x, 0.15, z);
    item.mesh.scale.setScalar(1);
    item.mesh.visible = true;

    this.activeShockwaves.push(item);
  }

  spawnLightningBolt({ fromX, fromZ, toX, toZ }) {
    if (!this.isActive || this.isVictoryStage) return;

    const points = [];
    const segments = 6;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const jitter = i === 0 || i === segments ? 0 : (Math.random() - 0.5) * 0.7;
      points.push(
        new THREE.Vector3(
          fromX + (toX - fromX) * t + jitter,
          1.2 + (Math.random() - 0.5) * 0.4,
          fromZ + (toZ - fromZ) * t + jitter
        )
      );
    }

    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color: 0x00e5ff, linewidth: 3 });
    const line = new THREE.Line(geo, mat);
    this.fxGroup.add(line);

    this.lightningBolts.push({ line, ttl: 0.35 });
  }

  isTypingInInput(target) {
    if (!target) return false;
    const tag = (target.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(target.isContentEditable);
  }

  bindInputListeners() {
    window.addEventListener('keydown', (e) => {
      if (!this.isActive || this.isVictoryStage) return;
      if (this.isTypingInInput(e.target) || this.isTypingInInput(document.activeElement)) {
        this.pressedCodes.clear();
        return;
      }

      if (this.controlsConfig.matchesAction('shove', e.code)) {
        e.preventDefault();
        if (this.combatLocked) return;
        if (this.isLocalGrabbed && !e.repeat) {
          this.socket.emit('match:escape_press');
          if (this.soundManager) this.soundManager.playStruggle();
          return;
        }
        this.isChargingShove = true;
      }

      if (this.controlsConfig.matchesAction('grab', e.code)) {
        e.preventDefault();
        if (this.combatLocked) return;
        if (!this.isLocalGrabbed) {
          this.isChargingGrab = true;
        }
      }

      this.pressedCodes.add(e.code);
    });

    window.addEventListener('keyup', (e) => {
      if (!this.isActive) return;
      this.pressedCodes.delete(e.code);

      if (this.controlsConfig.matchesAction('shove', e.code)) {
        e.preventDefault();
        this.isChargingShove = false;
      }

      if (this.controlsConfig.matchesAction('grab', e.code)) {
        e.preventDefault();
        this.isChargingGrab = false;
      }
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.isActive) return;

      // Inicia arraste da câmera dinâmica no PC (arrastar para o lado gira o mapa; frente/trás move a visão)
      this.isDraggingCamera = true;
      this.cameraDragMoved = false;
      this.lastCameraPointer.x = e.clientX;
      this.lastCameraPointer.y = e.clientY;

      if (this.isVictoryStage) return;

      const mouseCode = `Mouse${e.button}`;
      this.pressedCodes.add(mouseCode);

      if (this.controlsConfig.matchesAction('shove', mouseCode)) {
        if (this.combatLocked) return;
        if (this.isLocalGrabbed) {
          this.socket.emit('match:escape_press');
          if (this.soundManager) this.soundManager.playStruggle();
          return;
        }
        this.isChargingShove = true;
      }

      if (this.controlsConfig.matchesAction('grab', mouseCode) && e.button !== 0) {
        if (this.combatLocked) return;
        if (!this.isLocalGrabbed) {
          this.isChargingGrab = true;
        }
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isActive || !this.isDraggingCamera) return;
      const dx = e.clientX - this.lastCameraPointer.x;
      const dy = e.clientY - this.lastCameraPointer.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        this.cameraDragMoved = true;
      }
      this.lastCameraPointer.x = e.clientX;
      this.lastCameraPointer.y = e.clientY;

      // Arrastar para os lados vira/gira o mapa; arrastar para frente/trás move o mapa
      this.cameraYaw -= dx * 0.0075;
      this.cameraForwardOffset = Math.max(
        -9.5,
        Math.min(9.5, this.cameraForwardOffset + dy * 0.04)
      );
      this.cameraDistance = Math.max(
        11.0,
        Math.min(31.0, this.cameraDistance - dy * 0.025)
      );
    });

    window.addEventListener('mouseup', (e) => {
      if (!this.isActive) return;
      this.isDraggingCamera = false;
      const mouseCode = `Mouse${e.button}`;
      this.pressedCodes.delete(mouseCode);

      if (this.controlsConfig.matchesAction('shove', mouseCode)) {
        this.isChargingShove = false;
      }

      if (this.controlsConfig.matchesAction('grab', mouseCode)) {
        this.isChargingGrab = false;
      }
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.isActive) return;
        e.preventDefault();
        this.cameraDistance = Math.max(
          10.5,
          Math.min(32.0, this.cameraDistance + e.deltaY * 0.015)
        );
      },
      { passive: false }
    );

    this.canvas.addEventListener('contextmenu', (e) => {
      if (this.isActive) e.preventDefault();
    });
  }

  bindMobileControls() {
    const joyZone = document.getElementById('mobile-joystick-zone');
    const joyStick = document.getElementById('mobile-joystick-knob');
    const btnShove = document.getElementById('btn-mobile-shove');
    const btnGrab = document.getElementById('btn-mobile-grab');

    if (joyZone && joyStick) {
      let activeTouchId = null;
      const maxRadius = 42;

      const updateJoystick = (clientX, clientY) => {
        const rect = joyZone.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        let dx = clientX - centerX;
        let dy = clientY - centerY;
        const dist = Math.hypot(dx, dy);

        if (dist > maxRadius) {
          dx = (dx / dist) * maxRadius;
          dy = (dy / dist) * maxRadius;
        }

        joyStick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        this.touchMove.x = dx / maxRadius;
        this.touchMove.z = dy / maxRadius;
      };

      const resetJoystick = () => {
        activeTouchId = null;
        joyStick.style.transform = 'translate(-50%, -50%)';
        this.touchMove.x = 0;
        this.touchMove.z = 0;
      };

      joyZone.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const touch = e.changedTouches[0];
        activeTouchId = touch.identifier;
        updateJoystick(touch.clientX, touch.clientY);
      }, { passive: false });

      joyZone.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (t.identifier === activeTouchId) {
            updateJoystick(t.clientX, t.clientY);
            break;
          }
        }
      }, { passive: false });

      joyZone.addEventListener('touchend', (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier === activeTouchId) {
            resetJoystick();
            break;
          }
        }
      });

      joyZone.addEventListener('touchcancel', resetJoystick);
    }

    if (btnShove) {
      btnShove.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (this.combatLocked) return;
        btnShove.classList.add('pressing');
        if (this.isLocalGrabbed) {
          this.socket.emit('match:escape_press');
          if (this.soundManager) this.soundManager.playStruggle();
          return;
        }
        this.isChargingShove = true;
      }, { passive: false });

      const releaseMobileShove = (e) => {
        e.preventDefault();
        this.isChargingShove = false;
        btnShove.classList.remove('pressing');
      };

      btnShove.addEventListener('touchend', releaseMobileShove, { passive: false });
      btnShove.addEventListener('touchcancel', releaseMobileShove, { passive: false });
    }

    if (btnGrab) {
      btnGrab.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (this.combatLocked || this.isLocalGrabbed) return;
        this.isChargingGrab = true;
        btnGrab.classList.add('pressing');
      }, { passive: false });

      const releaseMobileGrab = (e) => {
        e.preventDefault();
        this.isChargingGrab = false;
        btnGrab.classList.remove('pressing');
      };

      btnGrab.addEventListener('touchend', releaseMobileGrab, { passive: false });
      btnGrab.addEventListener('touchcancel', releaseMobileGrab, { passive: false });
    }

    // Controle Touch na tela (Celular) para mover o mapa para frente/trás e girar ao arrastar para o lado
    this.canvas.addEventListener(
      'touchstart',
      (e) => {
        if (!this.isActive) return;
        if (this.cameraTouchId !== null) return;
        const touch = e.changedTouches[0];
        if (!touch) return;
        this.cameraTouchId = touch.identifier;
        this.lastCameraPointer.x = touch.clientX;
        this.lastCameraPointer.y = touch.clientY;
      },
      { passive: true }
    );

    this.canvas.addEventListener(
      'touchmove',
      (e) => {
        if (!this.isActive || this.cameraTouchId === null) return;
        for (const t of e.changedTouches) {
          if (t.identifier === this.cameraTouchId) {
            const dx = t.clientX - this.lastCameraPointer.x;
            const dy = t.clientY - this.lastCameraPointer.y;
            this.lastCameraPointer.x = t.clientX;
            this.lastCameraPointer.y = t.clientY;

            this.cameraYaw -= dx * 0.0085;
            this.cameraForwardOffset = Math.max(
              -9.5,
              Math.min(9.5, this.cameraForwardOffset + dy * 0.042)
            );
            this.cameraDistance = Math.max(
              11.0,
              Math.min(31.0, this.cameraDistance - dy * 0.028)
            );
            break;
          }
        }
      },
      { passive: true }
    );

    const endCameraTouch = (e) => {
      if (this.cameraTouchId === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier === this.cameraTouchId) {
          this.cameraTouchId = null;
          break;
        }
      }
    };

    this.canvas.addEventListener('touchend', endCameraTouch, { passive: true });
    this.canvas.addEventListener('touchcancel', endCameraTouch, { passive: true });
  }

  getLocalMoveVector() {
    let rawX = this.touchMove.x;
    let rawZ = this.touchMove.z;

    for (const code of this.pressedCodes) {
      if (this.controlsConfig.matchesAction('up', code)) rawZ -= 1;
      if (this.controlsConfig.matchesAction('down', code)) rawZ += 1;
      if (this.controlsConfig.matchesAction('left', code)) rawX -= 1;
      if (this.controlsConfig.matchesAction('right', code)) rawX += 1;
    }

    const lenSq = rawX * rawX + rawZ * rawZ;
    if (lenSq > 1) {
      const len = Math.sqrt(lenSq);
      rawX /= len;
      rawZ /= len;
    }

    // Alinha a movimentação com o giro atual do mapa (cameraYaw)
    const cosY = Math.cos(this.cameraYaw);
    const sinY = Math.sin(this.cameraYaw);
    const moveX = rawX * cosY + rawZ * sinY;
    const moveZ = -rawX * sinY + rawZ * cosY;

    return {
      moveX: Math.round(moveX * 100) / 100,
      moveZ: Math.round(moveZ * 100) / 100
    };
  }

  sendLocalInput() {
    if (!this.isActive || this.isVictoryStage) return;

    const { moveX, moveZ } = this.getLocalMoveVector();
    const charging = this.combatLocked ? false : this.isChargingShove;
    const grabCharging = this.combatLocked ? false : this.isChargingGrab;

    const now = performance.now();
    const last = this.lastSentInput;
    const stateChanged =
      moveX !== last.moveX ||
      moveZ !== last.moveZ ||
      charging !== last.charging ||
      grabCharging !== last.grabCharging;

    const isMovingOrCharging = moveX !== 0 || moveZ !== 0 || charging || grabCharging;

    if (!stateChanged && (!isMovingOrCharging || now - this.lastInputSentAt < 33)) {
      return;
    }

    this.lastInputSentAt = now;
    last.moveX = moveX;
    last.moveZ = moveZ;
    last.charging = charging;
    last.grabCharging = grabCharging;

    this.socket.emit('match:input', {
      moveX,
      moveZ,
      charging,
      grabCharging
    });
  }

  lerpAngle(current, target, alpha) {
    const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
    return current + delta * alpha;
  }

  /**
   * Posiciona a barra de carregamento "FORÇA" diretamente em cima da cabeça
   * do personagem local em coordenadas de tela.
   */
  updateOverheadChargeBar(localMesh) {
    if (!this.chargeContainerEl) {
      this.chargeContainerEl = document.getElementById('hud-charge-container');
    }
    if (!this.chargeBarEl) {
      this.chargeBarEl = document.getElementById('hud-charge-fill');
    }
    if (!this.chargeContainerEl || !this.chargeBarEl) return;

    const isActivelyCharging =
      this.isChargingShove || this.isChargingGrab || (this.localChargePower || 0) > 0.01;

    if (!localMesh || !localMesh.alive || this.isVictoryStage || !isActivelyCharging) {
      if (this.chargeBarVisible !== false) {
        this.chargeBarVisible = false;
        this.chargeContainerEl.classList.add('hidden');
      }
      return;
    }

    if (this.chargeBarVisible !== true) {
      this.chargeBarVisible = true;
      this.chargeContainerEl.classList.remove('hidden');
    }

    // Projeta a posição acima da cabeça do personagem usando GPU translate3d (zero reflow)
    this.tempHeadVec.set(
      localMesh.group.position.x,
      localMesh.group.position.y + 3.05,
      localMesh.group.position.z
    );
    this.tempHeadVec.project(this.camera);

    const screenX = Math.round((this.tempHeadVec.x * 0.5 + 0.5) * window.innerWidth);
    const screenY = Math.round((-this.tempHeadVec.y * 0.5 + 0.5) * window.innerHeight);

    this.chargeContainerEl.style.transform = `translate3d(${screenX}px, ${screenY}px, 0) translate(-50%, -100%)`;

    const pct = Math.round((this.localChargePower || 0) * 100);
    if (pct !== this.lastChargePct) {
      this.lastChargePct = pct;
      this.chargeBarEl.style.width = `${pct}%`;
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    if (!this.isActive) return;

    const dt = Math.min(this.clock.getDelta(), 0.1);
    const elapsedTime = this.clock.getElapsedTime();

    if (this.isVictoryStage) {
      this.victoryStageElapsed += dt;
      let allStanding = this.victoryActors.length > 0;

      for (const actor of this.victoryActors) {
        if (actor.state === 'FALLING') {
          allStanding = false;
          actor.vy -= 36.0 * dt;
          actor.group.position.y += actor.vy * dt;
          actor.leftHand.position.y = 1.35 + Math.sin(elapsedTime * 18 + actor.phase) * 0.2;
          actor.rightHand.position.y = 1.35 + Math.cos(elapsedTime * 18 + actor.phase) * 0.2;

          if (actor.group.position.y <= actor.baseY) {
            actor.group.position.y = actor.baseY;
            actor.vy = 0;
            actor.state = 'IMPACT_FLAT';
            actor.impactElapsed = 0;
            // Bate no chão ficando caído na arena
            actor.body.rotation.x = -Math.PI / 2;
            actor.body.position.y = 0.35;
          }
        } else if (actor.state === 'IMPACT_FLAT') {
          allStanding = false;
          actor.impactElapsed += dt;
          actor.body.rotation.x = -Math.PI / 2;
          actor.body.position.y = 0.35;
          if (actor.impactElapsed >= 0.55) {
            actor.state = 'GETTING_UP';
            actor.getUpElapsed = 0;
          }
        } else if (actor.state === 'GETTING_UP') {
          allStanding = false;
          actor.getUpElapsed += dt;
          const progress = Math.min(1, actor.getUpElapsed / 0.48);
          const targetPitch = actor.isWinner ? 0 : 0.2;
          actor.body.rotation.x = -Math.PI / 2 + (targetPitch - -Math.PI / 2) * progress;
          actor.body.position.y = 0.35 * (1 - progress);
          if (progress >= 1) {
            actor.state = 'STANDING';
            actor.body.rotation.x = targetPitch;
            actor.body.position.y = 0;
          }
        } else {
          // Já levantou: comemora em festa (vencedor) ou chora na chuva (perdedor)
          if (actor.isWinner) {
            const jump = this.victoryWeatherActive
              ? Math.abs(Math.sin(elapsedTime * 5.4 + actor.phase)) * 0.62
              : 0;
            actor.group.position.y = actor.baseY + jump;
            actor.leftHand.position.set(
              -0.78,
              1.52 + Math.sin(elapsedTime * 10 + actor.phase) * 0.22,
              0.25
            );
            actor.rightHand.position.set(
              0.78,
              1.52 + Math.cos(elapsedTime * 10 + actor.phase) * 0.22,
              0.25
            );
            actor.group.rotation.y = 0.18 + Math.sin(elapsedTime * 3.5 + actor.phase) * 0.18;
          } else {
            // Perdedor chorando: mãos enxugando os olhos/rosto e corpo soluçando
            const sob = Math.abs(Math.sin(elapsedTime * 7.5 + actor.phase)) * 0.06;
            actor.body.position.y = sob;
            actor.body.rotation.x = 0.26 + Math.sin(elapsedTime * 7.5 + actor.phase) * 0.06;
            actor.leftHand.position.set(
              -0.36,
              1.08 + Math.sin(elapsedTime * 8 + actor.phase) * 0.08,
              0.46
            );
            actor.rightHand.position.set(
              0.36,
              1.08 + Math.cos(elapsedTime * 8 + actor.phase) * 0.08,
              0.46
            );
            actor.group.rotation.y = -0.18 + Math.sin(elapsedTime * 2.2 + actor.phase) * 0.1;
          }
        }
      }

      if (allStanding && this.victoryAllStoodUpAt === null) {
        this.victoryAllStoodUpAt = this.victoryStageElapsed;
      }

      // Logo depois de 1s que todos bateram no chão e se levantaram, começa festa/confete e chuva/choro!
      if (
        this.victoryAllStoodUpAt !== null &&
        !this.victoryWeatherActive &&
        this.victoryStageElapsed - this.victoryAllStoodUpAt >= 1.0
      ) {
        this.startVictoryWeather();
      }

      if (this.victoryWeatherActive) {
        // Anima luzes da pista e feixes de festa no lado dos vencedores
        for (let i = 0; i < this.partyLightMeshes.length; i++) {
          const pl = this.partyLightMeshes[i];
          if (pl.isBeam) {
            pl.mesh.rotation.z = Math.sin(elapsedTime * 2.4 + pl.phase) * 0.22;
            pl.mat.opacity = 0.12 + Math.abs(Math.sin(elapsedTime * 4.0 + pl.phase)) * 0.12;
          } else {
            pl.mat.opacity = 0.25 + Math.abs(Math.sin(elapsedTime * 5.0 + pl.phase)) * 0.45;
          }
        }

        // Anima confetes caindo no lado dos vencedores
        for (let i = 0; i < this.confettiItems.length; i++) {
          const c = this.confettiItems[i];
          c.mesh.position.y -= c.speedY * dt;
          c.mesh.position.x += Math.sin(elapsedTime * c.swaySpeed + c.phase) * c.swayAmp * dt;
          c.mesh.rotation.x += c.rotSpeedX * dt;
          c.mesh.rotation.y += c.rotSpeedY * dt;
          c.mesh.rotation.z += c.rotSpeedZ * dt;
          if (c.mesh.position.y <= 0.08) {
            c.mesh.position.y = 9.0 + Math.random() * 4.0;
            c.mesh.position.x = -5.0 + (Math.random() - 0.5) * 8.2;
            c.mesh.position.z = (Math.random() - 0.5) * 7.4;
          }
        }

        // Anima chuva caindo no lado dos perdedores
        for (let i = 0; i < this.rainItems.length; i++) {
          const r = this.rainItems[i];
          r.mesh.position.y -= r.speedY * dt;
          if (r.mesh.position.y <= 0.1) {
            r.mesh.position.y = 8.5 + Math.random() * 1.5;
            r.mesh.position.x = 5.0 + (Math.random() - 0.5) * 8.2;
            r.mesh.position.z = (Math.random() - 0.5) * 7.4;
          }
        }

        // Anima lágrimas escorrendo dos olhos dos perdedores
        for (let i = 0; i < this.tearItems.length; i++) {
          const tear = this.tearItems[i];
          tear.offsetY += tear.speed * dt;
          if (tear.offsetY > 0.95) {
            tear.offsetY = 0;
          }
          tear.mesh.position.set(
            tear.side * (0.22 + tear.offsetY * 0.08),
            1.14 - tear.offsetY,
            0.44 + Math.sin(tear.offsetY * Math.PI) * 0.08
          );
        }
      }

      const vForwardX = -Math.sin(this.cameraYaw);
      const vForwardZ = -Math.cos(this.cameraYaw);
      const vFocusX = vForwardX * this.cameraForwardOffset * 0.5;
      const vFocusZ = vForwardZ * this.cameraForwardOffset * 0.5;
      this.camera.position.set(
        vFocusX + Math.sin(this.cameraYaw) * this.cameraDistance,
        8.2,
        vFocusZ + Math.cos(this.cameraYaw) * this.cameraDistance
      );
      this.camera.lookAt(vFocusX, 1.0, vFocusZ);

      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.sendLocalInput();

    // Anima os anéis de vórtice do Abismo 3D
    for (let i = 0; i < this.abyssRings.length; i++) {
      const r = this.abyssRings[i];
      r.mesh.rotation.y += r.speed * dt;
    }

    // Anima os 5 Trampolins (efeito elástico de mola)
    for (let i = 0; i < this.trampolineMeshes.length; i++) {
      const t = this.trampolineMeshes[i];
      if (t.bounceEnergy > 0.01) {
        t.bounceEnergy = Math.max(0, t.bounceEnergy - dt * 3.5);
        const wave = Math.sin(t.bounceEnergy * Math.PI * 4) * t.bounceEnergy * 0.28;
        t.padGroup.position.y = wave;
        t.padGroup.scale.set(1 + wave * 0.35, 1, 1 + wave * 0.35);
      } else {
        t.padGroup.position.y = 0;
        t.padGroup.scale.set(1, 1, 1);
      }
    }

    if (this.abyssParticles) {
      this.abyssParticles.rotation.y += dt * 0.08;
      const posAttr = this.abyssParticles.geometry.attributes.position;
      const arr = posAttr.array;
      for (let i = 1; i < arr.length; i += 3) {
        arr[i] += dt * 2.5;
        if (arr[i] > 8) arr[i] = -36;
      }
      posAttr.needsUpdate = true;
    }

    for (const meshGroup of this.powerupMeshes.values()) {
      if (meshGroup.userData?.crystal) {
        meshGroup.userData.crystal.rotation.y += dt * 2.4;
        meshGroup.userData.crystal.rotation.x += dt * 1.2;
      }
    }

    const lerpFactor = Math.min(1, dt * 22);
    const localInput = this.lastSentInput;

    for (const record of this.playerMeshes.values()) {
      if (!record.alive) continue;

      const isLocal = record.id === this.localSocketId;

      // Predição Client-Side para o jogador local (resposta instantânea 0ms ao teclado/joystick)
      if (
        isLocal &&
        !this.combatLocked &&
        !record.grabbedById &&
        !record.knockedOut &&
        !record.stunned &&
        !record.shocked &&
        (localInput.moveX !== 0 || localInput.moveZ !== 0)
      ) {
        record.targetPos.x += localInput.moveX * dt * 4.2;
        record.targetPos.z += localInput.moveZ * dt * 4.2;
        record.targetRot = Math.atan2(localInput.moveX, localInput.moveZ);
      }

      // Extrapolação suave usando a velocidade (vx, vy, vz) entre os ticks de 30Hz
      if (record.alive && !record.grabbedById && !record.knockedOut) {
        record.targetPos.x += record.vel.x * dt * 0.65;
        record.targetPos.z += record.vel.z * dt * 0.65;
        if (record.targetPos.y > 0 || record.vel.y !== 0) {
          record.targetPos.y = Math.max(0, record.targetPos.y + record.vel.y * dt * 0.65);
        }
      }

      record.group.position.lerp(record.targetPos, lerpFactor);
      record.group.rotation.y = this.lerpAngle(
        record.group.rotation.y,
        record.targetRot,
        lerpFactor
      );

      // Animação de Nocaute da Luva de Boxe (personagem deitado no chão por 2s!)
      if (record.knockedOut) {
        record.visualRoot.rotation.x = this.lerpAngle(
          record.visualRoot.rotation.x,
          -Math.PI / 2,
          Math.min(1, dt * 14)
        );
        record.visualRoot.position.y = 0.35;
      } else {
        record.visualRoot.rotation.x = this.lerpAngle(
          record.visualRoot.rotation.x,
          0,
          Math.min(1, dt * 14)
        );
        record.visualRoot.position.y = 0;
      }

      if (record.shocked) {
        record.group.position.x += Math.sin(elapsedTime * 55) * 0.08;
        record.shockCage.rotation.y += dt * 8;
      }

      if (record.stunned || record.knockedOut) {
        record.stunRing.rotation.z += dt * 10;
      }
      if (record.heavy) {
        record.heavyShield.rotation.y += dt * 3;
      }

      if (record.grabbedTargetId) {
        record.leftHand.position.set(-0.52, 1.75, 0.35);
        record.rightHand.position.set(0.52, 1.75, 0.35);
      } else {
        const chargeOffset = (record.charge || 0) * 0.35;
        record.leftHand.position.set(-0.72, 0.88, 0.3 - chargeOffset);
        record.rightHand.position.set(0.72, 0.88, 0.3 - chargeOffset);
      }

      const baseHandScale = record.hasMegaShove ? 1.55 : record.hasBoxingGlove ? 1.25 : 1.0;
      const handScale = baseHandScale + (record.charge || 0) * 0.45;
      record.leftHand.scale.setScalar(handScale);
      record.rightHand.scale.setScalar(handScale);
    }

    for (let i = this.activeShockwaves.length - 1; i >= 0; i--) {
      const sw = this.activeShockwaves[i];
      sw.scale += dt * 11;
      sw.mesh.scale.setScalar(sw.scale);
      sw.mat.opacity = Math.max(0, 1 - sw.scale / sw.maxScale);
      if (sw.scale >= sw.maxScale) {
        sw.mesh.visible = false;
        sw.inUse = false;
        this.activeShockwaves.splice(i, 1);
      }
    }

    for (let i = this.lightningBolts.length - 1; i >= 0; i--) {
      const bolt = this.lightningBolts[i];
      bolt.ttl -= dt;
      if (bolt.ttl <= 0) {
        this.fxGroup.remove(bolt.line);
        this.disposeObject3D(bolt.line);
        this.lightningBolts.splice(i, 1);
      }
    }

    const localMesh = this.playerMeshes.get(this.localSocketId);
    const forwardDirX = -Math.sin(this.cameraYaw);
    const forwardDirZ = -Math.cos(this.cameraYaw);

    const baseFocusX = localMesh && localMesh.alive ? localMesh.group.position.x * 0.3 : 0;
    const baseFocusZ = localMesh && localMesh.alive ? localMesh.group.position.z * 0.3 : 0;

    const focusX = baseFocusX + forwardDirX * this.cameraForwardOffset;
    const focusZ = baseFocusZ + forwardDirZ * this.cameraForwardOffset;

    const targetCamX = focusX + Math.sin(this.cameraYaw) * this.cameraDistance;
    const targetCamZ = focusZ + Math.cos(this.cameraYaw) * this.cameraDistance;
    const targetCamY = Math.max(8.5, this.cameraDistance * 0.82);

    this.camera.position.x += (targetCamX - this.camera.position.x) * Math.min(1, dt * 8);
    this.camera.position.z += (targetCamZ - this.camera.position.z) * Math.min(1, dt * 8);
    this.camera.position.y += (targetCamY - this.camera.position.y) * Math.min(1, dt * 8);
    this.camera.lookAt(focusX, 0, focusZ);

    // Atualiza a posição da barra "FORÇA" em cima da cabeça do personagem
    this.updateOverheadChargeBar(localMesh);

    this.renderer.render(this.scene, this.camera);
  }
}
