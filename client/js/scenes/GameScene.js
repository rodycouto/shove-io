// client/js/scenes/GameScene.js
// ============================================================================
// Cena 3D Principal da Partida e Palco 3D de Vitória em Tela Cheia (Three.js).
// Responsabilidades:
// 1. Construir dinamicamente qualquer um dos 5 mapas vindos do maps.json.
// 2. Construir o FUNDO DE ABISMO 3D (anéis abissais profundos em funil,
//    rochas submersas e partículas ascendentes do abismo) para dar forte
//    percepção de profundidade e queda.
// 3. Renderizar até 15 jogadores com o nome do próprio jogador em AMARELO
//    (#FFD600) em destaque.
// 4. Bloquear ações de empurrar e levantar durante os 5 segundos iniciais
//    da contagem (5, 4, 3, 2, 1 - SHOVE!).
// 5. Exibir a TELA DE VITÓRIA 3D EM TELA CHEIA (Vencedores à Esquerda,
//    Perdedores à Direita).
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
    this.combatLocked = true; // Bloqueado até terminar a contagem 5, 4, 3, 2, 1 - SHOVE!
    this.localSocketId = null;
    this.currentMap = null;
    this.baseArenaRadius = 12.0;
    this.currentArenaRadius = 12.0;

    this.playerMeshes = new Map();
    this.powerupMeshes = new Map();
    this.victoryActors = [];
    this.shockwaves = [];
    this.lightningBolts = [];
    this.abyssRings = [];
    this.abyssParticles = null;

    this.pressedCodes = new Set();
    this.touchMove = { x: 0, z: 0 };
    this.isChargingShove = false;
    this.isChargingGrab = false;
    this.localChargePower = 0;
    this.isLocalGrabbed = false;

    this.clock = new THREE.Clock();

    this.initThree();
    this.bindInputListeners();
    this.bindMobileControls();
    this.animate();
  }

  initThree() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070f);
    this.scene.fog = new THREE.FogExp2(0x05070f, 0.015);

    this.camera = new THREE.PerspectiveCamera(
      52,
      window.innerWidth / window.innerHeight,
      0.1,
      280
    );
    this.camera.position.set(0, 18, 22);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const ambient = new THREE.AmbientLight(0xffffff, 0.75);
    this.scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xfff8e7, 1.35);
    dirLight.position.set(15, 28, 15);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
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

  /**
   * Inicia um novo round/partida carregando a geometria do mapa, o Abismo 3D e os bonecos.
   */
  startMatch({ room, map, localSocketId }) {
    this.localSocketId = localSocketId;
    this.currentMap = map;
    this.baseArenaRadius = map?.physics?.radius || 12.0;
    this.currentArenaRadius = this.baseArenaRadius;

    this.isVictoryStage = false;
    this.combatLocked = true;
    this.clearVictoryStage();

    this.pressedCodes.clear();
    this.touchMove = { x: 0, z: 0 };
    this.isChargingShove = false;
    this.isChargingGrab = false;
    this.localChargePower = 0;
    this.isLocalGrabbed = false;

    this.buildArenaFromMap(map);
    this.clearPlayers();
    this.clearPowerups();

    if (room && Array.isArray(room.players)) {
      this.teamColorLookup = new Map();
      if (Array.isArray(room.availableTeams)) {
        room.availableTeams.forEach((t) => this.teamColorLookup.set(t.id, t));
      }
      room.players.forEach((p) => {
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
    this.clearVictoryStage();
    this.canvas.classList.add('hidden');
  }

  /**
   * Constrói o fundo 3D de "Abismo" abaixo e ao redor da plataforma para dar
   * forte percepção visual de altura, profundidade e perigo de queda.
   */
  buildAbyssEnvironment(theme, radius, sides) {
    while (this.abyssGroup.children.length > 0) {
      this.abyssGroup.remove(this.abyssGroup.children[0]);
    }
    this.abyssRings = [];
    this.abyssParticles = null;

    const borderColor = new THREE.Color(theme.borderColor || '#ff3366');
    const centerColor = new THREE.Color(theme.centerColor || '#00e5ff');

    // 1. Vórtice de Anéis Abissais Descendentes (cria perspectiva de funil sem fim lá embaixo)
    const numDepthLevels = 8;
    for (let i = 1; i <= numDepthLevels; i++) {
      const depthY = -3.8 * i;
      const ringRadius = radius * (1.28 + i * 0.12);
      const ringGeo = new THREE.RingGeometry(ringRadius, ringRadius + 0.45, Math.max(12, sides));
      ringGeo.rotateX(-Math.PI / 2);

      const fade = Math.max(0.06, 0.36 - i * 0.038);
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

    // 2. Colunas/Monólitos Abissais ao longe (dão referência de paralaxe e profundidade)
    const monolithMat = new THREE.MeshStandardMaterial({
      color: 0x0c1021,
      roughness: 0.85,
      metalness: 0.2
    });
    const monolithCount = 10;
    for (let i = 0; i < monolithCount; i++) {
      const angle = (i / monolithCount) * Math.PI * 2;
      const dist = radius + 11 + (i % 3) * 4;
      const height = 28 + (i % 4) * 8;
      const mGeo = new THREE.CylinderGeometry(1.1, 2.2, height, 6);
      const mMesh = new THREE.Mesh(mGeo, monolithMat);
      mMesh.position.set(
        Math.cos(angle) * dist,
        -height * 0.55 - 3,
        Math.sin(angle) * dist
      );
      this.abyssGroup.add(mMesh);
    }

    // 3. Partículas Brilhantes Subindo das Profundezas do Abismo
    const particleCount = 130;
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

  showVictoryStage(result) {
    this.isVictoryStage = true;
    this.isActive = true;
    this.pressedCodes.clear();
    this.isChargingShove = false;
    this.isChargingGrab = false;

    this.clearPlayers();
    this.clearPowerups();
    while (this.arenaGroup.children.length > 0) {
      this.arenaGroup.remove(this.arenaGroup.children[0]);
    }
    while (this.abyssGroup.children.length > 0) {
      this.abyssGroup.remove(this.abyssGroup.children[0]);
    }
    this.clearVictoryStage();

    this.scene.background = new THREE.Color(0x090c18);
    this.scene.fog = new THREE.FogExp2(0x090c18, 0.015);

    // 1. Palco Esquerdo — VENCEDORES
    const winStageGeo = new THREE.CylinderGeometry(4.8, 5.2, 1.4, 24);
    const winStageMat = new THREE.MeshStandardMaterial({
      color: 0x1e3a2f,
      roughness: 0.3,
      metalness: 0.25
    });
    const winStage = new THREE.Mesh(winStageGeo, winStageMat);
    winStage.position.set(-5.2, -0.7, 0);
    winStage.receiveShadow = true;
    this.victoryGroup.add(winStage);

    const winRingGeo = new THREE.RingGeometry(4.4, 4.85, 32);
    winRingGeo.rotateX(-Math.PI / 2);
    const winRingMat = new THREE.MeshBasicMaterial({
      color: 0xffd600,
      side: THREE.DoubleSide
    });
    const winRing = new THREE.Mesh(winRingGeo, winRingMat);
    winRing.position.set(-5.2, 0.02, 0);
    this.victoryGroup.add(winRing);

    // 2. Plataforma Direita — PERDEDORES
    const loseStageGeo = new THREE.CylinderGeometry(5.2, 5.5, 1.0, 24);
    const loseStageMat = new THREE.MeshStandardMaterial({
      color: 0x1a1d30,
      roughness: 0.6,
      metalness: 0.1
    });
    const loseStage = new THREE.Mesh(loseStageGeo, loseStageMat);
    loseStage.position.set(5.2, -0.9, 0);
    loseStage.receiveShadow = true;
    this.victoryGroup.add(loseStage);

    const loseRingGeo = new THREE.RingGeometry(4.8, 5.2, 32);
    loseRingGeo.rotateX(-Math.PI / 2);
    const loseRingMat = new THREE.MeshBasicMaterial({
      color: 0xff3366,
      side: THREE.DoubleSide
    });
    const loseRing = new THREE.Mesh(loseRingGeo, loseRingMat);
    loseRing.position.set(5.2, -0.38, 0);
    this.victoryGroup.add(loseRing);

    // 3. Bonecos VENCEDORES do lado esquerdo (-5.2)
    const winners = Array.isArray(result?.winnersList) ? result.winnersList : [];
    winners.forEach((w, idx) => {
      const isMe = w.id === this.localSocketId;
      const actor = this.createVictoryShoverMesh(
        w.skinColor || '#00E676',
        `👑 ${w.username}`,
        '#FFD600',
        true,
        isMe
      );
      const row = Math.floor(idx / 3);
      const col = idx % 3;
      const colsInRow = Math.min(3, winners.length - row * 3);
      const offsetX = (col - (colsInRow - 1) / 2) * 2.1;
      const offsetZ = (row - 0.3) * 1.9;

      actor.group.position.set(-5.2 + offsetX, 0, offsetZ);
      actor.group.rotation.y = 0.22;
      this.victoryGroup.add(actor.group);
      this.victoryActors.push({
        ...actor,
        isWinner: true,
        baseY: 0,
        phase: idx * 0.9
      });
    });

    // 4. Bonecos PERDEDORES do lado direito (+5.2)
    const losers = Array.isArray(result?.losersList) ? result.losersList : [];
    losers.forEach((l, idx) => {
      const isMe = l.id === this.localSocketId;
      const actor = this.createVictoryShoverMesh(
        l.skinColor || '#FF3366',
        l.username,
        isMe ? '#FFD600' : '#9aa5ce',
        false,
        isMe
      );
      const cols = 4;
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const colsInRow = Math.min(cols, losers.length - row * cols);
      const offsetX = (col - (colsInRow - 1) / 2) * 1.75;
      const offsetZ = (row - 0.5) * 1.75;

      actor.group.position.set(5.2 + offsetX, -0.4, offsetZ);
      actor.group.rotation.y = -0.25;
      actor.body.rotation.x = 0.28;
      actor.visor.position.set(0, 1.12, 0.55);
      actor.visor.rotation.x = 0.28;
      this.victoryGroup.add(actor.group);
      this.victoryActors.push({
        ...actor,
        isWinner: false,
        baseY: -0.4,
        phase: idx * 0.7
      });
    });

    this.camera.position.set(0, 5.8, 16.5);
    this.camera.lookAt(0, 0.8, 0);
  }

  createVictoryShoverMesh(colorHex, labelText, borderColor, isWinner, isLocal = false) {
    const group = new THREE.Group();

    const bodyGeo = new THREE.CapsuleGeometry(0.65, 0.7, 8, 16);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colorHex),
      roughness: 0.3
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 1.0;
    body.castShadow = true;
    group.add(body);

    const visorGeo = new THREE.BoxGeometry(0.75, 0.28, 0.35);
    const visorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1 });
    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 1.25, 0.5);
    group.add(visor);

    const handGeo = new THREE.SphereGeometry(0.24, 12, 12);
    const leftHand = new THREE.Mesh(handGeo, bodyMat);
    const rightHand = new THREE.Mesh(handGeo, bodyMat);

    if (isWinner) {
      leftHand.position.set(-0.85, 1.65, 0.2);
      rightHand.position.set(0.85, 1.65, 0.2);

      const crownGeo = new THREE.TorusGeometry(0.42, 0.08, 8, 20);
      crownGeo.rotateX(Math.PI / 2);
      const crownMat = new THREE.MeshBasicMaterial({ color: 0xffd600 });
      const crown = new THREE.Mesh(crownGeo, crownMat);
      crown.position.y = 1.95;
      group.add(crown);
    } else {
      leftHand.position.set(-0.75, 0.55, 0.35);
      rightHand.position.set(0.75, 0.55, 0.35);
    }

    group.add(leftHand, rightHand);

    const nameplate = this.createNameplateSprite(labelText, borderColor, 2.7, isLocal);
    nameplate.position.set(0, 2.45, 0);
    group.add(nameplate);

    return { group, body, visor, leftHand, rightHand };
  }

  clearVictoryStage() {
    while (this.victoryGroup && this.victoryGroup.children.length > 0) {
      this.victoryGroup.remove(this.victoryGroup.children[0]);
    }
    this.victoryActors = [];
  }

  buildArenaFromMap(map) {
    while (this.arenaGroup.children.length > 0) {
      this.arenaGroup.remove(this.arenaGroup.children[0]);
    }

    const theme = map?.theme || {};
    const physics = map?.physics || {};
    const radius = physics.radius || 12.0;
    const sides = physics.sides || 12;
    const innerHole = physics.innerHoleRadius || 0;

    this.scene.background = new THREE.Color(theme.background || '#060812');
    this.scene.fog = new THREE.FogExp2(theme.background || '#060812', 0.014);

    // Constrói o Fundo de Abismo 3D abaixo da plataforma
    this.buildAbyssEnvironment(theme, radius, sides);

    this.scalablePlatformGroup = new THREE.Group();

    const platformMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(theme.platformColor || '#232946'),
      roughness: map?.id === 'map_ice_island' ? 0.12 : 0.42,
      metalness: map?.id === 'map_ice_island' ? 0.35 : 0.12
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
      donutMesh.receiveShadow = true;
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
      // Plataforma em formato de funil rochoso suspenso sobre o abismo
      const cylGeo = new THREE.CylinderGeometry(radius, radius * 0.65, 3.8, sides);
      const platformMesh = new THREE.Mesh(cylGeo, platformMat);
      platformMesh.position.y = -1.9;
      platformMesh.receiveShadow = true;
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

    if (Array.isArray(physics.pillars)) {
      const pillarMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(theme.borderColor || '#00e676'),
        roughness: 0.25,
        metalness: 0.3
      });
      const ringMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(theme.centerColor || '#ffd600')
      });

      physics.pillars.forEach((pil) => {
        const pGroup = new THREE.Group();
        const pGeo = new THREE.CylinderGeometry(pil.radius, pil.radius, 2.6, 16);
        const pMesh = new THREE.Mesh(pGeo, pillarMat);
        pMesh.position.y = 1.3;
        pMesh.castShadow = true;
        pGroup.add(pMesh);

        const torusGeo = new THREE.TorusGeometry(pil.radius + 0.08, 0.12, 10, 24);
        torusGeo.rotateX(Math.PI / 2);
        const torusMesh = new THREE.Mesh(torusGeo, ringMat);
        torusMesh.position.y = 1.0;
        pGroup.add(torusMesh);

        pGroup.position.set(pil.x, 0, pil.z);
        this.arenaGroup.add(pGroup);
      });
    }
  }

  clearPlayers() {
    while (this.playersGroup.children.length > 0) {
      this.playersGroup.remove(this.playersGroup.children[0]);
    }
    this.playerMeshes.clear();
  }

  clearPowerups() {
    while (this.powerupsGroup.children.length > 0) {
      this.powerupsGroup.remove(this.powerupsGroup.children[0]);
    }
    this.powerupMeshes.clear();
  }

  /**
   * Cria um Sprite 2D com o nickname do jogador.
   * Se `isLocalPlayer === true`, renderiza o nome em AMARELO (#FFD600) em destaque!
   */
  createNameplateSprite(text, borderColor = '#ffffff', scaleW = 2.8, isLocalPlayer = false) {
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 88;
    const ctx = canvas.getContext('2d');

    const finalBorder = isLocalPlayer ? '#FFD600' : borderColor;

    ctx.fillStyle = isLocalPlayer ? 'rgba(20, 18, 6, 0.92)' : 'rgba(10, 14, 28, 0.82)';
    ctx.strokeStyle = finalBorder;
    ctx.lineWidth = isLocalPlayer ? 6 : 4;
    ctx.beginPath();
    ctx.roundRect(10, 8, 280, 48, 22);
    ctx.fill();
    ctx.stroke();

    ctx.font = isLocalPlayer
      ? '900 24px system-ui, sans-serif'
      : 'bold 21px system-ui, sans-serif';
    ctx.fillStyle = isLocalPlayer ? '#FFD600' : '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (isLocalPlayer) {
      ctx.shadowColor = 'rgba(255, 214, 0, 0.85)';
      ctx.shadowBlur = 8;
    }

    const displayLabel = isLocalPlayer
      ? `★ ${text.substring(0, 15)} ★`
      : text.substring(0, 18);
    ctx.fillText(displayLabel, 150, 33);

    if (isLocalPlayer) {
      ctx.fillStyle = '#FFD600';
      ctx.beginPath();
      ctx.moveTo(136, 62);
      ctx.lineTo(164, 62);
      ctx.lineTo(150, 82);
      ctx.closePath();
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    const finalWidth = isLocalPlayer ? scaleW * 1.22 : scaleW;
    const finalHeight = isLocalPlayer ? 0.98 : 0.75;
    sprite.scale.set(finalWidth, finalHeight, 1);
    sprite.position.set(0, isLocalPlayer ? 2.55 : 2.38, 0);
    sprite.renderOrder = isLocalPlayer ? 999 : 10;
    return sprite;
  }

  ensurePlayerMesh(pData) {
    const id = pData.id || pData.socketId;
    if (this.playerMeshes.has(id)) {
      return this.playerMeshes.get(id);
    }

    const isLocal = id === this.localSocketId;
    const group = new THREE.Group();

    const bodyGeo = new THREE.CapsuleGeometry(0.65, 0.7, 8, 16);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(pData.skinColor || '#FF3366'),
      roughness: 0.3,
      transparent: true,
      opacity: 1.0
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 1.0;
    body.castShadow = true;
    group.add(body);

    const visorGeo = new THREE.BoxGeometry(0.75, 0.28, 0.35);
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.1,
      transparent: true,
      opacity: 1.0
    });
    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 1.25, 0.5);
    group.add(visor);

    const handGeo = new THREE.SphereGeometry(0.24, 12, 12);
    const handMat = bodyMat.clone();
    const leftHand = new THREE.Mesh(handGeo, handMat);
    leftHand.position.set(-0.78, 0.95, 0.3);
    const rightHand = new THREE.Mesh(handGeo, handMat);
    rightHand.position.set(0.78, 0.95, 0.3);
    group.add(leftHand, rightHand);

    const heavyShieldGeo = new THREE.CylinderGeometry(0.95, 0.95, 1.7, 16, 1, true);
    const heavyShieldMat = new THREE.MeshBasicMaterial({
      color: 0xffd600,
      wireframe: true,
      transparent: true,
      opacity: 0.75
    });
    const heavyShield = new THREE.Mesh(heavyShieldGeo, heavyShieldMat);
    heavyShield.position.y = 1.0;
    heavyShield.visible = false;
    group.add(heavyShield);

    const shockCageGeo = new THREE.IcosahedronGeometry(1.15, 1);
    const shockCageMat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      wireframe: true
    });
    const shockCage = new THREE.Mesh(shockCageGeo, shockCageMat);
    shockCage.position.y = 1.05;
    shockCage.visible = false;
    group.add(shockCage);

    const shockGunGeo = new THREE.ConeGeometry(0.22, 0.65, 8);
    shockGunGeo.rotateX(Math.PI / 2);
    const shockGunMat = new THREE.MeshBasicMaterial({ color: 0xaa00ff });
    const shockGun = new THREE.Mesh(shockGunGeo, shockGunMat);
    shockGun.position.set(0.85, 1.1, 0.65);
    shockGun.visible = false;
    group.add(shockGun);

    const stunRingGeo = new THREE.TorusGeometry(0.55, 0.07, 8, 16);
    stunRingGeo.rotateX(Math.PI / 2);
    const stunRingMat = new THREE.MeshBasicMaterial({ color: 0xffd600 });
    const stunRing = new THREE.Mesh(stunRingGeo, stunRingMat);
    stunRing.position.y = 2.05;
    stunRing.visible = false;
    group.add(stunRing);

    const teamMeta = pData.teamId && this.teamColorLookup ? this.teamColorLookup.get(pData.teamId) : null;
    const ringColor = isLocal ? '#FFD600' : (teamMeta ? teamMeta.color : '#ffffff');

    const baseRingGeo = new THREE.RingGeometry(0.72, isLocal ? 1.02 : 0.92, 24);
    baseRingGeo.rotateX(-Math.PI / 2);
    const baseRingMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(ringColor),
      side: THREE.DoubleSide
    });
    const baseRing = new THREE.Mesh(baseRingGeo, baseRingMat);
    baseRing.position.y = 0.04;
    group.add(baseRing);

    const labelText = teamMeta ? `${teamMeta.icon} ${pData.username}` : pData.username;
    const nameplate = this.createNameplateSprite(labelText, ringColor, 2.8, isLocal);
    group.add(nameplate);

    this.playersGroup.add(group);

    const meshRecord = {
      id,
      group,
      bodyMat,
      visorMat,
      handMat,
      leftHand,
      rightHand,
      heavyShield,
      shockCage,
      shockGun,
      stunRing,
      baseRing,
      nameplate,
      baseColorHex: pData.skinColor || '#FF3366',
      targetPos: new THREE.Vector3(pData.x || 0, pData.y || 0, pData.z || 0),
      targetRot: pData.ry || 0,
      charge: 0,
      grabbedTargetId: null,
      grabbedById: null,
      stunned: false,
      invisible: false,
      heavy: false,
      shocked: false,
      hasMegaShove: false,
      hasShockWeapon: false,
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

        const geo = new THREE.OctahedronGeometry(0.65, 0);
        const mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(pwr.color || '#00E5FF'),
          emissive: new THREE.Color(pwr.color || '#00E5FF'),
          emissiveIntensity: 0.45,
          roughness: 0.15,
          metalness: 0.3
        });
        const crystal = new THREE.Mesh(geo, mat);
        crystal.castShadow = true;
        meshGroup.add(crystal);

        const ringGeo = new THREE.RingGeometry(0.55, 0.8, 20);
        ringGeo.rotateX(-Math.PI / 2);
        const ringMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(pwr.color || '#00E5FF'),
          side: THREE.DoubleSide
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.y = -0.55;
        meshGroup.add(ring);

        const label = this.createNameplateSprite(`${pwr.icon} ${pwr.name}`, pwr.color, 2.5, false);
        label.position.set(0, 1.2, 0);
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
      state.players.forEach((p) => {
        const record = this.ensurePlayerMesh(p);
        record.targetPos.set(p.x, p.y, p.z);
        record.targetRot = p.ry;
        record.charge = p.charge || 0;
        record.grabbedTargetId = p.grabbedTargetId;
        record.grabbedById = p.grabbedById;
        record.stunned = Boolean(p.stunned);
        record.invisible = Boolean(p.invisible);
        record.heavy = Boolean(p.heavy);
        record.shocked = Boolean(p.shocked);
        record.hasMegaShove = Boolean(p.hasMegaShove);
        record.hasShockWeapon = Boolean(p.hasShockWeapon);
        record.alive = p.alive;

        const isLocal = p.id === this.localSocketId;
        if (!p.alive && p.y <= -10.5) {
          record.group.visible = false;
        } else if (record.invisible && !isLocal) {
          record.group.visible = false;
        } else {
          record.group.visible = true;
          const targetOpacity = record.invisible && isLocal ? 0.42 : 1.0;
          record.bodyMat.opacity = targetOpacity;
          record.visorMat.opacity = targetOpacity;
          record.handMat.opacity = targetOpacity;
        }

        record.heavyShield.visible = record.heavy;
        record.shockCage.visible = record.shocked;
        record.shockGun.visible = record.hasShockWeapon;
        record.stunRing.visible = record.stunned;

        if (record.hasMegaShove) {
          record.handMat.color.setHex(0xffd600);
        } else {
          record.handMat.color.set(record.baseColorHex);
        }

        if (isLocal) {
          this.localChargePower = p.charge || 0;
          this.isLocalGrabbed = Boolean(p.grabbedById);
        }
      });
    }
  }

  spawnShockwave({ x, z, power = 0.6, isMega = false }) {
    if (!this.isActive || this.isVictoryStage) return;

    const ringGeo = new THREE.RingGeometry(0.5, isMega ? 1.4 : 0.95, 28);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: isMega ? 0xffd600 : power > 0.75 ? 0xff3366 : 0x00e5ff,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(ringGeo, ringMat);
    mesh.position.set(x, 0.15, z);
    this.fxGroup.add(mesh);

    this.shockwaves.push({
      mesh,
      mat: ringMat,
      scale: 1,
      maxScale: isMega ? 6.5 : 2.8 + power * 1.8
    });
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

  bindInputListeners() {
    window.addEventListener('keydown', (e) => {
      if (!this.isActive || this.isVictoryStage) return;

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
      if (!this.isActive || this.isVictoryStage) return;
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

      if (this.controlsConfig.matchesAction('grab', mouseCode)) {
        if (this.combatLocked) return;
        if (!this.isLocalGrabbed) {
          this.isChargingGrab = true;
        }
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (!this.isActive) return;
      const mouseCode = `Mouse${e.button}`;
      this.pressedCodes.delete(mouseCode);

      if (this.controlsConfig.matchesAction('shove', mouseCode)) {
        this.isChargingShove = false;
      }

      if (this.controlsConfig.matchesAction('grab', mouseCode)) {
        this.isChargingGrab = false;
      }
    });

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
  }

  sendLocalInput() {
    if (!this.isActive || this.isVictoryStage) return;

    let moveX = this.touchMove.x;
    let moveZ = this.touchMove.z;

    for (const code of this.pressedCodes) {
      if (this.controlsConfig.matchesAction('up', code)) moveZ -= 1;
      if (this.controlsConfig.matchesAction('down', code)) moveZ += 1;
      if (this.controlsConfig.matchesAction('left', code)) moveX -= 1;
      if (this.controlsConfig.matchesAction('right', code)) moveX += 1;
    }

    const len = Math.hypot(moveX, moveZ);
    if (len > 1) {
      moveX /= len;
      moveZ /= len;
    }

    this.socket.emit('match:input', {
      moveX,
      moveZ,
      charging: this.combatLocked ? false : this.isChargingShove,
      grabCharging: this.combatLocked ? false : this.isChargingGrab
    });
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    if (!this.isActive) return;

    const dt = Math.min(this.clock.getDelta(), 0.1);
    const elapsedTime = this.clock.getElapsedTime();

    if (this.isVictoryStage) {
      for (const actor of this.victoryActors) {
        if (actor.isWinner) {
          const jump = Math.abs(Math.sin(elapsedTime * 5.2 + actor.phase)) * 0.65;
          actor.group.position.y = actor.baseY + jump;
          actor.leftHand.position.y = 1.65 + Math.sin(elapsedTime * 10 + actor.phase) * 0.22;
          actor.rightHand.position.y = 1.65 + Math.cos(elapsedTime * 10 + actor.phase) * 0.22;
        } else {
          actor.group.rotation.y = -0.25 + Math.sin(elapsedTime * 2.2 + actor.phase) * 0.12;
        }
      }
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.sendLocalInput();

    // Anima os anéis e partículas ascendentes do Abismo 3D
    if (this.abyssParticles) {
      this.abyssParticles.rotation.y += dt * 0.08;
      const posAttr = this.abyssParticles.geometry.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        let py = posAttr.getY(i) + dt * 2.5;
        if (py > 8) py = -36;
        posAttr.setY(i, py);
      }
      posAttr.needsUpdate = true;
    }

    for (const meshGroup of this.powerupMeshes.values()) {
      if (meshGroup.userData?.crystal) {
        meshGroup.userData.crystal.rotation.y += dt * 2.4;
        meshGroup.userData.crystal.rotation.x += dt * 1.2;
      }
    }

    for (const record of this.playerMeshes.values()) {
      record.group.position.lerp(record.targetPos, Math.min(1, dt * 16));
      record.group.rotation.y = record.targetRot;

      if (record.shocked) {
        record.group.position.x += Math.sin(elapsedTime * 55) * 0.08;
        record.shockCage.rotation.y += dt * 8;
      }

      if (record.stunned) {
        record.stunRing.rotation.z += dt * 10;
      }
      if (record.heavy) {
        record.heavyShield.rotation.y += dt * 3;
      }

      if (record.grabbedTargetId) {
        record.leftHand.position.set(-0.55, 1.85, 0.35);
        record.rightHand.position.set(0.55, 1.85, 0.35);
      } else {
        const chargeOffset = (record.charge || 0) * 0.35;
        record.leftHand.position.set(-0.78, 0.95, 0.3 - chargeOffset);
        record.rightHand.position.set(0.78, 0.95, 0.3 - chargeOffset);
      }

      const baseHandScale = record.hasMegaShove ? 1.55 : 1.0;
      const handScale = baseHandScale + (record.charge || 0) * 0.45;
      record.leftHand.scale.setScalar(handScale);
      record.rightHand.scale.setScalar(handScale);
    }

    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.scale += dt * 11;
      sw.mesh.scale.setScalar(sw.scale);
      sw.mat.opacity = Math.max(0, 1 - sw.scale / sw.maxScale);
      if (sw.scale >= sw.maxScale) {
        this.fxGroup.remove(sw.mesh);
        this.shockwaves.splice(i, 1);
      }
    }

    for (let i = this.lightningBolts.length - 1; i >= 0; i--) {
      const bolt = this.lightningBolts[i];
      bolt.ttl -= dt;
      if (bolt.ttl <= 0) {
        this.fxGroup.remove(bolt.line);
        this.lightningBolts.splice(i, 1);
      }
    }

    const chargeBar = document.getElementById('hud-charge-fill');
    if (chargeBar) {
      const pct = Math.round((this.localChargePower || 0) * 100);
      chargeBar.style.width = `${pct}%`;
    }

    const localMesh = this.playerMeshes.get(this.localSocketId);
    if (localMesh && localMesh.alive) {
      const targetCamX = localMesh.group.position.x * 0.35;
      const targetCamZ = 21 + localMesh.group.position.z * 0.35;
      this.camera.position.x += (targetCamX - this.camera.position.x) * dt * 5;
      this.camera.position.z += (targetCamZ - this.camera.position.z) * dt * 5;
      this.camera.position.y = 17.5;
      this.camera.lookAt(
        localMesh.group.position.x * 0.25,
        0,
        localMesh.group.position.z * 0.25
      );
    } else {
      this.camera.position.set(0, 20, 23);
      this.camera.lookAt(0, 0, 0);
    }

    this.renderer.render(this.scene, this.camera);
  }
}
