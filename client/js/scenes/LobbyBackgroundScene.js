// client/js/scenes/LobbyBackgroundScene.js
// ============================================================================
// Cena 3D animada de fundo para a tela de Login e Lobby (Three.js).
// Simula uma partida real na arena de fundo:
// - Colisão física sólida com o piso da plataforma (impede que os bonecos
//   atravessem o chão ao pular, levar empurrão ou renascer).
// - IA de combate ativo: os bonecos perseguem adversários, desviam da borda,
//   carregam a força nas mãos, aplicam Shoves com onda de choque 3D e colidem
//   fisicamente uns com os outros.
// ============================================================================

import * as THREE from '/vendor/three/three.module.js';

export class LobbyBackgroundScene {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.bots = [];
    this.shockwaves = [];
    this.clock = new THREE.Clock();
    this.cameraAngle = 0;
    this.isPaused = false;

    this.initScene();
    this.createLights();
    this.createArenaPlatform();
    this.spawnDemoShovers();
    this.bindResize();
    this.animate();
  }

  /**
   * Pausa ou retoma a animação de fundo para economizar GPU durante a partida.
   */
  setPaused(paused) {
    this.isPaused = Boolean(paused);
    if (!this.isPaused) {
      this.clock.getDelta();
    }
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d0f1a);
    this.scene.fog = new THREE.FogExp2(0x0d0f1a, 0.02);

    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.1,
      200
    );

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // Limita o pixelRatio em 2 para não sobrecarregar celulares Retina (iOS/Android)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Grupo para efeitos visuais de ondas de choque dos empurrões no lobby
    this.fxGroup = new THREE.Group();
    this.scene.add(this.fxGroup);
  }

  createLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    this.scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xfff5e6, 1.35);
    dirLight.position.set(14, 24, 12);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    this.scene.add(dirLight);

    const rimLight = new THREE.PointLight(0x00e5ff, 2, 35);
    rimLight.position.set(-12, 6, -10);
    this.scene.add(rimLight);
  }

  createArenaPlatform() {
    this.arenaGroup = new THREE.Group();

    // Base principal cilíndrica/dodecagonal
    const platformGeo = new THREE.CylinderGeometry(11, 9.2, 2.4, 16);
    const platformMat = new THREE.MeshStandardMaterial({
      color: 0x232946,
      roughness: 0.4,
      metalness: 0.1
    });
    const platform = new THREE.Mesh(platformGeo, platformMat);
    platform.position.y = -1.2;
    platform.receiveShadow = true;
    this.arenaGroup.add(platform);

    // Borda neon de aviso de queda
    const ringGeo = new THREE.RingGeometry(10.3, 10.95, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff3366,
      side: THREE.DoubleSide
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.02;
    this.arenaGroup.add(ring);

    // Círculo central
    const centerGeo = new THREE.RingGeometry(2.6, 3.0, 24);
    centerGeo.rotateX(-Math.PI / 2);
    const centerMat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      side: THREE.DoubleSide
    });
    const centerRing = new THREE.Mesh(centerGeo, centerMat);
    centerRing.position.y = 0.02;
    this.arenaGroup.add(centerRing);

    this.scene.add(this.arenaGroup);
  }

  createShoverMesh(colorHex) {
    const group = new THREE.Group();

    // Corpo estilo cápsula/feijão (Bean)
    const bodyGeo = new THREE.CapsuleGeometry(0.65, 0.7, 8, 16);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colorHex),
      roughness: 0.3
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 1.0;
    body.castShadow = true;
    group.add(body);

    // Visor/Olhos estilo arcade
    const visorGeo = new THREE.BoxGeometry(0.75, 0.28, 0.35);
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.1
    });
    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 1.25, 0.5);
    group.add(visor);

    // Mãos flutuantes de empurrão
    const handGeo = new THREE.SphereGeometry(0.24, 12, 12);
    const leftHand = new THREE.Mesh(handGeo, bodyMat);
    leftHand.position.set(-0.78, 0.95, 0.3);
    const rightHand = new THREE.Mesh(handGeo, bodyMat);
    rightHand.position.set(0.78, 0.95, 0.3);
    group.add(leftHand, rightHand);

    return { group, body, bodyMat, leftHand, rightHand };
  }

  spawnDemoShovers() {
    const palette = ['#FF3366', '#00E5FF', '#FFD600', '#00E676', '#AA00FF', '#FF6D00'];

    palette.forEach((hex, index) => {
      const shover = this.createShoverMesh(hex);
      const angle = (index / palette.length) * Math.PI * 2;
      const radius = 5.0;

      shover.group.position.set(
        Math.cos(angle) * radius,
        0,
        Math.sin(angle) * radius
      );
      shover.group.rotation.y = Math.atan2(-shover.group.position.x, -shover.group.position.z);

      this.scene.add(shover.group);

      this.bots.push({
        ...shover,
        isHero: index === 0, // Reflete a cor escolhida pelo jogador no login
        velocity: new THREE.Vector3(0, 0, 0),
        isFallingOff: false, // Controla se o boneco já passou da borda da arena
        chargePower: 0,
        isCharging: false,
        shoveCooldown: 0.4 + Math.random() * 1.0,
        strafeDir: index % 2 === 0 ? 1 : -1,
        strafeTimer: 1.5 + Math.random() * 2.0,
        hopPhase: Math.random() * Math.PI * 2
      });
    });
  }

  /**
   * Atualiza a cor do boneco principal quando o usuário escolhe uma cor no Login.
   */
  setHeroColor(colorHex) {
    if (this.bots.length > 0) {
      this.bots[0].bodyMat.color.set(colorHex);
    }
  }

  /**
   * Cria o efeito de onda de choque 3D quando um bot empurra outro na demonstração.
   */
  spawnDemoShockwave(x, z, power = 0.7) {
    const ringGeo = new THREE.RingGeometry(0.45, 0.85, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: power > 0.8 ? 0xff3366 : 0x00e5ff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(ringGeo, ringMat);
    mesh.position.set(x, 0.12, z);
    this.fxGroup.add(mesh);

    this.shockwaves.push({
      mesh,
      mat: ringMat,
      scale: 1,
      maxScale: 2.5 + power * 1.5
    });
  }

  /**
   * Atualiza a inteligência artificial, física de plataforma e luta entre os bots.
   */
  updateBots(dt) {
    const ARENA_RADIUS = 10.55;
    const GRAVITY_ON_ARENA = 22.0;
    const GRAVITY_FALLING = 28.0;

    // 1. Movimentação individual, IA de combate e colisão com o piso da plataforma
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      const pos = bot.group.position;
      const distFromCenter = Math.hypot(pos.x, pos.z);

      // Verifica se o boneco saiu do raio da plataforma
      if (distFromCenter > ARENA_RADIUS) {
        bot.isFallingOff = true;
      }

      // Se já caiu para fora da borda da plataforma, aplica gravidade de abismo até renascer
      if (bot.isFallingOff) {
        bot.velocity.y -= GRAVITY_FALLING * dt;
        pos.addScaledVector(bot.velocity, dt);
        bot.group.rotation.x += dt * 4.0;

        // Quando cai fundo no abismo, renasce caindo suavemente no centro da plataforma
        if (pos.y < -14) {
          const spawnAngle = Math.random() * Math.PI * 2;
          const spawnR = 1.5 + Math.random() * 3.5;
          pos.set(Math.cos(spawnAngle) * spawnR, 5.5, Math.sin(spawnAngle) * spawnR);
          bot.velocity.set(0, -2, 0);
          bot.isFallingOff = false;
          bot.isCharging = false;
          bot.chargePower = 0;
          bot.group.rotation.x = 0;
        }
        continue;
      }

      // --- BONECO ESTÁ DENTRO DO RAIO DA PLATAFORMA ---
      bot.shoveCooldown = Math.max(0, bot.shoveCooldown - dt);
      bot.strafeTimer -= dt;
      if (bot.strafeTimer <= 0) {
        bot.strafeDir *= -1;
        bot.strafeTimer = 1.2 + Math.random() * 1.8;
      }

      // Procura o adversário mais próximo que também esteja na plataforma
      let nearest = null;
      let minDist = Infinity;
      for (let j = 0; j < this.bots.length; j++) {
        if (i === j) continue;
        const other = this.bots[j];
        if (other.isFallingOff || other.group.position.y > 2.5) continue;
        const d = Math.hypot(other.group.position.x - pos.x, other.group.position.z - pos.z);
        if (d < minDist) {
          minDist = d;
          nearest = other;
        }
      }

      let moveX = 0;
      let moveZ = 0;

      if (nearest) {
        const dx = nearest.group.position.x - pos.x;
        const dz = nearest.group.position.z - pos.z;
        const len = Math.hypot(dx, dz) || 1;
        const dirX = dx / len;
        const dirZ = dz / len;

        // Combina perseguição frontal com leve movimentação lateral (strafe) de combate
        const perpX = -dirZ * bot.strafeDir * 0.35;
        const perpZ = dirX * bot.strafeDir * 0.35;
        moveX = dirX + perpX;
        moveZ = dirZ + perpZ;

        // Olha suavemente na direção do oponente
        const targetAngle = Math.atan2(dirX, dirZ);
        bot.group.rotation.y = targetAngle;

        // Quando se aproxima, começa a carregar o empurrão (Shove)
        if (minDist < 3.4 && bot.shoveCooldown <= 0) {
          bot.isCharging = true;
          bot.chargePower = Math.min(1.0, bot.chargePower + dt * 1.3);

          // Se chegou perto o bastante ou carregou bastante força, dispara o SHOVE!
          if (minDist < 1.75 || bot.chargePower >= 0.85) {
            const power = Math.max(0.5, bot.chargePower);
            const shoveForce = 13 + power * 9;

            // Impulso no alvo empurrado
            nearest.velocity.x = dirX * shoveForce;
            nearest.velocity.z = dirZ * shoveForce;
            nearest.velocity.y = 3.8 + power * 1.8;

            // Pequeno avanço de ataque seguido de recuo natural
            bot.velocity.x = -dirX * 3.2;
            bot.velocity.z = -dirZ * 3.2;

            this.spawnDemoShockwave(pos.x + dirX * 0.7, pos.z + dirZ * 0.7, power);

            bot.isCharging = false;
            bot.chargePower = 0;
            bot.shoveCooldown = 0.85 + Math.random() * 0.9;
          }
        } else if (minDist > 4.2) {
          bot.isCharging = false;
          bot.chargePower = Math.max(0, bot.chargePower - dt * 2);
        }
      }

      // Instinto de sobrevivência: se estiver perto da borda vermelha, faz força para voltar ao centro!
      if (distFromCenter > ARENA_RADIUS * 0.72 && distFromCenter > 0.01) {
        const urgency = (distFromCenter - ARENA_RADIUS * 0.72) / (ARENA_RADIUS * 0.28);
        const pullStrength = 1.6 + urgency * 1.8;
        moveX += (-pos.x / distFromCenter) * pullStrength;
        moveZ += (-pos.z / distFromCenter) * pullStrength;
      }

      // Normaliza a direção desejada e aplica aceleração
      const moveLen = Math.hypot(moveX, moveZ);
      if (moveLen > 1) {
        moveX /= moveLen;
        moveZ /= moveLen;
      }

      const speedMult = bot.isCharging ? 0.68 : 1.0;
      const accel = 16.5 * speedMult;
      bot.velocity.x += moveX * accel * dt;
      bot.velocity.z += moveZ * accel * dt;

      // Atrito horizontal da plataforma
      bot.velocity.x *= 0.89;
      bot.velocity.z *= 0.89;

      // Gravidade vertical e integração de posição
      bot.velocity.y -= GRAVITY_ON_ARENA * dt;
      pos.addScaledVector(bot.velocity, dt);

      // COLISÃO SÓLIDA COM O PISO DA PLATAFORMA (Impede passar direto pelo chão!)
      if (pos.y <= 0) {
        pos.y = 0;
        if (bot.velocity.y < 0) {
          bot.velocity.y = 0;
        }
      }

      // Pulinho animado de caminhada no corpo (sem alterar pos.y físico abaixo de zero)
      bot.hopPhase += dt * 11;
      const walkBounce = pos.y === 0 ? Math.abs(Math.sin(bot.hopPhase)) * 0.16 : 0;
      bot.body.position.y = 1.0 + walkBounce;

      // Animação das mãos carregando força do Shove
      const chargeOffset = bot.chargePower * 0.32;
      bot.leftHand.position.set(-0.78, 0.95 + walkBounce, 0.3 - chargeOffset);
      bot.rightHand.position.set(0.78, 0.95 + walkBounce, 0.3 - chargeOffset);
      const handScale = 1 + bot.chargePower * 0.45;
      bot.leftHand.scale.setScalar(handScale);
      bot.rightHand.scale.setScalar(handScale);
    }

    // 2. Colisão física corpo a corpo entre os bonecos na plataforma (não deixa atravessar um ao outro)
    for (let i = 0; i < this.bots.length; i++) {
      const b1 = this.bots[i];
      if (b1.isFallingOff || b1.group.position.y > 2.0) continue;

      for (let j = i + 1; j < this.bots.length; j++) {
        const b2 = this.bots[j];
        if (b2.isFallingOff || b2.group.position.y > 2.0) continue;

        const dx = b2.group.position.x - b1.group.position.x;
        const dz = b2.group.position.z - b1.group.position.z;
        const dist = Math.hypot(dx, dz);
        const minDist = 1.32;

        if (dist < minDist && dist > 0.001) {
          const nx = dx / dist;
          const nz = dz / dist;
          const overlap = (minDist - dist) * 0.5;

          b1.group.position.x -= nx * overlap;
          b1.group.position.z -= nz * overlap;
          b2.group.position.x += nx * overlap;
          b2.group.position.z += nz * overlap;

          // Encontrão elástico de luta
          const bump = 4.2;
          b1.velocity.x -= nx * bump;
          b1.velocity.z -= nz * bump;
          b2.velocity.x += nx * bump;
          b2.velocity.z += nz * bump;
        }
      }
    }

    // 3. Atualiza as ondas de choque 3D dos empurrões
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.scale += dt * 9.5;
      sw.mesh.scale.setScalar(sw.scale);
      sw.mat.opacity = Math.max(0, 1 - sw.scale / sw.maxScale);
      if (sw.scale >= sw.maxScale) {
        this.fxGroup.remove(sw.mesh);
        this.shockwaves.splice(i, 1);
      }
    }
  }

  bindResize() {
    window.addEventListener('resize', () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.fov = w < h ? 68 : 50;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
    window.dispatchEvent(new Event('resize'));
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    if (this.isPaused) return;

    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.updateBots(dt);

    // Câmera orbitando suavemente ao redor da arena
    this.cameraAngle += dt * 0.22;
    const camRadius = 22;
    this.camera.position.x = Math.cos(this.cameraAngle) * camRadius;
    this.camera.position.z = Math.sin(this.cameraAngle) * camRadius;
    this.camera.position.y = 12.5;
    this.camera.lookAt(0, 0.5, 0);

    this.renderer.render(this.scene, this.camera);
  }
}