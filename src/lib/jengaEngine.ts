import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export const BLOCK_SIZE = { w: 0.75, h: 0.24, d: 2.25 };
export const LAYERS = 18;
export const BLOCKS_PER_LAYER = 3;
export const TOTAL_BLOCKS = LAYERS * BLOCKS_PER_LAYER;

export interface BlockState {
  id: number;
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  v?: [number, number, number];
  a?: [number, number, number];
  pulled?: boolean;
}

export function generateInitialBlocks(): BlockState[] {
  const blocks: BlockState[] = [];
  let id = 0;
  for (let layer = 0; layer < LAYERS; layer++) {
    const y = BLOCK_SIZE.h / 2 + layer * BLOCK_SIZE.h;
    const horizontal = layer % 2 === 0;
    for (let i = 0; i < BLOCKS_PER_LAYER; i++) {
      const offset = (i - 1) * BLOCK_SIZE.w;
      const x = horizontal ? offset : 0;
      const z = horizontal ? 0 : offset;
      const rotY = horizontal ? 0 : Math.PI / 2;
      const quat = new CANNON.Quaternion();
      quat.setFromEuler(0, rotY, 0);
      blocks.push({
        id: id++,
        px: x,
        py: y,
        pz: z,
        qx: quat.x,
        qy: quat.y,
        qz: quat.z,
        qw: quat.w,
      });
    }
  }
  return blocks;
}

export class JengaWorld {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  world: CANNON.World;
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  blocksMesh: THREE.Mesh[] = [];
  blockBodies: CANNON.Body[] = [];
  blockMaterials: THREE.MeshStandardMaterial[] = [];

  selectedBlock: number | null = null;
  hoverBlock: number | null = null;
  isDragging = false;
  dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  dragOffset = new THREE.Vector3();
  dragStartPos = new CANNON.Vec3();

  onSelect?: (id: number | null) => void;
  onMove?: (blockId: number, state: BlockState) => void;
  onPull?: (blockId: number) => void;
  onCollapse?: () => void;

  private animationId = 0;
  private lastCollapseCheck = 0;
  private stableTimer = 0;

  constructor(canvas: HTMLCanvasElement) {
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1320);
    this.scene.fog = new THREE.Fog(0x0f1320, 18, 38);

    // Camera
    this.camera = new THREE.PerspectiveCamera(52, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
    this.camera.position.set(5.2, 3.8, 5.2);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;

    // Lights
    const hemi = new THREE.HemisphereLight(0xfff3e0, 0x22304a, 0.55);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.15);
    dir.position.set(6, 9, 4);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -5;
    dir.shadow.camera.right = 5;
    dir.shadow.camera.top = 5;
    dir.shadow.camera.bottom = -5;
    this.scene.add(dir);

    const rim = new THREE.DirectionalLight(0x8fb7ff, 0.32);
    rim.position.set(-4.5, 4, -5);
    this.scene.add(rim);

    // Floor
    const floorGeo = new THREE.CircleGeometry(10, 64);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x1c2538, roughness: 0.8, metalness: 0.04 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Wood table
    const tableGeo = new THREE.CylinderGeometry(3.3, 3.3, 0.16, 64);
    const tableMat = new THREE.MeshStandardMaterial({ color: 0x2d1d13, roughness: 0.72, metalness: 0.02 });
    const table = new THREE.Mesh(tableGeo, tableMat);
    table.position.y = -0.08;
    table.receiveShadow = true;
    table.castShadow = true;
    this.scene.add(table);

    // grid subtle
    const grid = new THREE.GridHelper(14, 28, 0x27344e, 0x1b2538);
    // @ts-ignore
    grid.material.opacity = 0.18;
    // @ts-ignore
    grid.material.transparent = true;
    grid.position.y = 0.001;
    this.scene.add(grid);

    // Physics
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    this.world.allowSleep = true;
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    // @ts-ignore
    this.world.solver.iterations = 20;
    this.world.defaultContactMaterial.friction = 0.65;
    this.world.defaultContactMaterial.restitution = 0.02;

    const groundMat = new CANNON.Material('ground');
    const blockPhysMat = new CANNON.Material('block');

