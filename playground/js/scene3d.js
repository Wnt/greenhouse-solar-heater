/**
 * 3D Visualization for the Greenhouse Solar Heater system.
 * Uses Three.js to render a static-camera 3D scene with:
 * - Tank with thermal stratification gradient
 * - Solar collector panels on tilted frame
 * - Reservoir at correct height (200-220cm)
 * - Greenhouse with radiator and fan
 * - Animated flow particles along active pipe paths
 * - Pipe network with mode-dependent highlighting
 *
 * Layout matches system.yaml topology:
 *   Collectors (left) ── Tank+Reservoir (center) ── Greenhouse (right)
 *   Pump at ground level between tank and collectors
 */

import * as THREE from 'three';

// ── Color palette (matches SVG diagram conventions from CLAUDE.md) ──
const COLORS = {
  tank_cold: new THREE.Color(0x1565c0),
  tank_hot: new THREE.Color(0xe53935),
  collector: new THREE.Color(0xf9a825),
  collector_frame: new THREE.Color(0x5d4037),
  pipe_cold: new THREE.Color(0x42a5f5),
  pipe_hot: new THREE.Color(0xef5350),
  pump_idle: new THREE.Color(0x666666),
  pump_active: new THREE.Color(0xe040fb),
  greenhouse_frame: new THREE.Color(0x76ff03),
  radiator: new THREE.Color(0xef5350),
  reservoir: new THREE.Color(0x1565c0),
  ground: new THREE.Color(0x1a1a2e),
  background: new THREE.Color(0x0d1117),
  fan_idle: new THREE.Color(0x666666),
  fan_active: new THREE.Color(0x76ff03),
  sun: new THREE.Color(0xf9a825),
  pipe_outline: new THREE.Color(0x556677),
};

export class Scene3D {
  constructor(container) {
    this.container = container;
    this.flowParticles = [];
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
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.6;
    this.container.appendChild(this.renderer.domElement);

    // Scene — no fog
    this.scene = new THREE.Scene();
    this.scene.background = COLORS.background;

    // Camera — fixed isometric-ish view showing full layout
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 50);
    this.camera.position.set(5, 4.5, 7);
    this.camera.lookAt(0.5, 1.0, 0);

