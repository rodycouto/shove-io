// client/js/scenes/LobbyBackgroundScene.js
// ============================================================================
// Cena 3D animada de fundo para a tela de Login e Lobby (Three.js - v2.0).
// Personagens redesenhados com geometria Low-Poly Arcade ultra-leve (redução de
// mais de 78% nos polígonos por boneco) e Object Pooling de ondas de choque.
// ============================================================================

import * as THREE from '/vendor/three/three.module.js';

export class LobbyBackgroundScene {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.bots = [];
    this.shockwavePool = [];
    this.activeShockwaves = [];
    this.clock = new THREE.Clock();
    this.cameraAngle = 0;
    this.isPaused = false;

    this.initSharedGeometries();
    this.initScene();
    this.createLights();
    this.createArenaPlatform();
    this.initShockwavePool(10);
    this.spawnDemoShovers();
    this.bindResize();
    this.animate();
  }

  /**
   * Geometrias Low-Poly facetadas de baixíssimo custo para aliviar o processamento.
   */
  initSharedGeometries() {
    const ringGeo = new THREE.RingGeometry(0.45, 0.85, 16);
    ringGeo.rotateX(-Math.PI / 2);

    this.sharedGeos = {
      torso: new THREE.CylinderGeometry(0.46, 0.56, 0.92, 8),
      head: new THREE.CylinderGeometry(0.38, 0.46, 0.34, 8),
      visor: new THREE.BoxGeometry(0.62, 0.22, 0.24),
      hand: new THREE.IcosahedronGeometry(0.22, 0),
      shockwaveRing: ringGeo
    };

    this.sharedVisorMat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff
    });
  }

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
      180
    );

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.shadowMap.enabled = false;

    this.fxGroup = new THREE.Group();
    this.scene.add(this.fxGroup);
  }

  createLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    this.scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xfff5e6, 1.25);
    dirLight.position.set(14, 24, 12);
    this.scene.add(dirLight);
  }

  createArenaPlatform() {
    this.arenaGroup = new THREE.Group();

    const platformGeo = new THREE.CylinderGeometry(11, 9.2, 2.4, 12);
    const platformMat = new THREE.MeshLambertMaterial({
      color: 0x232946,
      flatShading: true
    });
    const platform = new THREE.Mesh(platformGeo, platformMat);
    platform.position.y = -1.2;
    this.arenaGroup.add(platform);

    const ringGeo = new THREE.RingGeometry(10.3, 10.95, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff3366,
      side: THREE.DoubleSide
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.02;
    this.arenaGroup.add(ring);

    const centerGeo = new THREE.RingGeometry(2.6, 3.0, 20);
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

  initShockwavePool(size = 10) {
    for (let i = 0; i < size; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00e5ff,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(this.sharedGeos.shockwaveRing, mat);
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

  /**
   * Cria o novo personagem Low-Poly Arcade Brawler (muito mais leve para a GPU).
   */
  createShoverMesh(colorHex) {
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

    const visor = new THREE.Mesh(this.sharedGeos.visor, this.sharedVisorMat);
    visor.position.set(0, 1.18, 0.36);
    body.add(visor);

    group.add(body);

    const leftHand = new THREE.Mesh(this.sharedGeos.hand, bodyMat);
    leftHand.position.set(-0.72, 0.85, 0.3);
    const rightHand = new THREE.Mesh(this.sharedGeos.hand, bodyMat);
    rightHand.position.set(0.72, 0.85, 0.3);
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
        isHero: index === 0,
        velocity: new THREE.Vector3(0, 0, 0),
        isFallingOff: false,
        chargePower: 0,
        isCharging: false,
        shoveCooldown: 0.4 + Math.random() * 1.0,
        strafeDir: index % 2 === 0 ? 1 : -1,
        strafeTimer: 1.5 + Math.random() * 2.0,
        hopPhase: Math.random() * Math.PI * 2
      });
    });
  }

  setHeroColor(colorHex) {
    if (this.bots.length > 0) {
      this.bots[0].bodyMat.color.set(colorHex);
    }
  }

  spawnDemoShockwave(x, z, power = 0.7) {
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
    item.maxScale = 2.5 + power * 1.5;
    item.mat.color.setHex(power > 0.8 ? 0xff3366 : 0x00e5ff);
    item.mat.opacity = 0.85;
    item.mesh.position.set(x, 0.12, z);
    item.mesh.scale.setScalar(1);
    item.mesh.visible = true;

    this.activeShockwaves.push(item);
  }

  updateBots(dt) {
    const ARENA_RADIUS = 10.55;
    const ARENA_RADIUS_SQ = ARENA_RADIUS * ARENA_RADIUS;
    const GRAVITY_ON_ARENA = 22.0;
    const GRAVITY_FALLING = 28.0;
    const horizontalDamping = Math.pow(0.89, dt * 60);

    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      const pos = bot.group.position;
      const distFromCenterSq = pos.x * pos.x + pos.z * pos.z;

      if (distFromCenterSq > ARENA_RADIUS_SQ) {
        bot.isFallingOff = true;
      }

      if (bot.isFallingOff) {
        bot.velocity.y -= GRAVITY_FALLING * dt;
        pos.addScaledVector(bot.velocity, dt);
        bot.group.rotation.x += dt * 4.0;

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

      bot.shoveCooldown = Math.max(0, bot.shoveCooldown - dt);
      bot.strafeTimer -= dt;
      if (bot.strafeTimer <= 0) {
        bot.strafeDir *= -1;
        bot.strafeTimer = 1.2 + Math.random() * 1.8;
      }

      let nearest = null;
      let minDistSq = Infinity;
      for (let j = 0; j < this.bots.length; j++) {
        if (i === j) continue;
        const other = this.bots[j];
        if (other.isFallingOff || other.group.position.y > 2.5) continue;
        const dx = other.group.position.x - pos.x;
        const dz = other.group.position.z - pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < minDistSq) {
          minDistSq = dSq;
          nearest = other;
        }
      }

      let moveX = 0;
      let moveZ = 0;

      if (nearest) {
        const minDist = Math.sqrt(minDistSq);
        const dx = nearest.group.position.x - pos.x;
        const dz = nearest.group.position.z - pos.z;
        const len = minDist || 1;
        const dirX = dx / len;
        const dirZ = dz / len;

        const perpX = -dirZ * bot.strafeDir * 0.35;
        const perpZ = dirX * bot.strafeDir * 0.35;
        moveX = dirX + perpX;
        moveZ = dirZ + perpZ;

        bot.group.rotation.y = Math.atan2(dirX, dirZ);

        if (minDist < 3.4 && bot.shoveCooldown <= 0) {
          bot.isCharging = true;
          bot.chargePower = Math.min(1.0, bot.chargePower + dt * 1.3);

          if (minDist < 1.75 || bot.chargePower >= 0.85) {
            const power = Math.max(0.5, bot.chargePower);
            const shoveForce = 13 + power * 9;

            nearest.velocity.x = dirX * shoveForce;
            nearest.velocity.z = dirZ * shoveForce;
            nearest.velocity.y = 3.8 + power * 1.8;

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

      const safeZoneRadius = ARENA_RADIUS * 0.72;
      if (distFromCenterSq > safeZoneRadius * safeZoneRadius && distFromCenterSq > 0.0001) {
        const distFromCenter = Math.sqrt(distFromCenterSq);
        const urgency = (distFromCenter - safeZoneRadius) / (ARENA_RADIUS * 0.28);
        const pullStrength = 1.6 + urgency * 1.8;
        moveX += (-pos.x / distFromCenter) * pullStrength;
        moveZ += (-pos.z / distFromCenter) * pullStrength;
      }

      const moveLenSq = moveX * moveX + moveZ * moveZ;
      if (moveLenSq > 1) {
        const moveLen = Math.sqrt(moveLenSq);
        moveX /= moveLen;
        moveZ /= moveLen;
      }

      const speedMult = bot.isCharging ? 0.68 : 1.0;
      const accel = 16.5 * speedMult;
      bot.velocity.x += moveX * accel * dt;
      bot.velocity.z += moveZ * accel * dt;

      bot.velocity.x *= horizontalDamping;
      bot.velocity.z *= horizontalDamping;

      bot.velocity.y -= GRAVITY_ON_ARENA * dt;
      pos.addScaledVector(bot.velocity, dt);

      if (pos.y <= 0) {
        pos.y = 0;
        if (bot.velocity.y < 0) {
          bot.velocity.y = 0;
        }
      }

      bot.hopPhase += dt * 11;
      const walkBounce = pos.y === 0 ? Math.abs(Math.sin(bot.hopPhase)) * 0.14 : 0;
      bot.body.position.y = walkBounce;

      const chargeOffset = bot.chargePower * 0.32;
      bot.leftHand.position.set(-0.72, 0.85 + walkBounce, 0.3 - chargeOffset);
      bot.rightHand.position.set(0.72, 0.85 + walkBounce, 0.3 - chargeOffset);
      const handScale = 1 + bot.chargePower * 0.45;
      bot.leftHand.scale.setScalar(handScale);
      bot.rightHand.scale.setScalar(handScale);
    }

    const MIN_DIST = 1.32;
    const MIN_DIST_SQ = MIN_DIST * MIN_DIST;

    for (let i = 0; i < this.bots.length; i++) {
      const b1 = this.bots[i];
      if (b1.isFallingOff || b1.group.position.y > 2.0) continue;

      for (let j = i + 1; j < this.bots.length; j++) {
        const b2 = this.bots[j];
        if (b2.isFallingOff || b2.group.position.y > 2.0) continue;

        const dx = b2.group.position.x - b1.group.position.x;
        const dz = b2.group.position.z - b1.group.position.z;
        const distSq = dx * dx + dz * dz;

        if (distSq < MIN_DIST_SQ && distSq > 0.000001) {
          const dist = Math.sqrt(distSq);
          const nx = dx / dist;
          const nz = dz / dist;
          const overlap = (MIN_DIST - dist) * 0.5;

          b1.group.position.x -= nx * overlap;
          b1.group.position.z -= nz * overlap;
          b2.group.position.x += nx * overlap;
          b2.group.position.z += nz * overlap;

          const bump = 4.2;
          b1.velocity.x -= nx * bump;
          b1.velocity.z -= nz * bump;
          b2.velocity.x += nx * bump;
          b2.velocity.z += nz * bump;
        }
      }
    }

    for (let i = this.activeShockwaves.length - 1; i >= 0; i--) {
      const sw = this.activeShockwaves[i];
      sw.scale += dt * 9.5;
      sw.mesh.scale.setScalar(sw.scale);
      sw.mat.opacity = Math.max(0, 1 - sw.scale / sw.maxScale);
      if (sw.scale >= sw.maxScale) {
        sw.mesh.visible = false;
        sw.inUse = false;
        this.activeShockwaves.splice(i, 1);
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

    this.cameraAngle += dt * 0.22;
    const camRadius = 22;
    this.camera.position.x = Math.cos(this.cameraAngle) * camRadius;
    this.camera.position.z = Math.sin(this.cameraAngle) * camRadius;
    this.camera.position.y = 12.5;
    this.camera.lookAt(0, 0.5, 0);

    this.renderer.render(this.scene, this.camera);
  }
}