    const floorBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Plane(),
      material: groundMat,
    });
    floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(floorBody);

    const tableBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Box(new CANNON.Vec3(3.3, 0.08, 3.3)),
      position: new CANNON.Vec3(0, -0.08, 0),
      material: groundMat,
    });
    this.world.addBody(tableBody);

    const contactMat = new CANNON.ContactMaterial(blockPhysMat, blockPhysMat, {
      friction: 0.52,
      restitution: 0.008,
    });
    this.world.addContactMaterial(contactMat);
    const contactMat2 = new CANNON.ContactMaterial(groundMat, blockPhysMat, {
      friction: 0.55,
      restitution: 0.01,
    });
    this.world.addContactMaterial(contactMat2);

    this.initBlocks(blockPhysMat);
    this.bindEvents();
    this.animate();
  }

  private initBlocks(blockPhysMat: CANNON.Material) {
    const initial = generateInitialBlocks();
    const woodPalettes = [
      [0xc9975b, 0xbe8550, 0xb07343],
      [0xd4a86a, 0xc99859, 0xba874b],
      [0xe6b87a, 0xcfa267, 0xb98b55],
    ];
    const { w, h, d } = BLOCK_SIZE;
    const geo = new THREE.BoxGeometry(w, h, d);
    
    // edge highlight geometry
    const edges = new THREE.EdgesGeometry(geo);

    initial.forEach((b, idx) => {
      const layer = Math.floor(idx / 3);
      const pal = woodPalettes[layer % woodPalettes.length];
      const tone = pal[idx % 3];
      const mat = new THREE.MeshStandardMaterial({
        color: tone,
        roughness: 0.63,
        metalness: 0.0,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.blockId = b.id;
      // outline
      const lineMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.11 });
      const edgeLines = new THREE.LineSegments(edges, lineMat);
      mesh.add(edgeLines);

      this.scene.add(mesh);
      this.blocksMesh[b.id] = mesh;
      this.blockMaterials[b.id] = mat;

      const shape = new CANNON.Box(new CANNON.Vec3(w/2, h/2, d/2));
      const body = new CANNON.Body({
        mass: 0.42,
        shape,
        material: blockPhysMat,
        position: new CANNON.Vec3(b.px, b.py, b.pz),
        quaternion: new CANNON.Quaternion(b.qx, b.qy, b.qz, b.qw),
        allowSleep: true,
        sleepSpeedLimit: 0.12,
        sleepTimeLimit: 0.8,
      });
      body.linearDamping = 0.12;
      body.angularDamping = 0.32;
      this.world.addBody(body);
      this.blockBodies[b.id] = body;
    });
    this.syncMeshes();
  }

  private bindEvents() {
    const c = this.renderer.domElement;
    c.addEventListener('mousemove', this.onMouseMove);
    c.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    c.addEventListener('touchstart', e => {
      if(e.touches[0]) {
        const t = e.touches[0];
        this.updateMouse(t.clientX, t.clientY);
        this.onMouseDown(e as any);
      }
    }, { passive: true });
    c.addEventListener('touchmove', e => {
      if(e.touches[0]) {
        const t = e.touches[0];
        this.updateMouse(t.clientX, t.clientY);
        this.handleDrag();
      }
    }, { passive: true });
    window.addEventListener('touchend', this.onMouseUp);
    c.addEventListener('contextmenu', e => e.preventDefault());

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    if(!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  private updateMouse(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  private onMouseMove = (e: MouseEvent) => {
    this.updateMouse(e.clientX, e.clientY);
    if (this.isDragging && this.selectedBlock !== null) {
      this.handleDrag();
      return;
    }
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.blocksMesh, false);
    const newHover = hits[0]?.object.userData.blockId ?? null;
    if(newHover !== this.hoverBlock) {
      if(this.hoverBlock !== null) this.setBlockEmissive(this.hoverBlock, 0x000000, 0);
      this.hoverBlock = newHover;
      if(this.hoverBlock !== null && this.hoverBlock !== this.selectedBlock) {
        this.setBlockEmissive(this.hoverBlock, 0xffd37a, 0.15);
      }
      const canvas = this.renderer.domElement;
      canvas.style.cursor = newHover !== null ? 'grab' : 'default';
    }
  };

  private onMouseDown = (e: MouseEvent | TouchEvent) => {
    // right click rotate camera orbit manually
    if((e as MouseEvent).button === 2) return;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.blocksMesh, false);
    if(hits.length > 0) {
      const id = hits[0].object.userData.blockId as number;
      this.selectBlock(id);
      this.isDragging = true;
      const body = this.blockBodies[id];
      this.dragStartPos.copy(body.position);

      const intersectPoint = hits[0].point;
      this.dragPlane.setFromNormalAndCoplanarPoint(
        this.camera.getWorldDirection(new THREE.Vector3()).negate(),
        new THREE.Vector3(body.position.x, body.position.y, body.position.z)
      );
      const dragIntersection = new THREE.Vector3();
      this.raycaster.ray.intersectPlane(this.dragPlane, dragIntersection);
      this.dragOffset.copy(dragIntersection).sub(intersectPoint);
      this.renderer.domElement.style.cursor = 'grabbing';
      e.preventDefault?.();
    } else {
      this.selectBlock(null);
    }
  };

  private onMouseUp = () => {
    if(this.isDragging && this.selectedBlock !== null) {
      // check if block moved significantly
      const body = this.blockBodies[this.selectedBlock];
      const moved = body.position.vsub(this.dragStartPos).length() > 0.18;
      if(moved && this.onPull) {
        this.onPull(this.selectedBlock);
      }
    }
    this.isDragging = false;
    this.renderer.domElement.style.cursor = this.hoverBlock !== null ? 'grab' : 'default';
  };

  private handleDrag() {
    if(this.selectedBlock === null) return;
    const body = this.blockBodies[this.selectedBlock];
    const intersection = new THREE.Vector3();
    this.raycaster.setFromCamera(this.mouse, this.camera);
    if(this.raycaster.ray.intersectPlane(this.dragPlane, intersection)) {
      intersection.sub(this.dragOffset);
      // constrain to mostly horizontal and limit distance
      const start = this.dragStartPos;
      const dx = intersection.x - start.x;
      const dz = intersection.z - start.z;
      const dist = Math.sqrt(dx*dx + dz*dz);
      const maxDist = 1.25;
      let tx = intersection.x;
      let tz = intersection.z;
      if(dist > maxDist) {
        const f = maxDist / dist;
        tx = start.x + dx * f;
        tz = start.z + dz * f;
      }
      // Smooth follow
      body.wakeUp();
      body.velocity.set((tx - body.position.x) * 12, body.velocity.y, (tz - body.position.z) * 12);
      body.angularVelocity.scale(0.85, body.angularVelocity);

      // broadcast move tick
      if(this.onMove) {
        this.onMove(this.selectedBlock, this.getBlockState(this.selectedBlock));
      }
    }
  }

  private setBlockEmissive(id: number, color: number, intensity: number) {
    const mat = this.blockMaterials[id];
    if(!mat) return;
    mat.emissive.setHex(color);
    mat.emissiveIntensity = intensity;
  }

  selectBlock(id: number | null) {
    if(this.selectedBlock !== null) {
      this.setBlockEmissive(this.selectedBlock, 0x000000, 0);
    }
    this.selectedBlock = id;
    if(id !== null) {
      this.setBlockEmissive(id, 0x6ee7ff, 0.27);
    }
    this.onSelect?.(id);
  }

  getBlockState(id: number): BlockState {
    const b = this.blockBodies[id];
    return {
      id,
      px: b.position.x,
      py: b.position.y,
      pz: b.position.z,
      qx: b.quaternion.x,
      qy: b.quaternion.y,
      qz: b.quaternion.z,
      qw: b.quaternion.w,
      v: [b.velocity.x, b.velocity.y, b.velocity.z],
      a: [b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z],
    };
  }

  applyBlockState(s: BlockState, forceTeleport = false) {
    const body = this.blockBodies[s.id];
    if(!body) return;
    // ignore if it's the locally dragged block
    if(this.isDragging && this.selectedBlock === s.id) return;
    body.wakeUp();
    if(forceTeleport) {
      body.position.set(s.px, s.py, s.pz);
      body.quaternion.set(s.qx, s.qy, s.qz, s.qw);
      body.velocity.set(0,0,0);
      body.angularVelocity.set(0,0,0);
    } else {
      // smooth lerp
      body.position.x += (s.px - body.position.x) * 0.45;
      body.position.y += (s.py - body.position.y) * 0.45;
      body.position.z += (s.pz - body.position.z) * 0.45;
      body.quaternion.slerp(new CANNON.Quaternion(s.qx, s.qy, s.qz, s.qw), 0.45, body.quaternion);
      if(s.v) body.velocity.set(s.v[0], s.v[1], s.v[2]);
      if(s.a) body.angularVelocity.set(s.a[0], s.a[1], s.a[2]);
    }
  }

  applyAllStates(states: BlockState[]) {
    states.forEach(s => this.applyBlockState(s, true));
  }

  nudgeBlock(id: number, dir: 'left'|'right'|'forward'|'back'|'tap') {
    const body = this.blockBodies[id];
    if(!body) return;
    body.wakeUp();
    const f = 2.1;
    if(dir === 'left') body.applyImpulse(new CANNON.Vec3(-f, 0, 0), body.position);
    if(dir === 'right') body.applyImpulse(new CANNON.Vec3(f, 0, 0), body.position);
    if(dir === 'forward') body.applyImpulse(new CANNON.Vec3(0,0,-f), body.position);
    if(dir === 'back') body.applyImpulse(new CANNON.Vec3(0,0,f), body.position);
    if(dir === 'tap') body.applyImpulse(new CANNON.Vec3((Math.random()-0.5)*0.8, 0, (Math.random()-0.5)*0.8), body.position);
    if(this.onMove) {
      setTimeout(()=> this.onMove?.(id, this.getBlockState(id)), 80);
    }
  }

  resetTower(states?: BlockState[]) {
    const src = states ?? generateInitialBlocks();
    src.forEach(s => {
      const body = this.blockBodies[s.id];
      body.position.set(s.px, s.py, s.pz);
      body.quaternion.set(s.qx, s.qy, s.qz, s.qw);
      body.velocity.setZero();
      body.angularVelocity.setZero();
      body.sleep();
    });
  }

  private syncMeshes() {
    for (let i=0; i<this.blockBodies.length; i++) {
      const body = this.blockBodies[i];
      const mesh = this.blocksMesh[i];
      if(!body || !mesh) continue;
      mesh.position.copy(body.position as any);
      mesh.quaternion.copy(body.quaternion as any);
    }
  }

  private checkCollapse() {
    // if more than 6 blocks have y < 0.3 (fallen off table) OR top 4 layers tilt > 30deg
    let fallen = 0;
    let tiltedTop = 0;
    for(let i = 0; i < this.blockBodies.length; i++) {
      const b = this.blockBodies[i];
      if(b.position.y < 0.15) fallen++;
      const layer = Math.floor(i/3);
      if(layer >= LAYERS - 4) {
        const up = new CANNON.Vec3(0,1,0);
        b.quaternion.vmult(up, up);
        const tilt = Math.acos(Math.min(1, Math.max(-1, up.y)));
        if(tilt > (Math.PI/180)*31) tiltedTop++;
      }
    }
    const isCollapsed = fallen >= 4 || tiltedTop >= 5;
    return isCollapsed;
  }

  private animate = () => {
    this.animationId = requestAnimationFrame(this.animate);
    this.world.step(1/60, 1/60, 3);
    this.syncMeshes();

    // camera gentle orbit
    const t = performance.now() * 0.00011;
    const radius = 5.7;
    if(!this.isDragging) {
      const cx = Math.sin(t) * radius;
      const cz = Math.cos(t) * radius;
      this.camera.position.x += (cx - this.camera.position.x) * 0.009;
      this.camera.position.z += (cz - this.camera.position.z) * 0.009;
    }
    this.camera.lookAt(0, LAYERS * BLOCK_SIZE.h * 0.42, 0);

    // collapse check every 0.45s
    const now = performance.now();
    if(now - this.lastCollapseCheck > 450) {
      this.lastCollapseCheck = now;
      const collapsed = this.checkCollapse();
      if(collapsed) {
        this.stableTimer++;
        if(this.stableTimer > 2 && this.onCollapse) {
          this.stableTimer = 0;
          this.onCollapse();
        }
      } else {
        this.stableTimer = 0;
      }
    }

    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this.animationId);
    this.renderer.dispose();
    const c = this.renderer.domElement;
    c.removeEventListener('mousemove', this.onMouseMove as any);
    c.removeEventListener('mousedown', this.onMouseDown as any);
  }
}