    // Resize handler
    this._onResize = () => {
      const w2 = this.container.clientWidth;
      const h2 = Math.max(this.container.clientHeight, 400);
      this.camera.aspect = w2 / h2;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w2, h2);
    };
    window.addEventListener('resize', this._onResize);

    // ── Lighting ──
    // Strong ambient to ensure nothing disappears into blackness
    const ambient = new THREE.AmbientLight(0x8899bb, 1.0);
    this.scene.add(ambient);

    // Hemisphere: sky blue above, darker below
    const hemi = new THREE.HemisphereLight(0x88aadd, 0x223344, 0.6);
    this.scene.add(hemi);

    // Sun directional light — warm yellow
    this.sunLight = new THREE.DirectionalLight(0xffd080, 1.0);
    this.sunLight.position.set(-4, 8, 3);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 20;
    this.sunLight.shadow.camera.left = -6;
    this.sunLight.shadow.camera.right = 6;
    this.sunLight.shadow.camera.top = 6;
    this.sunLight.shadow.camera.bottom = -3;
    this.scene.add(this.sunLight);

    // Cool fill light from the right
    const fill = new THREE.PointLight(0x6688cc, 0.5, 15);
    fill.position.set(5, 3, -2);
    this.scene.add(fill);

    // Rim light from behind
    const rim = new THREE.PointLight(0x4466aa, 0.3, 15);
    rim.position.set(-2, 2, -4);
    this.scene.add(rim);
  }

  _buildScene() {
    // ── Ground plane ──
    const groundGeo = new THREE.PlaneGeometry(16, 16);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a2e,
      roughness: 0.95,
      metalness: 0.0,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Subtle grid
    const grid = new THREE.GridHelper(12, 24, 0x2a2a44, 0x1a1a30);
    grid.position.y = 0.002;
    this.scene.add(grid);

    this._buildTank();
    this._buildReservoir();
    this._buildCollectors();
    this._buildGreenhouse();
    this._buildPump();
    this._buildPipes();
    this._buildSun();
    this._buildLabels();
  }

  // ── Tank (300L, ~60cm diameter, 200cm tall, bottom at ground level) ──
  _buildTank() {
    // Outer shell — semi-transparent to show water inside
    const tankGeo = new THREE.CylinderGeometry(0.3, 0.3, 2.0, 32);
    this.tankMat = new THREE.MeshStandardMaterial({
      color: 0x3388cc,
      roughness: 0.4,
      metalness: 0.6,
      transparent: true,
      opacity: 0.35,
    });
    this.tank = new THREE.Mesh(tankGeo, this.tankMat);
    this.tank.position.set(0, 1.0, 0);
    this.tank.castShadow = true;
    this.tank.receiveShadow = true;
    this.scene.add(this.tank);

    // Top half water
    const waterTopGeo = new THREE.CylinderGeometry(0.27, 0.27, 0.98, 32);
    this.tankWaterTopMat = new THREE.MeshStandardMaterial({
      color: 0xe53935,
      roughness: 0.2,
      metalness: 0.1,
      transparent: true,
      opacity: 0.85,
      emissive: new THREE.Color(0xe53935),
      emissiveIntensity: 0.15,
    });
    this.tankWaterTop = new THREE.Mesh(waterTopGeo, this.tankWaterTopMat);
    this.tankWaterTop.position.set(0, 1.5, 0);
    this.scene.add(this.tankWaterTop);

    // Bottom half water
    const waterBotGeo = new THREE.CylinderGeometry(0.27, 0.27, 0.98, 32);
    this.tankWaterBotMat = new THREE.MeshStandardMaterial({
      color: 0x1565c0,
      roughness: 0.2,
      metalness: 0.1,
      transparent: true,
      opacity: 0.85,
      emissive: new THREE.Color(0x1565c0),
      emissiveIntensity: 0.1,
    });
    this.tankWaterBot = new THREE.Mesh(waterBotGeo, this.tankWaterBotMat);
    this.tankWaterBot.position.set(0, 0.5, 0);
    this.scene.add(this.tankWaterBot);

    // Tank caps (metallic)
    const capGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.04, 32);
    const capMat = new THREE.MeshStandardMaterial({ color: 0x667788, roughness: 0.2, metalness: 0.9 });
    const topCap = new THREE.Mesh(capGeo, capMat);
    topCap.position.set(0, 2.02, 0);
    this.scene.add(topCap);
    const botCap = new THREE.Mesh(capGeo.clone(), capMat);
    botCap.position.set(0, -0.02, 0);
    this.scene.add(botCap);

    // Dip tube (thin red cylinder inside tank — visible through transparent shell)
    const dipGeo = new THREE.CylinderGeometry(0.02, 0.02, 1.85, 8);
    const dipMat = new THREE.MeshStandardMaterial({
      color: 0xef5350,
      roughness: 0.4,
      metalness: 0.5,
      emissive: new THREE.Color(0xef5350),
      emissiveIntensity: 0.2,
    });
    const dipTube = new THREE.Mesh(dipGeo, dipMat);
    dipTube.position.set(0.1, 0.925, 0.1);
    this.scene.add(dipTube);
  }

  // ── Reservoir (200-220cm, on top of tank) ──
  _buildReservoir() {
    const resGeo = new THREE.BoxGeometry(0.3, 0.2, 0.25);
    const resMat = new THREE.MeshStandardMaterial({
      color: 0x2277bb,
      roughness: 0.3,
      metalness: 0.5,
      transparent: true,
      opacity: 0.6,
    });
    this.reservoir = new THREE.Mesh(resGeo, resMat);
    this.reservoir.position.set(0.5, 2.1, 0);
    this.reservoir.castShadow = true;
    this.scene.add(this.reservoir);

    // Reservoir water inside
    const resWaterGeo = new THREE.BoxGeometry(0.26, 0.14, 0.21);
    this.resWaterMat = new THREE.MeshStandardMaterial({
      color: 0x42a5f5,
      roughness: 0.1,
      metalness: 0.1,
      transparent: true,
      opacity: 0.8,
      emissive: new THREE.Color(0x42a5f5),
      emissiveIntensity: 0.1,
    });
    this.resWater = new THREE.Mesh(resWaterGeo, this.resWaterMat);
    this.resWater.position.set(0.5, 2.08, 0);
    this.scene.add(this.resWater);

    // Open vent indicator (green ring on top)
    const ringGeo = new THREE.RingGeometry(0.1, 0.13, 4);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x76ff03, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0.5, 2.21, 0);
    this.scene.add(ring);

    // Pipe from reservoir to tank (dip tube connection)
    this._createPipe(new THREE.Vector3(0.35, 2.05, 0), new THREE.Vector3(0.15, 2.05, 0), 0x42a5f5, 0.02);
    this._createPipe(new THREE.Vector3(0.15, 2.05, 0), new THREE.Vector3(0.15, 1.98, 0), 0x42a5f5, 0.02);
  }

  // ── Solar Collectors (2 panels, tilted ~60° for Finnish latitude) ──
  _buildCollectors() {
    const collectorGroup = new THREE.Group();
    collectorGroup.position.set(-2.5, 0, 0);

    for (let i = 0; i < 2; i++) {
      const panelGroup = new THREE.Group();

      // Glass surface
      const glassGeo = new THREE.BoxGeometry(1.0, 0.04, 0.5);
      this['collectorMat' + i] = new THREE.MeshStandardMaterial({
        color: COLORS.collector,
        roughness: 0.1,
        metalness: 0.7,
        emissive: COLORS.collector,
        emissiveIntensity: 0.15,
      });
      const panel = new THREE.Mesh(glassGeo, this['collectorMat' + i]);
      panelGroup.add(panel);

      // Frame edges
      const frameGeo = new THREE.BoxGeometry(1.06, 0.06, 0.56);
      const frame = new THREE.LineSegments(
        new THREE.EdgesGeometry(frameGeo),
        new THREE.LineBasicMaterial({ color: 0x8d6e63 })
      );
      panelGroup.add(frame);

      // Absorber tubes
      for (let t = -0.18; t <= 0.18; t += 0.09) {
        const tubeGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.9, 8);
        const tubeMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.9, roughness: 0.2 });
        const tube = new THREE.Mesh(tubeGeo, tubeMat);
        tube.rotation.z = Math.PI / 2;
        tube.position.set(0, -0.01, t);
        panelGroup.add(tube);
      }

      panelGroup.position.set(0, 1.55 + i * 0.7, i * 0.15);
      panelGroup.rotation.x = -Math.PI * 0.33;
      panelGroup.castShadow = true;
      collectorGroup.add(panelGroup);
    }

    // Support legs
    const legMat = new THREE.MeshStandardMaterial({ color: 0x556666, roughness: 0.5, metalness: 0.7 });
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

  // ── Greenhouse with radiator + fan ──
  _buildGreenhouse() {
    const ghGroup = new THREE.Group();
    ghGroup.position.set(3, 0, 0);

    // Glass walls (semi-transparent green)
    const ghGeo = new THREE.BoxGeometry(2, 1.5, 1.5);
    const ghMat = new THREE.MeshStandardMaterial({
      color: COLORS.greenhouse_frame,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
    });
    const gh = new THREE.Mesh(ghGeo, ghMat);
    gh.position.y = 0.75;
    ghGroup.add(gh);

    // Wireframe edges (bright green)
    const ghEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(ghGeo),
      new THREE.LineBasicMaterial({ color: 0x76ff03, transparent: true, opacity: 0.7 })
    );
    ghEdges.position.y = 0.75;
    ghGroup.add(ghEdges);

    // Roof
    const roofShape = new THREE.Shape();
    roofShape.moveTo(-1.05, 0);
    roofShape.lineTo(0, 0.5);
    roofShape.lineTo(1.05, 0);
    roofShape.closePath();
    const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 1.55, bevelEnabled: false });
    const roofMat = new THREE.MeshStandardMaterial({
      color: 0x76ff03,
      transparent: true,
      opacity: 0.04,
      side: THREE.DoubleSide,
    });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.set(0, 1.5, -0.775);
    ghGroup.add(roof);

    // Roof edges
    const roofEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(roofGeo),
      new THREE.LineBasicMaterial({ color: 0x76ff03, transparent: true, opacity: 0.3 })
    );
    roofEdges.position.copy(roof.position);
    ghGroup.add(roofEdges);

    // Radiator
    const radGeo = new THREE.BoxGeometry(0.5, 0.3, 0.08);
    this.radiatorMat = new THREE.MeshStandardMaterial({
      color: 0x777777,
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
      const finMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.3 });
      const fin = new THREE.Mesh(finGeo, finMat);
      fin.position.set(f, 0.5, 0.6);
      ghGroup.add(fin);
    }

    // Fan
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
      const bladeMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.7, roughness: 0.3 });
      const blade = new THREE.Mesh(bladeGeo, bladeMat);
      blade.rotation.z = (i * Math.PI) / 4;
      this.fanBlades.add(blade);
    }
    this.fanBlades.position.set(-0.5, 0.5, 0.67);
    ghGroup.add(this.fanBlades);

    this.greenhouseGroup = ghGroup;
    this.scene.add(ghGroup);
  }

  // ── Pump (ground level between tank and collectors) ──
  _buildPump() {
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

    // Impeller ring
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

  // ── Pipe network ──
  _buildPipes() {
    this.pipeGroups = {};

    // Always-visible pipe outlines (the physical pipe layout)
    const outlinePaths = [
      // Tank bottom to pump
      [new THREE.Vector3(0, 0.1, 0.3), new THREE.Vector3(-1.0, 0.1, 0.5)],
      // Pump to collector bottom
      [new THREE.Vector3(-1.0, 0.1, 0.5), new THREE.Vector3(-2.5, 0.1, 0.5)],
      [new THREE.Vector3(-2.5, 0.1, 0.5), new THREE.Vector3(-2.5, 0.5, 0.3)],
      // Collector top return to reservoir
      [new THREE.Vector3(-2.5, 2.5, -0.2), new THREE.Vector3(-1.0, 2.5, -0.2)],
      [new THREE.Vector3(-1.0, 2.5, -0.2), new THREE.Vector3(0.5, 2.1, 0)],
      // Pump to greenhouse radiator
      [new THREE.Vector3(-1.0, 0.15, 0.5), new THREE.Vector3(2.5, 0.5, 0.6)],
      // Radiator return to tank bottom
      [new THREE.Vector3(2.5, 0.5, 0.6), new THREE.Vector3(1.5, 0.1, 0.3)],
      [new THREE.Vector3(1.5, 0.1, 0.3), new THREE.Vector3(0, 0.1, 0)],
      // Reservoir down-pipe (to VI-top)
      [new THREE.Vector3(0.5, 2.0, 0), new THREE.Vector3(0.5, 0.15, 0.3)],
      [new THREE.Vector3(0.5, 0.15, 0.3), new THREE.Vector3(-1.0, 0.15, 0.5)],
    ];
    for (const [start, end] of outlinePaths) {
      const pipe = this._createPipeObj(start, end, 0x445566, 0.018);
      pipe.material.transparent = true;
      pipe.material.opacity = 0.5;
      this.scene.add(pipe);
    }

    // Solar charging path (blue): tank btm → pump → coll btm → coll top → reservoir
    const solarPipes = new THREE.Group();
    const solarPath = [
      [new THREE.Vector3(0, 0.1, 0.3), new THREE.Vector3(-1.0, 0.1, 0.5)],
      [new THREE.Vector3(-1.0, 0.1, 0.5), new THREE.Vector3(-2.5, 0.1, 0.5)],
      [new THREE.Vector3(-2.5, 0.1, 0.5), new THREE.Vector3(-2.5, 0.5, 0.3)],
      [new THREE.Vector3(-2.5, 2.5, -0.2), new THREE.Vector3(-1.0, 2.5, -0.2)],
      [new THREE.Vector3(-1.0, 2.5, -0.2), new THREE.Vector3(0.5, 2.1, 0)],
    ];
    for (const [start, end] of solarPath) {
      solarPipes.add(this._createPipeObj(start, end, 0x42a5f5, 0.028));
    }
    solarPipes.visible = false;
    this.pipeGroups.solar = solarPipes;
    this.scene.add(solarPipes);

    // Greenhouse heating path (red): reservoir → pump → radiator → tank btm
    const heatPipes = new THREE.Group();
    const heatPath = [
      [new THREE.Vector3(0.5, 2.0, 0), new THREE.Vector3(0.5, 0.15, 0.3)],
      [new THREE.Vector3(0.5, 0.15, 0.3), new THREE.Vector3(-1.0, 0.15, 0.5)],
      [new THREE.Vector3(-1.0, 0.15, 0.5), new THREE.Vector3(2.5, 0.5, 0.6)],
      [new THREE.Vector3(2.5, 0.5, 0.6), new THREE.Vector3(1.5, 0.1, 0.3)],
      [new THREE.Vector3(1.5, 0.1, 0.3), new THREE.Vector3(0, 0.1, 0)],
    ];
    for (const [start, end] of heatPath) {
      heatPipes.add(this._createPipeObj(start, end, 0xef5350, 0.028));
    }
    heatPipes.visible = false;
    this.pipeGroups.heating = heatPipes;
    this.scene.add(heatPipes);

    // Drain path (orange): coll btm → pump → tank
    const drainPipes = new THREE.Group();
    const drainPath = [
      [new THREE.Vector3(-2.5, 0.5, 0.3), new THREE.Vector3(-1.0, 0.15, 0.5)],
      [new THREE.Vector3(-1.0, 0.15, 0.5), new THREE.Vector3(0, 0.1, 0)],
    ];
    for (const [start, end] of drainPath) {
      drainPipes.add(this._createPipeObj(start, end, 0xff9800, 0.028));
    }
    drainPipes.visible = false;
    this.pipeGroups.drain = drainPipes;
    this.scene.add(drainPipes);

    // Build flow particle systems for each path
    this._solarParticles = this._createFlowParticles(solarPath, 0x42a5f5);
    this._solarParticles.visible = false;
    this._heatParticles = this._createFlowParticles(heatPath, 0xef5350);
    this._heatParticles.visible = false;
    this._drainParticles = this._createFlowParticles(drainPath, 0xff9800);
    this._drainParticles.visible = false;
  }

  _buildSun() {
    const sunGeo = new THREE.SphereGeometry(0.3, 16, 16);
    this.sunMat = new THREE.MeshBasicMaterial({
      color: COLORS.sun,
      transparent: true,
      opacity: 0.6,
    });
    this.sun = new THREE.Mesh(sunGeo, this.sunMat);
    this.sun.position.set(-4, 5, 2);
    this.scene.add(this.sun);

    // Glow halo
    const glowGeo = new THREE.SphereGeometry(0.55, 16, 16);
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
    this.labels = {};
    this.labels.tankTop = this._createLabel('--\u00B0C', 0, 1.7, 0.5);
    this.labels.tankBot = this._createLabel('--\u00B0C', 0, 0.3, 0.5);
    this.labels.collector = this._createLabel('--\u00B0C', -2.5, 2.8, 0.3);
    this.labels.greenhouse = this._createLabel('--\u00B0C', 3, 1.7, 0);
    this.labels.outdoor = this._createLabel('--\u00B0C', -4.2, 0.4, 0);
    this.labels.pump = this._createLabel('PUMP OFF', -1.0, 0.45, 0.5);
    this.labels.mode = this._createLabel('IDLE', 0.5, 2.9, 0);
    this.labels.irradiance = this._createLabel('-- W/m\u00B2', -3.8, 4.2, 1.5);
    this.labels.fan = this._createLabel('Fan: OFF', 3, 0.9, 0.9);
    this.labels.tankName = this._createLabel('Tank 300L', 0, 2.25, 0.5);
    this.labels.collectorName = this._createLabel('Collectors 4m\u00B2', -2.5, 3.2, 0);
    this.labels.reservoirName = this._createLabel('Reservoir', 0.5, 2.4, 0);
  }

  _createLabel(text, x, y, z) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;

    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(x, y, z);
    sprite.scale.set(0.9, 0.225, 1);
    this.scene.add(sprite);

    this._updateLabelText(sprite, text, '#c9d1d9');
    return sprite;
  }

  _updateLabelText(sprite, text, color = '#c9d1d9') {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 64);

    // Dark rounded background for readability
    ctx.font = 'bold 22px sans-serif';
    const metrics = ctx.measureText(text);
    const pad = 10;
    const bgW = Math.min(metrics.width + pad * 2, 250);
    const bgX = 128 - bgW / 2;
    ctx.fillStyle = 'rgba(10, 14, 23, 0.75)';
    ctx.beginPath();
    ctx.roundRect(bgX, 10, bgW, 40, 6);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 30);

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
      metalness: 0.6,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.05,
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

  // ── Flow particles that travel along pipe paths ──
  _createFlowParticles(pathSegments, color) {
    const group = new THREE.Group();
    const pMat = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.95 });
    const pGeo = new THREE.SphereGeometry(0.025, 6, 6);

    const particles = [];
    const count = 10;
    for (let i = 0; i < count; i++) {
      const p = new THREE.Mesh(pGeo, pMat.clone());
      p.userData.progress = i / count;
      p.userData.speed = 0.12 + Math.random() * 0.04;
      group.add(p);
      particles.push(p);
    }

    group.userData.pathSegments = pathSegments;
    group.userData.particles = particles;
    // Pre-compute total path length and segment lengths
    let totalLen = 0;
    const segLens = [];
    for (const [s, e] of pathSegments) {
      const l = new THREE.Vector3().subVectors(e, s).length();
      segLens.push(l);
      totalLen += l;
    }
    group.userData.segLens = segLens;
    group.userData.totalLen = totalLen;

    this.scene.add(group);
    this.flowParticles.push(group);
    return group;
  }

  _updateFlowParticles(dt) {
    for (const group of this.flowParticles) {
      if (!group.visible) continue;
      const { pathSegments, particles, segLens, totalLen } = group.userData;
      for (const p of particles) {
        p.userData.progress += p.userData.speed * dt;
        if (p.userData.progress > 1) p.userData.progress -= 1;

        // Find position along path
        let dist = p.userData.progress * totalLen;
        let pos = null;
        for (let i = 0; i < pathSegments.length; i++) {
          if (dist <= segLens[i]) {
            const t = dist / segLens[i];
            const [s, e] = pathSegments[i];
            pos = new THREE.Vector3().lerpVectors(s, e, t);
            break;
          }
          dist -= segLens[i];
        }
        if (pos) p.position.copy(pos);
      }
    }
  }

  // ── Update state from simulation ──
  update(state, result) {
    if (!state || !result) return;

    const dt = this.clock.getDelta();

    // Temperature → color mapping
    const tempToColor = (t) => {
      const frac = Math.max(0, Math.min(1, (t - 5) / 75));
      return new THREE.Color().lerpColors(COLORS.tank_cold, COLORS.tank_hot, frac);
    };

    // Tank water colors
    const topColor = tempToColor(state.t_tank_top);
    const botColor = tempToColor(state.t_tank_bottom);
    this.tankWaterTopMat.color.copy(topColor);
    this.tankWaterTopMat.emissive.copy(topColor).multiplyScalar(0.2);
    this.tankWaterBotMat.color.copy(botColor);
    this.tankWaterBotMat.emissive.copy(botColor).multiplyScalar(0.15);

    // Collector glow based on irradiance
    const irrFrac = Math.min(state.irradiance / 800, 1);
    for (let i = 0; i < 2; i++) {
      const mat = this['collectorMat' + i];
      if (mat) {
        mat.emissiveIntensity = 0.1 + irrFrac * 0.5;
      }
    }

    // Sun intensity
    this.sunMat.opacity = 0.3 + irrFrac * 0.7;
    this.sunGlowMat.opacity = 0.05 + irrFrac * 0.25;
    this.sunLight.intensity = 0.4 + irrFrac * 0.8;

    // Pump state
    const pumpOn = result.actuators.pump;
    const pumpColor = pumpOn ? COLORS.pump_active : COLORS.pump_idle;
    this.pumpMat.color.copy(pumpColor);
    this.pumpRingMat.color.copy(pumpColor);
    this.pumpRingMat.emissive.copy(pumpColor);
    this.pumpRingMat.emissiveIntensity = pumpOn ? 0.6 : 0;
    if (pumpOn) {
      this.pumpRing.rotation.z += dt * 5;
    }

    // Fan
    const fanOn = result.actuators.fan;
    this.fanMat.color.copy(fanOn ? COLORS.fan_active : COLORS.fan_idle);
    if (fanOn) {
      this.fanBlades.rotation.z += dt * 15;
    }

    // Radiator glow
    const heating = result.mode === 'greenhouse_heating';
    this.radiatorMat.color.set(heating ? 0xef5350 : 0x777777);
    this.radiatorMat.emissive = new THREE.Color(heating ? 0xef5350 : 0x000000);
    this.radiatorMat.emissiveIntensity = heating ? 0.35 : 0;

    // Pipe visibility based on mode
    const mode = result.mode;
    this.pipeGroups.solar.visible = mode === 'solar_charging';
    this.pipeGroups.heating.visible = mode === 'greenhouse_heating';
    this.pipeGroups.drain.visible = mode === 'active_drain' || mode === 'overheat_drain';

    // Flow particles visibility
    this._solarParticles.visible = pumpOn && mode === 'solar_charging';
    this._heatParticles.visible = pumpOn && mode === 'greenhouse_heating';
    this._drainParticles.visible = pumpOn && (mode === 'active_drain' || mode === 'overheat_drain');

    // Pipe pulsing when active
    if (pumpOn) {
      const pulse = 0.6 + Math.sin(Date.now() * 0.004) * 0.4;
      const activeGroup = mode === 'solar_charging' ? this.pipeGroups.solar
        : mode === 'greenhouse_heating' ? this.pipeGroups.heating
        : this.pipeGroups.drain;
      if (activeGroup.visible) {
        activeGroup.traverse(child => {
          if (child.material) {
            child.material.emissiveIntensity = pulse * 0.3;
          }
        });
      }
    }

    // Update labels
    this._updateLabelText(this.labels.tankTop, state.t_tank_top.toFixed(1) + '\u00B0C', topColor.getStyle());
    this._updateLabelText(this.labels.tankBot, state.t_tank_bottom.toFixed(1) + '\u00B0C', botColor.getStyle());
    this._updateLabelText(this.labels.collector, state.t_collector.toFixed(1) + '\u00B0C', '#f9a825');
    this._updateLabelText(this.labels.greenhouse, state.t_greenhouse.toFixed(1) + '\u00B0C', '#76ff03');
    this._updateLabelText(this.labels.outdoor, 'Out: ' + state.t_outdoor.toFixed(1) + '\u00B0C', '#8b949e');
    this._updateLabelText(this.labels.pump, pumpOn ? 'PUMP ON' : 'PUMP OFF', pumpOn ? '#e040fb' : '#8b949e');
    this._updateLabelText(this.labels.irradiance, state.irradiance + ' W/m\u00B2', '#f9a825');
    this._updateLabelText(this.labels.fan, 'Fan: ' + (fanOn ? 'ON' : 'OFF'), fanOn ? '#76ff03' : '#8b949e');

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
    const dt = this.clock.getDelta();
    this._updateFlowParticles(dt);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    if (this.animationId) cancelAnimationFrame(this.animationId);
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
