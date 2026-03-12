/**
 * 3D Visualization for the Greenhouse Solar Heater system.
 * Uses Three.js to render an interactive 3D scene with:
 * - Tank with thermal stratification gradient
 * - Solar collector panels
 * - Reservoir at correct height
 * - Greenhouse with radiator
 * - Animated flow particles
 * - Pipe network with glow effects
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── Color constants ──
const COLORS = {
  tank_cold: new THREE.Color(0x1565c0),
  tank_hot: new THREE.Color(0xe53935),
  collector: new THREE.Color(0xf9a825),
  collector_frame: new THREE.Color(0x5d4037),
  pipe_cold: new THREE.Color(0x42a5f5),
  pipe_hot: new THREE.Color(0xef5350),
  pump_idle: new THREE.Color(0x555555),
  pump_active: new THREE.Color(0xe040fb),
  greenhouse_frame: new THREE.Color(0x76ff03),
  radiator: new THREE.Color(0xef5350),
  reservoir: new THREE.Color(0x0d47a1),
  ground: new THREE.Color(0x1a1a2e),
  background: new THREE.Color(0x0a0e17),
  fan_idle: new THREE.Color(0x555555),
  fan_active: new THREE.Color(0x76ff03),
  sun: new THREE.Color(0xf9a825),
};

// Height scale: 1 unit = 1cm in real system, scaled by 0.01 for Three.js
const SCALE = 0.01;

export class Scene3D {
  constructor(container) {
    this.container = container;
    this.particles = [];
    this.animationId = null;
    this.clock = new THREE.Clock();

    this._init();
    this._buildScene();
    this._animate();
  }

  _init() {
    const w = this.container.clientWidth;
    const h = Math.max(this.container.clientHeight, 400);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = COLORS.background;
    this.scene.fog = new THREE.FogExp2(0x0a0e17, 0.15);

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
    this.camera.position.set(4.5, 3, 5);
    this.camera.lookAt(0, 1.2, 0);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.2, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI * 0.85;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 12;
    this.controls.update();

    // Resize handler
    this._onResize = () => {
      const w = this.container.clientWidth;
      const h = Math.max(this.container.clientHeight, 400);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    };
    window.addEventListener('resize', this._onResize);

    // Lights
    const ambient = new THREE.AmbientLight(0x334466, 0.6);
    this.scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0x4488cc, 0x002244, 0.4);
    this.scene.add(hemi);

    this.sunLight = new THREE.DirectionalLight(0xf9a825, 0.8);
    this.sunLight.position.set(-3, 6, 2);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 20;
    this.sunLight.shadow.camera.left = -5;
    this.sunLight.shadow.camera.right = 5;
    this.sunLight.shadow.camera.top = 5;
    this.sunLight.shadow.camera.bottom = -5;
    this.scene.add(this.sunLight);

    const fill = new THREE.PointLight(0x42a5f5, 0.3, 10);
    fill.position.set(2, 2, -2);
    this.scene.add(fill);
  }

  _buildScene() {
    // ── Ground plane ──
    const groundGeo = new THREE.PlaneGeometry(15, 15);
    const groundMat = new THREE.MeshStandardMaterial({
      color: COLORS.ground,
      roughness: 0.9,
      metalness: 0.1,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Grid helper (subtle)
    const grid = new THREE.GridHelper(10, 20, 0x222244, 0x151530);
    grid.position.y = 0.001;
    this.scene.add(grid);

    // ── Tank (300L, ~60cm diameter, 200cm tall, bottom at 0cm) ──
    this._buildTank();

    // ── Reservoir (at 200-220cm, beside tank) ──
    this._buildReservoir();

    // ── Solar Collectors (2 panels, 30-280cm height range) ──
    this._buildCollectors();

    // ── Greenhouse structure ──
    this._buildGreenhouse();

    // ── Pump ──
    this._buildPump();

    // ── Pipes ──
    this._buildPipes();

    // ── Sun indicator ──
    this._buildSun();

    // ── Labels (sprite text) ──
    this._buildLabels();
  }

  _buildTank() {
    // Tank body (cylinder)
    const tankGeo = new THREE.CylinderGeometry(0.3, 0.3, 2.0, 32);
    this.tankMat = new THREE.MeshStandardMaterial({
      color: 0x1565c0,
      roughness: 0.3,
      metalness: 0.7,
      transparent: true,
      opacity: 0.4,
    });
    this.tank = new THREE.Mesh(tankGeo, this.tankMat);
    this.tank.position.set(0, 1.0, 0);
    this.tank.castShadow = true;
    this.tank.receiveShadow = true;
    this.scene.add(this.tank);

    // Tank water fill (inner cylinder, height varies with water level)
    const waterGeo = new THREE.CylinderGeometry(0.28, 0.28, 1.97, 32);
    this.tankWaterTopMat = new THREE.MeshStandardMaterial({
      color: 0xe53935,
      roughness: 0.1,
      metalness: 0.2,
      transparent: true,
      opacity: 0.7,
    });
    this.tankWaterBotMat = new THREE.MeshStandardMaterial({
      color: 0x1565c0,
      roughness: 0.1,
      metalness: 0.2,
      transparent: true,
      opacity: 0.7,
    });

    // Top half water
    const waterTopGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.98, 32);
    this.tankWaterTop = new THREE.Mesh(waterTopGeo, this.tankWaterTopMat);
    this.tankWaterTop.position.set(0, 1.5, 0);
    this.scene.add(this.tankWaterTop);

    // Bottom half water
    const waterBotGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.98, 32);
    this.tankWaterBot = new THREE.Mesh(waterBotGeo, this.tankWaterBotMat);
    this.tankWaterBot.position.set(0, 0.5, 0);
    this.scene.add(this.tankWaterBot);

    // Tank top cap (metallic)
    const capGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.03, 32);
    const capMat = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.2, metalness: 0.9 });
    const topCap = new THREE.Mesh(capGeo, capMat);
    topCap.position.set(0, 2.01, 0);
    this.scene.add(topCap);
    const botCap = new THREE.Mesh(capGeo, capMat);
    botCap.position.set(0, -0.01, 0);
    this.scene.add(botCap);

    // Dip tube (thin red cylinder inside tank)
    const dipGeo = new THREE.CylinderGeometry(0.02, 0.02, 1.97, 8);
    const dipMat = new THREE.MeshStandardMaterial({ color: 0xef5350, roughness: 0.5, metalness: 0.5 });
    const dipTube = new THREE.Mesh(dipGeo, dipMat);
    dipTube.position.set(0.1, 1.0, 0.1);
    this.scene.add(dipTube);
  }

  _buildReservoir() {
    // Reservoir is at 200-220cm (2.0 - 2.2 in scene units), placed beside tank
    const resGeo = new THREE.BoxGeometry(0.3, 0.2, 0.25);
    const resMat = new THREE.MeshStandardMaterial({
      color: COLORS.reservoir,
      roughness: 0.3,
      metalness: 0.5,
      transparent: true,
      opacity: 0.5,
    });
    this.reservoir = new THREE.Mesh(resGeo, resMat);
    this.reservoir.position.set(0.5, 2.1, 0);
    this.reservoir.castShadow = true;
    this.scene.add(this.reservoir);

    // Reservoir water (inside)
    const resWaterGeo = new THREE.BoxGeometry(0.26, 0.15, 0.21);
    this.resWaterMat = new THREE.MeshStandardMaterial({
      color: 0x42a5f5,
      roughness: 0.1,
      metalness: 0.2,
      transparent: true,
      opacity: 0.7,
    });
    this.resWater = new THREE.Mesh(resWaterGeo, this.resWaterMat);
    this.resWater.position.set(0.5, 2.08, 0);
    this.scene.add(this.resWater);

    // Open top indicator (green wireframe ring)
    const ringGeo = new THREE.RingGeometry(0.12, 0.15, 4);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x76ff03, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0.5, 2.21, 0);
    this.scene.add(ring);

    // Pipe from reservoir down to tank (dip tube connection)
    this._createPipe(
      new THREE.Vector3(0.35, 2.05, 0),
      new THREE.Vector3(0.2, 2.05, 0),
      0x42a5f5, 0.02
    );
    this._createPipe(
      new THREE.Vector3(0.2, 2.05, 0),
      new THREE.Vector3(0.2, 1.98, 0),
      0x42a5f5, 0.02
    );
  }

  _buildCollectors() {
    const collectorGroup = new THREE.Group();
    collectorGroup.position.set(-2.5, 0, 0);

    // Two collector panels (1m x 2m each, tilted at ~60 degrees for Finnish latitude)
    for (let i = 0; i < 2; i++) {
      const panelGroup = new THREE.Group();

      // Glass surface
      const glassGeo = new THREE.BoxGeometry(1.0, 0.04, 0.5);
      this['collectorMat' + i] = new THREE.MeshStandardMaterial({
        color: COLORS.collector,
        roughness: 0.1,
        metalness: 0.8,
        transparent: true,
        opacity: 0.85,
        emissive: COLORS.collector,
        emissiveIntensity: 0.1,
      });
      const panel = new THREE.Mesh(glassGeo, this['collectorMat' + i]);
      panelGroup.add(panel);

      // Frame
      const frameGeo = new THREE.BoxGeometry(1.06, 0.06, 0.56);
      const frameMat = new THREE.MeshStandardMaterial({
        color: COLORS.collector_frame,
        roughness: 0.8,
        metalness: 0.3,
      });
      const frame = new THREE.Mesh(new THREE.EdgesGeometry(frameGeo), new THREE.LineBasicMaterial({ color: 0x795548 }));
      panelGroup.add(frame);

      // Absorber tubes (inside)
      for (let t = -0.18; t <= 0.18; t += 0.09) {
        const tubeGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.9, 8);
        const tubeMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.9, roughness: 0.2 });
        const tube = new THREE.Mesh(tubeGeo, tubeMat);
        tube.rotation.z = Math.PI / 2;
        tube.position.set(0, -0.01, t);
        panelGroup.add(tube);
      }

      panelGroup.position.set(0, 1.55 + i * 0.7, i * 0.15);
      panelGroup.rotation.x = -Math.PI * 0.33; // ~60 degree tilt
      panelGroup.castShadow = true;
      collectorGroup.add(panelGroup);
    }

    // Support frame (legs)
    const legMat = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.5, metalness: 0.7 });
    const legGeo = new THREE.CylinderGeometry(0.02, 0.02, 2.5, 8);
    for (const xOff of [-0.45, 0.45]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(xOff, 1.15, -0.2);
      leg.rotation.x = 0.15;
      collectorGroup.add(leg);

      const legFront = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.02, 0.8, 8),
        legMat
      );
      legFront.position.set(xOff, 0.4, 0.5);
      collectorGroup.add(legFront);
    }

    this.collectorGroup = collectorGroup;
    this.scene.add(collectorGroup);
  }

  _buildGreenhouse() {
    const ghGroup = new THREE.Group();
    ghGroup.position.set(3, 0, 0);

    // Greenhouse frame (wireframe box)
    const ghGeo = new THREE.BoxGeometry(2, 1.5, 1.5);
    const ghMat = new THREE.MeshStandardMaterial({
      color: COLORS.greenhouse_frame,
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
    });
    const gh = new THREE.Mesh(ghGeo, ghMat);
    gh.position.y = 0.75;
    ghGroup.add(gh);

    // Wireframe edges
    const ghEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(ghGeo),
      new THREE.LineBasicMaterial({ color: 0x76ff03, linewidth: 1, transparent: true, opacity: 0.5 })
    );
    ghEdges.position.y = 0.75;
    ghGroup.add(ghEdges);

    // Roof (triangular prism shape approximation)
    const roofShape = new THREE.Shape();
    roofShape.moveTo(-1.05, 0);
    roofShape.lineTo(0, 0.5);
    roofShape.lineTo(1.05, 0);
    roofShape.closePath();
    const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 1.55, bevelEnabled: false });
    const roofMat = new THREE.MeshStandardMaterial({
      color: 0x76ff03,
      transparent: true,
      opacity: 0.05,
      side: THREE.DoubleSide,
    });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.set(0, 1.5, -0.775);
    ghGroup.add(roof);

    // Radiator (small metallic box inside greenhouse)
    const radGeo = new THREE.BoxGeometry(0.5, 0.3, 0.08);
    this.radiatorMat = new THREE.MeshStandardMaterial({
      color: 0x555555,
      roughness: 0.3,
      metalness: 0.8,
    });
    this.radiator = new THREE.Mesh(radGeo, this.radiatorMat);
    this.radiator.position.set(-0.5, 0.5, 0.6);
    this.radiator.castShadow = true;
    ghGroup.add(this.radiator);

    // Radiator fins
    for (let f = -0.2; f <= 0.2; f += 0.04) {
      const finGeo = new THREE.BoxGeometry(0.005, 0.25, 0.06);
      const finMat = new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.8, roughness: 0.3 });
      const fin = new THREE.Mesh(finGeo, finMat);
      fin.position.set(f, 0.5, 0.6);
      ghGroup.add(fin);
    }

    // Fan (circle behind radiator)
    const fanGeo = new THREE.CircleGeometry(0.12, 16);
    this.fanMat = new THREE.MeshStandardMaterial({
      color: COLORS.fan_idle,
      side: THREE.DoubleSide,
    });
    this.fan = new THREE.Mesh(fanGeo, this.fanMat);
    this.fan.position.set(-0.5, 0.5, 0.66);
    ghGroup.add(this.fan);

    // Fan blades
    this.fanBlades = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const bladeGeo = new THREE.BoxGeometry(0.18, 0.03, 0.005);
      const bladeMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.7 });
      const blade = new THREE.Mesh(bladeGeo, bladeMat);
      blade.rotation.z = (i * Math.PI) / 4;
      this.fanBlades.add(blade);
    }
    this.fanBlades.position.set(-0.5, 0.5, 0.67);
    ghGroup.add(this.fanBlades);

    this.greenhouseGroup = ghGroup;
    this.scene.add(ghGroup);
  }

  _buildPump() {
    // Pump (torus + cylinder at bottom of system)
    const pumpGroup = new THREE.Group();
    pumpGroup.position.set(-1.0, 0.15, 0.5);

    const bodyGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.15, 16);
    this.pumpMat = new THREE.MeshStandardMaterial({
      color: COLORS.pump_idle,
      roughness: 0.3,
      metalness: 0.8,
    });
    this.pumpBody = new THREE.Mesh(bodyGeo, this.pumpMat);
    pumpGroup.add(this.pumpBody);

    // Pump impeller ring
    const ringGeo = new THREE.TorusGeometry(0.09, 0.015, 8, 24);
    this.pumpRingMat = new THREE.MeshStandardMaterial({
      color: COLORS.pump_idle,
      roughness: 0.2,
      metalness: 0.9,
      emissive: COLORS.pump_idle,
      emissiveIntensity: 0,
    });
    this.pumpRing = new THREE.Mesh(ringGeo, this.pumpRingMat);
    this.pumpRing.rotation.x = Math.PI / 2;
    this.pumpRing.position.y = 0.08;
    pumpGroup.add(this.pumpRing);

    this.pumpGroup = pumpGroup;
    this.scene.add(pumpGroup);
  }

  _buildPipes() {
    this.pipeGroups = {};

    // Solar charging path: tank bottom → pump → collectors → reservoir
    const solarPipes = new THREE.Group();
    const sp = [
      // Tank bottom to pump
      [new THREE.Vector3(0, 0.1, 0.3), new THREE.Vector3(-1.0, 0.1, 0.5)],
      // Pump to collector bottom
      [new THREE.Vector3(-1.0, 0.1, 0.5), new THREE.Vector3(-2.5, 0.1, 0.5)],
      [new THREE.Vector3(-2.5, 0.1, 0.5), new THREE.Vector3(-2.5, 0.5, 0.3)],
      // Collector top back to reservoir
      [new THREE.Vector3(-2.5, 2.5, -0.2), new THREE.Vector3(-1.0, 2.5, -0.2)],
      [new THREE.Vector3(-1.0, 2.5, -0.2), new THREE.Vector3(0.5, 2.1, 0)],
    ];
    for (const [start, end] of sp) {
      solarPipes.add(this._createPipeObj(start, end, 0x42a5f5, 0.025));
    }
    solarPipes.visible = false;
    this.pipeGroups.solar = solarPipes;
    this.scene.add(solarPipes);

    // Greenhouse heating path: reservoir → pump → radiator → tank bottom
    const heatPipes = new THREE.Group();
    const hp = [
      // Reservoir to pump
      [new THREE.Vector3(0.5, 2.0, 0), new THREE.Vector3(0.5, 0.15, 0.3)],
      [new THREE.Vector3(0.5, 0.15, 0.3), new THREE.Vector3(-1.0, 0.15, 0.5)],
      // Pump to radiator
      [new THREE.Vector3(-1.0, 0.15, 0.5), new THREE.Vector3(2.5, 0.5, 0.6)],
      // Radiator return to tank
      [new THREE.Vector3(2.5, 0.5, 0.6), new THREE.Vector3(1.5, 0.1, 0.3)],
      [new THREE.Vector3(1.5, 0.1, 0.3), new THREE.Vector3(0, 0.1, 0)],
    ];
    for (const [start, end] of hp) {
      heatPipes.add(this._createPipeObj(start, end, 0xef5350, 0.025));
    }
    heatPipes.visible = false;
    this.pipeGroups.heating = heatPipes;
    this.scene.add(heatPipes);

    // Drain path: collectors → pump → tank
    const drainPipes = new THREE.Group();
    const dp = [
      [new THREE.Vector3(-2.5, 0.5, 0.3), new THREE.Vector3(-1.0, 0.15, 0.5)],
      [new THREE.Vector3(-1.0, 0.15, 0.5), new THREE.Vector3(0, 0.1, 0)],
    ];
    for (const [start, end] of dp) {
      drainPipes.add(this._createPipeObj(start, end, 0xff9800, 0.025));
    }
    drainPipes.visible = false;
    this.pipeGroups.drain = drainPipes;
    this.scene.add(drainPipes);

    // Always-visible subtle pipe outlines
    const allPipePoints = [
      // Tank to pump area
      [new THREE.Vector3(0, 0.1, 0.3), new THREE.Vector3(-1.0, 0.1, 0.5)],
      // Pump to collector area
      [new THREE.Vector3(-1.0, 0.1, 0.5), new THREE.Vector3(-2.5, 0.1, 0.5)],
      [new THREE.Vector3(-2.5, 0.1, 0.5), new THREE.Vector3(-2.5, 0.5, 0.3)],
      // Collector top return
      [new THREE.Vector3(-2.5, 2.5, -0.2), new THREE.Vector3(0.5, 2.1, 0)],
      // To greenhouse
      [new THREE.Vector3(-1.0, 0.15, 0.5), new THREE.Vector3(2.5, 0.5, 0.6)],
      // Reservoir pipe
      [new THREE.Vector3(0.5, 2.0, 0), new THREE.Vector3(0.5, 0.15, 0.3)],
    ];
    for (const [start, end] of allPipePoints) {
      const pipe = this._createPipeObj(start, end, 0x333344, 0.015);
      pipe.material.transparent = true;
      pipe.material.opacity = 0.3;
      this.scene.add(pipe);
    }
  }

  _buildSun() {
    const sunGeo = new THREE.SphereGeometry(0.3, 16, 16);
    this.sunMat = new THREE.MeshBasicMaterial({
      color: COLORS.sun,
      transparent: true,
      opacity: 0.5,
    });
    this.sun = new THREE.Mesh(sunGeo, this.sunMat);
    this.sun.position.set(-4, 5, 2);
    this.scene.add(this.sun);

    // Sun glow
    const glowGeo = new THREE.SphereGeometry(0.5, 16, 16);
    this.sunGlowMat = new THREE.MeshBasicMaterial({
      color: COLORS.sun,
      transparent: true,
      opacity: 0.15,
    });
    const sunGlow = new THREE.Mesh(glowGeo, this.sunGlowMat);
    sunGlow.position.copy(this.sun.position);
    this.scene.add(sunGlow);
    this.sunGlow = sunGlow;
  }

  _buildLabels() {
    // We'll create text labels using canvas-based sprites
    this.labels = {};
    this.labels.tankTop = this._createLabel('--°C', 0, 1.7, 0.5);
    this.labels.tankBot = this._createLabel('--°C', 0, 0.3, 0.5);
    this.labels.collector = this._createLabel('--°C', -2.5, 2.8, 0.3);
    this.labels.greenhouse = this._createLabel('--°C', 3, 1.2, 0);
    this.labels.outdoor = this._createLabel('--°C', -4, 0.3, 0);
    this.labels.pump = this._createLabel('OFF', -1.0, 0.4, 0.5);
    this.labels.mode = this._createLabel('IDLE', 0, 2.8, 0);
    this.labels.irradiance = this._createLabel('-- W/m²', -3.5, 4.5, 2);
    this.labels.fan = this._createLabel('Fan: OFF', 3, 0.9, 0.8);
    this.labels.tankName = this._createLabel('Tank 300L', 0, 2.2, 0.5);
    this.labels.collectorName = this._createLabel('Collectors 4m²', -2.5, 3.2, 0);
    this.labels.reservoirName = this._createLabel('Reservoir', 0.5, 2.35, 0);
  }

  _createLabel(text, x, y, z) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;

    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(x, y, z);
    sprite.scale.set(0.8, 0.2, 1);
    this.scene.add(sprite);

    this._updateLabelText(sprite, text, '#c9d1d9');
    return sprite;
  }

  _updateLabelText(sprite, text, color = '#c9d1d9', bgColor = null) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, 256, 64);

    if (bgColor) {
      ctx.fillStyle = bgColor;
      const metrics = ctx.measureText(text);
      const padding = 8;
      ctx.roundRect?.(128 - metrics.width / 2 - padding, 16, metrics.width + padding * 2, 36, 6);
      ctx.fill?.();
    }

    ctx.font = 'bold 24px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 32);

    sprite.material.map.image = canvas;
    sprite.material.map.needsUpdate = true;
  }

  _createPipe(start, end, color, radius) {
    const pipe = this._createPipeObj(start, end, color, radius);
    this.scene.add(pipe);
    return pipe;
  }

  _createPipeObj(start, end, color, radius) {
    const dir = new THREE.Vector3().subVectors(end, start);
    const len = dir.length();
    const geo = new THREE.CylinderGeometry(radius, radius, len, 8);
    const mat = new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.3,
      metalness: 0.7,
    });
    const pipe = new THREE.Mesh(geo, mat);

    const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    pipe.position.copy(mid);

    const axis = new THREE.Vector3(0, 1, 0);
    const normalized = dir.clone().normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(axis, normalized);
    pipe.setRotationFromQuaternion(quaternion);

    pipe.castShadow = true;
    return pipe;
  }

  // ── Flow particles ──
  _createFlowParticles(path, color) {
    const particleGroup = new THREE.Group();
    const particleMat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.9,
    });
    const particleGeo = new THREE.SphereGeometry(0.02, 6, 6);

    const particles = [];
    for (let i = 0; i < 12; i++) {
      const p = new THREE.Mesh(particleGeo, particleMat.clone());
      p.userData.pathProgress = i / 12;
      p.userData.speed = 0.15 + Math.random() * 0.05;
      particleGroup.add(p);
      particles.push(p);
    }

    particleGroup.userData.path = path;
    particleGroup.userData.particles = particles;
    this.scene.add(particleGroup);
    return particleGroup;
  }

  // ── Update state ──
  update(state, result) {
    if (!state || !result) return;

    const dt = this.clock.getDelta();

    // Temperature-based colors
    const tempToColor = (t) => {
      const frac = Math.max(0, Math.min(1, (t - 5) / 80));
      return new THREE.Color().lerpColors(COLORS.tank_cold, COLORS.tank_hot, frac);
    };

    // Tank water colors
    this.tankWaterTopMat.color.copy(tempToColor(state.t_tank_top));
    this.tankWaterBotMat.color.copy(tempToColor(state.t_tank_bottom));
    this.tankWaterTopMat.emissive = tempToColor(state.t_tank_top).multiplyScalar(0.15);
    this.tankWaterBotMat.emissive = tempToColor(state.t_tank_bottom).multiplyScalar(0.15);

    // Collector glow based on irradiance
    const irrFrac = Math.min(state.irradiance / 800, 1);
    for (let i = 0; i < 2; i++) {
      const mat = this['collectorMat' + i];
      if (mat) {
        mat.emissiveIntensity = irrFrac * 0.4;
      }
    }

    // Sun opacity based on irradiance
    this.sunMat.opacity = 0.3 + irrFrac * 0.7;
    this.sunGlowMat.opacity = irrFrac * 0.25;
    this.sunLight.intensity = 0.3 + irrFrac * 0.7;

    // Pump state
    const pumpOn = result.actuators.pump;
    const pumpColor = pumpOn ? COLORS.pump_active : COLORS.pump_idle;
    this.pumpMat.color.copy(pumpColor);
    this.pumpRingMat.color.copy(pumpColor);
    this.pumpRingMat.emissive.copy(pumpColor);
    this.pumpRingMat.emissiveIntensity = pumpOn ? 0.5 : 0;

    // Pump rotation animation
    if (pumpOn) {
      this.pumpRing.rotation.z += dt * 5;
    }

    // Fan animation
    const fanOn = result.actuators.fan;
    this.fanMat.color.copy(fanOn ? COLORS.fan_active : COLORS.fan_idle);
    if (fanOn) {
      this.fanBlades.rotation.z += dt * 15;
    }

    // Radiator glow when heating
    const heating = result.mode === 'greenhouse_heating';
    this.radiatorMat.color.set(heating ? 0xef5350 : 0x555555);
    this.radiatorMat.emissive = new THREE.Color(heating ? 0xef5350 : 0x000000);
    this.radiatorMat.emissiveIntensity = heating ? 0.3 : 0;

    // Pipe visibility based on mode
    const mode = result.mode;
    this.pipeGroups.solar.visible = mode === 'solar_charging';
    this.pipeGroups.heating.visible = mode === 'greenhouse_heating';
    this.pipeGroups.drain.visible = mode === 'active_drain' || mode === 'overheat_drain';

    // Pipe animation (pulsing opacity)
    if (pumpOn) {
      const pulse = 0.6 + Math.sin(Date.now() * 0.003) * 0.4;
      const activeGroup = mode === 'solar_charging' ? this.pipeGroups.solar
        : mode === 'greenhouse_heating' ? this.pipeGroups.heating
        : this.pipeGroups.drain;
      if (activeGroup.visible) {
        activeGroup.traverse(child => {
          if (child.material) {
            child.material.opacity = pulse;
            child.material.transparent = true;
          }
        });
      }
    }

    // Update labels
    this._updateLabelText(this.labels.tankTop, state.t_tank_top.toFixed(1) + '°C', tempToColor(state.t_tank_top).getStyle());
    this._updateLabelText(this.labels.tankBot, state.t_tank_bottom.toFixed(1) + '°C', tempToColor(state.t_tank_bottom).getStyle());
    this._updateLabelText(this.labels.collector, state.t_collector.toFixed(1) + '°C', '#f9a825');
    this._updateLabelText(this.labels.greenhouse, state.t_greenhouse.toFixed(1) + '°C', '#76ff03');
    this._updateLabelText(this.labels.outdoor, 'Out: ' + state.t_outdoor.toFixed(1) + '°C', '#8b949e');
    this._updateLabelText(this.labels.pump, pumpOn ? 'PUMP ON' : 'PUMP OFF', pumpOn ? '#e040fb' : '#8b949e');
    this._updateLabelText(this.labels.irradiance, state.irradiance + ' W/m²', '#f9a825');
    this._updateLabelText(this.labels.fan, 'Fan: ' + (fanOn ? 'ON' : 'OFF'), fanOn ? '#76ff03' : '#8b949e');

    // Mode label
    const modeColors = {
      idle: '#8b949e',
      solar_charging: '#f9a825',
      greenhouse_heating: '#ef5350',
      active_drain: '#ff9800',
      overheat_drain: '#ff9800',
      emergency_heating: '#e53935',
    };
    this._updateLabelText(this.labels.mode, mode.replace(/_/g, ' ').toUpperCase(), modeColors[mode] || '#8b949e');
  }

  _animate() {
    this.animationId = requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    if (this.animationId) cancelAnimationFrame(this.animationId);
    this.renderer.dispose();
    this.controls.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
