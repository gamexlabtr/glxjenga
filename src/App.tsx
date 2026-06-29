import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

/* ---------------- Firebase – tam korumalı, offline-first ---------------- */
import { initializeApp, getApps } from 'firebase/app';
import { getDatabase, ref, onValue, set, update, push, remove, onDisconnect, get, Database } from 'firebase/database';

const firebaseConfig = {
  apiKey: "AIzaSyDoi750NzXB5KWXU8oDWr4scJZ0mf_2mWU",
  authDomain: "gmxlabtr.firebaseapp.com",
  databaseURL: "https://gmxlabtr-default-rtdb.firebaseio.com",
  projectId: "gmxlabtr",
  storageBucket: "gmxlabtr.firebasestorage.app",
  messagingSenderId: "779740910958",
  appId: "1:779740910958:web:45afeef855ec008a025d7f",
  measurementId: "G-SM7PRHBWQL"
};

let _db: Database | null = null;
function getDbSafe(): Database | null {
  if (_db) return _db;
  try {
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    _db = getDatabase(app);
    return _db;
  } catch (e) {
    console.warn('[JENGA] Firebase init blocked, offline fallback.', e);
    return null;
  }
}
async function fbSafe<T>(fn: () => any, fallback: T | null = null): Promise<T | null> {
  try { const r = fn(); return r && typeof r.then === 'function' ? await r : r; } catch (e) { console.warn('[JENGA] fb err', e); return fallback; }
}

/* ---------------- JENGA CORE ---------------- */
const BLOCK_SIZE = { w: 0.75, h: 0.24, d: 2.25 };
const LAYERS = 18;
const BLOCKS_PER_LAYER = 3;

type BlockState = {
  id: number;
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
  v?: [number,number,number];
  a?: [number,number,number];
};

function generateInitialBlocks(): BlockState[] {
  const blocks: BlockState[] = [];
  let id = 0;
  for (let layer = 0; layer < LAYERS; layer++) {
    const y = BLOCK_SIZE.h/2 + layer*BLOCK_SIZE.h;
    const horizontal = layer % 2 === 0;
    for (let i=0;i<BLOCKS_PER_LAYER;i++){
      const offset = (i-1)*BLOCK_SIZE.w;
      const x = horizontal ? offset : 0;
      const z = horizontal ? 0 : offset;
      const rotY = horizontal ? 0 : Math.PI/2;
      const quat = new CANNON.Quaternion();
      quat.setFromEuler(0, rotY, 0);
      blocks.push({ id: id++, px:x, py:y, pz:z, qx:quat.x, qy:quat.y, qz:quat.z, qw:quat.w });
    }
  }
  return blocks;
}

/* ---------------- WebAudio – dosyasız ---------------- */
let audioCtx: AudioContext | null = null;
function ac(): AudioContext | null {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
    return audioCtx;
  } catch { return null; }
}
function playScrape(dur=0.58){
  const ctx = ac(); if(!ctx) return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const filt = ctx.createBiquadFilter(); filt.type='bandpass'; filt.frequency.value=710; filt.Q.value=6.8;
  const gain = ctx.createGain();
  osc.type='sawtooth';
  osc.frequency.setValueAtTime(184, t0);
  osc.frequency.linearRampToValueAtTime(248, t0+dur*0.55);
  osc.frequency.linearRampToValueAtTime(168, t0+dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(0.18, t0+0.03);
  gain.gain.exponentialRampToValueAtTime(0.001, t0+dur);
  osc.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
  osc.start(t0); osc.stop(t0+dur+0.02);
}
function playThud(vol=0.5){
  const ctx = ac(); if(!ctx) return;
  const t0 = ctx.currentTime;
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.type='sine'; o.frequency.setValueAtTime(116, t0); o.frequency.exponentialRampToValueAtTime(66, t0+0.15);
  g.gain.setValueAtTime(vol*0.5, t0); g.gain.exponentialRampToValueAtTime(0.001, t0+0.19);
  o.connect(g); g.connect(ctx.destination); o.start(t0); o.stop(t0+0.22);
}
function playCrash(){
  const ctx = ac(); if(!ctx) return;
  const t0 = ctx.currentTime;
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.type='sawtooth'; o.frequency.setValueAtTime(72, t0); o.frequency.exponentialRampToValueAtTime(30, t0+1.12);
  g.gain.setValueAtTime(0.36, t0); g.gain.exponentialRampToValueAtTime(0.001, t0+1.3);
  o.connect(g); g.connect(ctx.destination); o.start(t0); o.stop(t0+1.4);
  const dur=1.18, buffer=ctx.createBuffer(1, ctx.sampleRate*dur, ctx.sampleRate);
  const d = buffer.getChannelData(0);
  for(let i=0;i<d.length;i++){ const tt=i/ctx.sampleRate; d[i]=(Math.random()*2-1)*Math.exp(-tt*1.9)*(0.72+0.28*Math.sin(tt*52)); }
  const src = ctx.createBufferSource(); src.buffer = buffer;
  const flt = ctx.createBiquadFilter(); flt.type='lowpass'; flt.frequency.value=1580;
  const gg = ctx.createGain(); gg.gain.value=0.44;
  src.connect(flt); flt.connect(gg); gg.connect(ctx.destination); src.start(t0);
}

/* ---------------- 3D Engine ---------------- */
class JengaWorld {
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
  dragPlane = new THREE.Plane(new THREE.Vector3(0,1,0),0);
  dragOffset = new THREE.Vector3();
  dragStartPos = new CANNON.Vec3();

  // orbit
  isOrbiting = false;
  orbitStartX = 0; orbitStartY = 0;
  orbitTheta0 = 0.82; orbitPhi0 = 1.06;
  camTheta = 0.82; camPhi = 1.06; camRadius = 5.9;
  camTarget = new THREE.Vector3(0,1.95,0);

  // callbacks
  onSelect?: (id:number|null)=>void;
  onMove?: (id:number, st:BlockState)=>void;
  onPull?: (id:number)=>void;
  onCollapse?: ()=>void;
  canInteractRef = { current: true };

  private animId = 0;
  private lastCollapseCheck = 0;
  private stableTimer = 0;
  private resizeObs?: ResizeObserver;

  constructor(canvas: HTMLCanvasElement){
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0c111a);
    this.scene.fog = new THREE.Fog(0x0c111a, 15, 33);

    this.camera = new THREE.PerspectiveCamera(54, 1, 0.1, 100);
    this.updateCamera();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.09;

    // lights
    this.scene.add(new THREE.HemisphereLight(0xfff0d6, 0x1a2539, 0.59));
    const dir = new THREE.DirectionalLight(0xffffff, 1.16);
    dir.position.set(6.5, 9, 4.3);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048,2048);
    // @ts-ignore
    dir.shadow.camera.left = -5.4; dir.shadow.camera.right = 5.4; dir.shadow.camera.top = 5.4; dir.shadow.camera.bottom = -5.4;
    this.scene.add(dir);

    // floor/table
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(12, 72),
      new THREE.MeshStandardMaterial({ color:0x192134, roughness:0.86, metalness:0.03 })
    );
    floor.rotation.x = -Math.PI/2; floor.receiveShadow = true;
    this.scene.add(floor);
    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(3.4,3.4,0.15,72),
      new THREE.MeshStandardMaterial({ color:0x2a1a10, roughness:0.72, metalness:0.02 })
    );
    table.position.y = -0.075; table.receiveShadow = true; table.castShadow = true;
    this.scene.add(table);

    // physics
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0,-9.82,0) });
    this.world.allowSleep = true;
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    // @ts-ignore
    this.world.solver.iterations = 22;
    this.world.defaultContactMaterial.friction = 0.63;
    this.world.defaultContactMaterial.restitution = 0.015;

    const groundMat = new CANNON.Material('ground');
    const blockMat = new CANNON.Material('block');

    const planeBody = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane(), material: groundMat });
    planeBody.quaternion.setFromEuler(-Math.PI/2,0,0);
    this.world.addBody(planeBody);

    const tableBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Box(new CANNON.Vec3(3.4,0.075,3.4)),
      position: new CANNON.Vec3(0,-0.075,0),
      material: groundMat
    });
    this.world.addBody(tableBody);

    this.world.addContactMaterial(new CANNON.ContactMaterial(blockMat, blockMat, { friction:0.51, restitution:0.008 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(groundMat, blockMat, { friction:0.58, restitution:0.012 }));

    this.initBlocks(blockMat);
    this.bindEvents();
    this.setupResize();
    this.animate();
  }

  private initBlocks(blockMat: CANNON.Material){
    const initial = generateInitialBlocks();
    const palettes = [
      [0xc9975b,0xbe8550,0xb07343],
      [0xd4a86a,0xc99859,0xba874b],
      [0xe6b87a,0xcfa267,0xb98b55],
    ];
    const { w,h,d } = BLOCK_SIZE;
    const geo = new THREE.BoxGeometry(w,h,d);
    const edges = new THREE.EdgesGeometry(geo);

    initial.forEach((b, idx)=>{
      const layer = Math.floor(idx/3);
      const pal = palettes[layer % palettes.length];
      const tone = pal[idx%3];
      const mat = new THREE.MeshStandardMaterial({ color: tone, roughness:0.61, metalness:0.012 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.blockId = b.id;
      mesh.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color:0x000000, transparent:true, opacity:0.095 })));
      this.scene.add(mesh);
      this.blocksMesh[b.id] = mesh;
      this.blockMaterials[b.id] = mat;

      const shape = new CANNON.Box(new CANNON.Vec3(w/2,h/2,d/2));
      const body = new CANNON.Body({
        mass:0.42, shape, material:blockMat,
        position: new CANNON.Vec3(b.px,b.py,b.pz),
        quaternion: new CANNON.Quaternion(b.qx,b.qy,b.qz,b.qw),
        allowSleep:true, sleepSpeedLimit:0.11, sleepTimeLimit:0.9
      });
      body.linearDamping = 0.13; body.angularDamping = 0.33;
      this.world.addBody(body);
      this.blockBodies[b.id] = body;
    });
    this.syncMeshes();
  }

  private bindEvents(){
    const c = this.renderer.domElement;
    const getPoint = (e: MouseEvent | Touch) => ({ x: e.clientX, y: e.clientY });

    const onMove = (clientX:number, clientY:number)=>{
      const rect = c.getBoundingClientRect();
      this.mouse.x = ((clientX-rect.left)/rect.width)*2-1;
      this.mouse.y = -((clientY-rect.top)/rect.height)*2+1;
      if(this.isDragging && this.selectedBlock!==null){ this.handleDrag(); return; }
      if(this.isOrbiting){ this.handleOrbit(clientX, clientY); return; }
      // hover
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const hits = this.raycaster.intersectObjects(this.blocksMesh,false);
      const nh = hits[0]?.object.userData.blockId ?? null;
      if(nh !== this.hoverBlock){
        if(this.hoverBlock!==null) this.setEmissive(this.hoverBlock,0x000000,0);
        this.hoverBlock = nh;
        if(this.hoverBlock!==null && this.hoverBlock!==this.selectedBlock) this.setEmissive(this.hoverBlock,0xffd37a,0.15);
        c.style.cursor = nh!==null ? 'grab' : 'grab';
      }
    };

    c.addEventListener('mousemove', e=> onMove(e.clientX,e.clientY));
    c.addEventListener('mousedown', e=>{
      const pt = getPoint(e);
      onMove(pt.x, pt.y);
      // try block pick
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const hits = this.raycaster.intersectObjects(this.blocksMesh,false);
      if(hits.length && this.canInteractRef.current){
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
        c.style.cursor='grabbing';
        playScrape(0.45);
        e.preventDefault();
        return;
      }
      // orbit start
      this.isOrbiting = true;
      this.orbitStartX = e.clientX;
      this.orbitStartY = e.clientY;
      this.orbitTheta0 = this.camTheta;
      this.orbitPhi0 = this.camPhi;
      c.style.cursor='grabbing';
    });
    window.addEventListener('mouseup', ()=>{
      if(this.isDragging && this.selectedBlock!==null){
        const body = this.blockBodies[this.selectedBlock];
        const moved = body.position.vsub(this.dragStartPos).length() > 0.18;
        if(moved && this.onPull) this.onPull(this.selectedBlock);
      }
      this.isDragging = false;
      this.isOrbiting = false;
      c.style.cursor = this.hoverBlock!==null ? 'grab' : 'grab';
    });
    c.addEventListener('wheel', e=>{
      e.preventDefault();
      this.camRadius = Math.max(3.3, Math.min(9.4, this.camRadius + e.deltaY*0.0023));
      this.updateCamera();
    }, { passive:false });

    // touch
    c.addEventListener('touchstart', e=>{
      if(e.touches[0]){
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
        // simulate mousedown
        const me = { clientX:t.clientX, clientY:t.clientY, preventDefault:()=>{} } as unknown as MouseEvent;
        c.dispatchEvent(new MouseEvent('mousedown', me));
      }
    }, { passive:true });
    c.addEventListener('touchmove', e=>{
      if(e.touches[0]) onMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive:true });
    c.addEventListener('touchend', ()=> window.dispatchEvent(new Event('mouseup')));
    c.addEventListener('contextmenu', e=> e.preventDefault());
  }

  private handleOrbit(clientX:number, clientY:number){
    const dx = clientX - this.orbitStartX;
    const dy = clientY - this.orbitStartY;
    this.camTheta = this.orbitTheta0 - dx * 0.0048;
    this.camPhi = Math.max(0.38, Math.min(1.54, this.orbitPhi0 + dy * 0.0033));
    this.updateCamera();
  }

  private handleDrag(){
    if(this.selectedBlock===null) return;
    const body = this.blockBodies[this.selectedBlock];
    const intersection = new THREE.Vector3();
    this.raycaster.setFromCamera(this.mouse, this.camera);
    if(this.raycaster.ray.intersectPlane(this.dragPlane, intersection)){
      intersection.sub(this.dragOffset);
      const start = this.dragStartPos;
      const dx = intersection.x - start.x;
      const dz = intersection.z - start.z;
      const dist = Math.sqrt(dx*dx+dz*dz);
      const maxDist = 1.3;
      let tx = intersection.x, tz = intersection.z;
      if(dist > maxDist){ const f = maxDist/dist; tx = start.x + dx*f; tz = start.z + dz*f; }
      body.wakeUp();
      body.velocity.set((tx - body.position.x)*13, body.velocity.y, (tz - body.position.z)*13);
      body.angularVelocity.scale(0.88, body.angularVelocity);
      if(this.onMove) this.onMove(this.selectedBlock, this.getBlockState(this.selectedBlock));
    }
  }

  private setEmissive(id:number, color:number, intensity:number){
    const m = this.blockMaterials[id]; if(!m) return;
    m.emissive.setHex(color); m.emissiveIntensity = intensity;
  }
  selectBlock(id:number|null){
    if(this.selectedBlock!==null) this.setEmissive(this.selectedBlock,0x000000,0);
    this.selectedBlock = id;
    if(id!==null) this.setEmissive(id,0x6ee7ff,0.27);
    this.onSelect?.(id);
  }
  getBlockState(id:number): BlockState {
    const b = this.blockBodies[id];
    return { id,
      px:b.position.x, py:b.position.y, pz:b.position.z,
      qx:b.quaternion.x, qy:b.quaternion.y, qz:b.quaternion.z, qw:b.quaternion.w,
      v:[b.velocity.x,b.velocity.y,b.velocity.z],
      a:[b.angularVelocity.x,b.angularVelocity.y,b.angularVelocity.z]
    };
  }
  applyBlockState(s:BlockState, force=false){
    const body = this.blockBodies[s.id]; if(!body) return;
    if(this.isDragging && this.selectedBlock===s.id) return;
    body.wakeUp();
    if(force){
      body.position.set(s.px,s.py,s.pz);
      body.quaternion.set(s.qx,s.qy,s.qz,s.qw);
      body.velocity.set(0,0,0); body.angularVelocity.set(0,0,0);
    } else {
      body.position.x += (s.px - body.position.x)*0.46;
      body.position.y += (s.py - body.position.y)*0.46;
      body.position.z += (s.pz - body.position.z)*0.46;
      body.quaternion.slerp(new CANNON.Quaternion(s.qx,s.qy,s.qz,s.qw),0.46,body.quaternion);
    }
  }
  nudgeBlock(id:number, dir:'left'|'right'|'forward'|'back'|'tap'){
    const body = this.blockBodies[id]; if(!body) return;
    body.wakeUp(); const f=2.18;
    if(dir==='left') body.applyImpulse(new CANNON.Vec3(-f,0,0), body.position);
    if(dir==='right') body.applyImpulse(new CANNON.Vec3(f,0,0), body.position);
    if(dir==='forward') body.applyImpulse(new CANNON.Vec3(0,0,-f), body.position);
    if(dir==='back') body.applyImpulse(new CANNON.Vec3(0,0,f), body.position);
    if(dir==='tap') body.applyImpulse(new CANNON.Vec3((Math.random()-0.5)*0.95,0,(Math.random()-0.5)*0.95), body.position);
    playScrape(0.29);
    if(this.onMove) setTimeout(()=> this.onMove?.(id, this.getBlockState(id)), 70);
  }
  resetTower(states?:BlockState[]){
    const src = states ?? generateInitialBlocks();
    src.forEach(s=>{
      const b = this.blockBodies[s.id]; if(!b) return;
      b.position.set(s.px,s.py,s.pz);
      b.quaternion.set(s.qx,s.qy,s.qz,s.qw);
      b.velocity.setZero(); b.angularVelocity.setZero(); b.sleep();
    });
  }
  private syncMeshes(){
    for(let i=0;i<this.blockBodies.length;i++){
      const b=this.blockBodies[i]; const m=this.blocksMesh[i];
      if(!b||!m) continue;
      m.position.copy(b.position as any);
      m.quaternion.copy(b.quaternion as any);
    }
  }
  private checkCollapse(){
    let fallen=0, tilted=0;
    for(let i=0;i<this.blockBodies.length;i++){
      const b=this.blockBodies[i];
      if(b.position.y < 0.16) fallen++;
      const layer = Math.floor(i/3);
      if(layer >= LAYERS-4){
        const up = new CANNON.Vec3(0,1,0); b.quaternion.vmult(up,up);
        const tilt = Math.acos(Math.min(1,Math.max(-1,up.y)));
        if(tilt > Math.PI/180*31) tilted++;
      }
    }
    return fallen >=4 || tilted >=5;
  }
  private updateCamera(){
    const r=this.camRadius, theta=this.camTheta, phi=this.camPhi;
    const x = r * Math.sin(phi) * Math.sin(theta);
    const y = this.camTarget.y + r * Math.cos(phi) * 0.56;
    const z = r * Math.sin(phi) * Math.cos(theta);
    this.camera.position.set(this.camTarget.x + x, y, this.camTarget.z + z);
    this.camera.lookAt(this.camTarget);
  }
  private setupResize(){
    const canvas = this.renderer.domElement;
    const doResize = ()=>{
      const parent = canvas.parentElement;
      if(!parent) return;
      const w = parent.clientWidth || 640;
      const h = parent.clientHeight || 480;
      this.camera.aspect = w/h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
    };
    doResize();
    // ResizeObserver (TV / tablet rotation safe)
    try{
      this.resizeObs = new ResizeObserver(doResize);
      if(canvas.parentElement) this.resizeObs.observe(canvas.parentElement);
    }catch{}
    window.addEventListener('resize', doResize);
  }
  private animate = ()=>{
    this.animId = requestAnimationFrame(this.animate);
    this.world.step(1/60, 1/60, 3);
    this.syncMeshes();
    if(!this.isOrbiting && !this.isDragging){
      this.camTheta += 0.00135;
      this.updateCamera();
    }
    const now = performance.now();
    if(now - this.lastCollapseCheck > 440){
      this.lastCollapseCheck = now;
      if(this.checkCollapse()){
        this.stableTimer++;
        if(this.stableTimer > 2 && this.onCollapse){ this.stableTimer=0; this.onCollapse(); }
      } else this.stableTimer = 0;
    }
    this.renderer.render(this.scene, this.camera);
  };
  dispose(){
    cancelAnimationFrame(this.animId);
    try{ this.resizeObs?.disconnect(); }catch{}
    this.renderer.dispose();
  }
}

/* ---------------- HELPERS ---------------- */
type Player = { id:string; name:string; color:string; score?:number; joinedAt?:number };
type RoomData = { createdAt:number; hostId:string; status:'waiting'|'playing'|'collapsed'; turnIndex:number; turnPlayerId?:string; moveCount:number; winnerId?:string; };
const PLAYER_COLORS = ['#ff9b54','#58c5ff','#7ae27a','#ff6b9a','#ffe166','#a78bfa','#ff8155','#4ad6b6'];
function pid(): string {
  let p = localStorage.getItem('jenga_pid');
  if(!p){ p='p_'+Math.random().toString(36).slice(2,9); localStorage.setItem('jenga_pid', p); }
  return p;
}
function roomCode(){ const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<5;i++) s+=c[Math.floor(Math.random()*c.length)]; return s; }
function lerpAnim(updater:(t:number)=>void, ms:number){ return new Promise<void>(res=>{ const st=performance.now(); const tick=(now:number)=>{ const t=Math.min(1,(now-st)/ms); updater(t); if(t<1) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); }); }
function ease(t:number){ return t<0.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2; }

/* ============================================================
   GAME VIEW – isolated component, mounts world ONCE
   ============================================================ */
function GameView(props:{
  mode:'offline'|'online';
  playerName:string;
  playerId:string;
  roomId:string|null;
  onExit:()=>void;
  toast:(m:string)=>void;
}){
  const { mode, playerName, playerId, roomId, onExit, toast } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<JengaWorld|null>(null);

  // offline state
  const [offlinePlayers] = useState<Player[]>([
    { id:'human', name: playerName || 'Sen', color:'#ff9b54' },
    { id:'bot', name:'JengaBot TR', color:'#58c5ff' },
  ]);
  const [offlineTurn, setOfflineTurn] = useState(0);
  const [offlineMoves, setOfflineMoves] = useState(0);
  const [offlineStatus, setOfflineStatus] = useState<'playing'|'collapsed'>('playing');
  const [botThinking, setBotThinking] = useState(false);
  const offlineMovesRef = useRef(0);
  useEffect(()=>{ offlineMovesRef.current = offlineMoves; }, [offlineMoves]);

  // online state
  const [players, setPlayers] = useState<Player[]>([]);
  const [room, setRoom] = useState<RoomData|null>(null);
  const [chat, setChat] = useState<{id:string; name:string; text:string; pid:string}[]>([]);
  const [chatInput, setChatInput] = useState('');

  // shared
  const [selectedBlock, setSelectedBlock] = useState<number|null>(null);
  const [log, setLog] = useState<string[]>( mode==='offline' ? ['Çevrimdışı mod hazır. Sıra sende!'] : [] );
  const [shake, setShake] = useState(false);

  const isOffline = mode==='offline';
  const effectivePlayers = isOffline ? offlinePlayers : players;
  const turnPlayerId = isOffline ? effectivePlayers[offlineTurn]?.id : room?.turnPlayerId;
  const isMyTurn = isOffline ? turnPlayerId==='human' : turnPlayerId===playerId;
  const status = isOffline ? offlineStatus : (room?.status ?? 'waiting');
  const moveCount = isOffline ? offlineMoves : (room?.moveCount ?? 0);
  const turnPlayer = effectivePlayers.find(p=>p.id===turnPlayerId);

  // canInteract ref – prevents stale closure re-mounts
  const canInteractRef = useRef(true);
  useEffect(()=>{ canInteractRef.current = isOffline ? (turnPlayerId==='human' && offlineStatus==='playing') : (!!isMyTurn && status==='playing'); }, [isMyTurn, turnPlayerId, offlineStatus, isOffline, status]);

  // mount world ONCE
  useEffect(()=>{
    if(!canvasRef.current) return;
    // unlock audio on first user gesture (canvas already after click)
    try{ ac()?.resume(); }catch{}
    const w = new JengaWorld(canvasRef.current);
    worldRef.current = w;
    w.canInteractRef = canInteractRef;
    w.onSelect = (id)=> setSelectedBlock(id);
    w.onMove = (blockId, st)=>{
      if(isOffline) return;
      if(!roomId || !isMyTurn) return;
      const db = getDbSafe(); if(!db) return;
      fbSafe(()=> update(ref(db, `rooms/${roomId}/blocks/${blockId}`), st as any));
    };
    w.onPull = (blockId)=>{
      playThud(0.56);
      if(isOffline){
        setOfflineMoves(m=>m+1);
        setOfflineTurn(t=> (t+1) % effectivePlayers.length);
        setLog(l=> [...l.slice(-15), `Sen #${blockId} bloğunu çektin.`]);
        toast(`Blok ${blockId} ✓`);
        return;
      }
      // online
      if(!room || !roomId) return;
      const db = getDbSafe(); if(!db) return;
      const idx = players.findIndex(p=>p.id===room.turnPlayerId);
      const nextIdx = ((idx>=0?idx:room.turnIndex)+1) % Math.max(1, players.length);
      const nextPid = players[nextIdx]?.id ?? playerId;
      fbSafe(()=> update(ref(db, `rooms/${roomId}`), {
        turnIndex: nextIdx, turnPlayerId: nextPid, moveCount: (room.moveCount||0)+1, lastMoveAt: Date.now()
      }));
      fbSafe(()=> push(ref(db, `rooms/${roomId}/log`), { text: `${playerName} #${blockId} çekti`, ts: Date.now() }));
      toast(`Blok ${blockId} çekildi`);
    };
    w.onCollapse = ()=>{
      playCrash();
      setShake(true); setTimeout(()=>setShake(false), 680);
      if(isOffline){
        setOfflineStatus('collapsed');
        setLog(l=> [...l, '💥 Kule çöktü!']);
      } else if(roomId){
        const db = getDbSafe(); if(db) fbSafe(()=> update(ref(db, `rooms/${roomId}`), { status:'collapsed' }));
      }
    };
    return ()=> w.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ONCE

  // online listeners
  useEffect(()=>{
    if(!isOffline && roomId){
      const db = getDbSafe(); if(!db) return;
      const unsub = onValue(ref(db, `rooms/${roomId}`), snap=>{
        const v = snap.val(); if(!v){ setRoom(null); setPlayers([]); return; }
        const { players:pObj, blocks, log: _lg, chat: _ch, ...rest } = v;
        setRoom(rest as RoomData);
        if(pObj){
          const plist:Player[] = Object.entries(pObj).map(([id, x]:any)=>({ id, ...x }));
          plist.sort((a,b)=>(a.joinedAt||0)-(b.joinedAt||0));
          setPlayers(plist);
        }
        if(blocks && worldRef.current){
          Object.values(blocks as Record<string,BlockState>).forEach(b=> worldRef.current?.applyBlockState(b,false));
        }
      });
      const unsubChat = onValue(ref(db, `rooms/${roomId}/chat`), s=>{
        const v = s.val()||{};
        const list = Object.entries(v).map(([id,x]:any)=>({ id, ...x }));
        list.sort((a:any,b:any)=>a.ts-b.ts);
        setChat(list.slice(-50));
      });
      const unsubLog = onValue(ref(db, `rooms/${roomId}/log`), s=>{
        const v = s.val()||{};
        const lines = Object.values(v as any).sort((a:any,b:any)=>a.ts-b.ts).map((x:any)=>x.text);
        setLog(lines.slice(-18));
      });
      return ()=>{ unsub(); unsubChat(); unsubLog(); };
    }
  }, [isOffline, roomId]);

  // bot turn
  const botMove = useCallback(async ()=>{
    const world = worldRef.current; if(!world) return;
    setBotThinking(true);
    const bodies = world.blockBodies;
    const candidates:number[]=[];
    for(let i=0;i<bodies.length;i++){
      const b=bodies[i]; const y=b.position.y;
      if(y < 0.45 || y > 3.35) continue;
      const up = new CANNON.Vec3(0,1,0); b.quaternion.vmult(up,up);
      if(up.y < 0.84) continue;
      if(Math.abs(b.position.x) > 1.35 || Math.abs(b.position.z) > 1.35) continue;
      candidates.push(i);
    }
    const pick = candidates.length ? candidates[Math.floor(Math.random()*candidates.length)] : Math.floor(Math.random()*30);
    world.selectBlock(pick);
    playScrape(0.7);
    const body = bodies[pick]; if(!body){ setBotThinking(false); return; }
    const layer = Math.floor(pick/3);
    const horizontal = layer % 2 === 0;
    const pullAxis = horizontal ? 'z':'x';
    const pullDir = Math.random()>0.5?1:-1;
    const startPos = body.position.clone();
    body.wakeUp();
    body.type = CANNON.Body.KINEMATIC; body.velocity.setZero(); body.angularVelocity.setZero();
    await lerpAnim(t=>{
      const e=ease(t); const out = e*1.08*pullDir;
      if(pullAxis==='x') body.position.set(startPos.x+out, startPos.y, startPos.z);
      else body.position.set(startPos.x, startPos.y, startPos.z+out);
    }, 820);
    // find top
    let topY=0; bodies.forEach(bb=>{ if(Math.abs(bb.position.x)<1.7 && Math.abs(bb.position.z)<1.7 && bb.position.y>topY) topY=bb.position.y; });
    const placeY = topY + BLOCK_SIZE.h*1.015;
    const midPos = body.position.clone();
    await lerpAnim(t=>{ const e=ease(t); body.position.y = midPos.y + (placeY-midPos.y)*e; }, 500);
    const placed = offlineMovesRef.current;
    const nextLayer = LAYERS + Math.floor(placed/3);
    const topH = nextLayer %2===0;
    const slot = placed %3;
    const targetX = topH ? (slot-1)*BLOCK_SIZE.w : 0;
    const targetZ = topH ? 0 : (slot-1)*BLOCK_SIZE.w;
    const targetQuat = new CANNON.Quaternion(); targetQuat.setFromEuler(0, topH?0:Math.PI/2, 0);
    const pre = body.position.clone();
    await lerpAnim(t=>{ const e=ease(t);
      body.position.x = pre.x + (targetX-pre.x)*e;
      body.position.z = pre.z + (targetZ-pre.z)*e;
      const qs = body.quaternion.clone(); qs.slerp(targetQuat, e, body.quaternion);
    }, 560);
    body.type = CANNON.Body.DYNAMIC; body.mass=0.42; body.updateMassProperties(); body.wakeUp(); body.velocity.set(0,-0.32,0);
    playThud(0.5);
    await new Promise(r=>setTimeout(r, 760));
    setBotThinking(false);
    setOfflineMoves(m=>m+1);
    setOfflineTurn(ti=> (ti+1) % effectivePlayers.length);
    setLog(l=> [...l.slice(-16), `JengaBot #${pick} bloğunu üste koydu.`]);
    world.selectBlock(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePlayers.length]);

  useEffect(()=>{
    if(isOffline && offlineStatus==='playing' && turnPlayerId==='bot' && !botThinking){
      const tm = setTimeout(()=> botMove(), 1850 + Math.random()*950);
      return ()=> clearTimeout(tm);
    }
  }, [isOffline, offlineStatus, turnPlayerId, botThinking, botMove]);

  const nudge = (dir:'left'|'right'|'forward'|'back'|'tap')=>{
    if(selectedBlock===null) return;
    if(!canInteractRef.current) return;
    worldRef.current?.nudgeBlock(selectedBlock, dir);
  };
  const resetTower = ()=>{
    worldRef.current?.resetTower();
    if(isOffline){
      setOfflineStatus('playing'); setOfflineTurn(0); setOfflineMoves(0);
      setLog(['Kule sıfırlandı.']);
      playThud(0.33);
    } else if(roomId){
      const db = getDbSafe(); if(!db) return;
      const initial = generateInitialBlocks();
      const blocksObj: Record<string,BlockState> = {}; initial.forEach(b=> blocksObj[b.id]=b);
      fbSafe(()=> update(ref(db, `rooms/${roomId}`), { status:'playing', moveCount:0, turnIndex:0, turnPlayerId: players[0]?.id ?? playerId, blocks: blocksObj }));
    }
  };
  const sendChat = ()=>{
    if(!chatInput.trim() || !roomId || isOffline) return;
    const db = getDbSafe(); if(!db) return;
    fbSafe(()=> push(ref(db, `rooms/${roomId}/chat`), { pid: playerId, name: playerName, text: chatInput.trim().slice(0,180), ts: Date.now() }));
    setChatInput('');
  };

  const isHost = isOffline ? true : room?.hostId === playerId;

  return (
    <div className="h-[100dvh] bg-[#090d15] text-zinc-100 flex flex-col overflow-hidden touch-manipulation">
      {/* top bar */}
      <header className="h-[56px] sm:h-[60px] border-b border-white/[0.08] bg-[#0f1626]/92 backdrop-blur flex items-center px-3 sm:px-4 md:px-5 gap-2 sm:gap-4 text-[13px] sm:text-[14px] shrink-0">
        <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
          <div className="w-[32px] h-[32px] sm:w-[36px] sm:h-[36px] rounded-[10px] sm:rounded-[12px] bg-gradient-to-br from-amber-400 to-orange-500 text-[#1c0f03] font-black flex items-center justify-center text-[14px] sm:text-[15px] shrink-0">J</div>
          <div className="hidden sm:block min-w-0">
            <div className="font-[760] tracking-tight leading-tight">JENGA 3D</div>
            <div className="text-[10.5px] text-zinc-400 -mt-0.5 truncate">{isOffline ? 'Offline • Bot • WebAudio' : 'Multiplayer • Firebase'}</div>
          </div>
        </div>
        <div className="hidden md:block h-6 w-px bg-white/[0.09]" />
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          {isOffline ? (
            <span className="px-2 sm:px-2.5 py-1 bg-emerald-400/15 border border-emerald-400/30 rounded-lg text-emerald-200 text-[11px] sm:text-[12px] font-[650] whitespace-nowrap">BOT MODU</span>
          ) : (
            <>
              <span className="text-zinc-400 text-[11px] sm:text-[12px] hidden sm:inline">Oda</span>
              <span className="px-2 py-1 bg-white/[0.065] border border-white/[0.1] rounded-lg tracking-wider font-[700] text-[12px] sm:text-[13px]">{roomId}</span>
            </>
          )}
        </div>
        <div className="flex-1" />
        <div className="hidden lg:flex items-center gap-3 text-[11.5px] text-zinc-400">
          <span>{effectivePlayers.length} oyuncu</span><span>•</span><span>Hamle {moveCount}</span>
        </div>
        <button onClick={onExit}
          className="text-[11px] sm:text-[12px] px-2.5 sm:px-3 py-[7px] sm:py-[8px] rounded-lg bg-white/[0.055] hover:bg-white/[0.1] active:scale-[0.97] transition border border-white/[0.08] focus:outline-none focus:ring-2 focus:ring-amber-400/60">
          Çık
        </button>
      </header>

      {/* main */}
      <div className="flex-1 min-h-0 grid grid-rows-[1fr_auto] lg:grid-rows-1 lg:grid-cols-[1fr_380px] xl:grid-cols-[1fr_410px]">
        {/* canvas area */}
        <div className="relative bg-[#0a0f19] overflow-hidden min-h-0">
          {/* fixed height on phones, flex full on desktop */}
          <div className="absolute inset-0">
            <canvas ref={canvasRef} className={`w-full h-full block touch-none select-none ${shake ? 'animate-pulse' : ''}`} />
          </div>

          {/* top HUD */}
          <div className="absolute top-2 sm:top-3 left-2 sm:left-3 right-2 sm:right-3 flex flex-wrap gap-[6px] sm:gap-2 text-[11px] sm:text-[12px] pointer-events-none">
            <div className="px-2.5 sm:px-3 py-[6px] sm:py-[7px] rounded-full bg-[#101826]/85 border border-white/[0.11] backdrop-blur pointer-events-auto">
              <span className="text-zinc-300">Durum:</span>{' '}
              <b className={status==='playing' ? 'text-emerald-300' : status==='collapsed' ? 'text-rose-300' : 'text-amber-300'}>
                {status==='waiting' ? 'Bekliyor' : status==='playing' ? 'Oynanıyor' : 'Çöktü'}
              </b>
            </div>
            <div className={`px-2.5 sm:px-3 py-[6px] sm:py-[7px] rounded-full border backdrop-blur pointer-events-auto truncate max-w-[66vw] sm:max-w-none ${isMyTurn && status==='playing' ? 'bg-emerald-500/14 border-emerald-400/30 text-emerald-200' : 'bg-[#101826]/85 border-white/[0.11]'}`}>
              Sıra: <b>{turnPlayer?.name || '—'}</b>{isMyTurn && status==='playing' ? ' • SEN' : ''}{botThinking ? ' • düşünüyor…' : ''}
            </div>
            {selectedBlock !== null && (
              <div className="px-2.5 sm:px-3 py-[6px] sm:py-[7px] rounded-full bg-sky-500/12 border border-sky-400/30 text-sky-200 backdrop-blur pointer-events-auto">
                #{selectedBlock} • Kat {Math.floor(selectedBlock/3)+1}
              </div>
            )}
          </div>

          {/* bottom controls */}
          <div className="absolute bottom-2 sm:bottom-3 left-2 sm:left-3 right-2 sm:right-3">
            <div className="bg-[#101826]/92 border border-white/[0.11] rounded-2xl backdrop-blur px-2.5 sm:px-3 py-2.5 sm:py-3">
              {isMyTurn && status==='playing' ? (
                <div className="flex flex-wrap items-center gap-[7px] sm:gap-2 text-[12px] sm:text-[13px]">
                  <span className="text-zinc-300 mr-1 hidden sm:inline">İt:</span>
                  {(['left','right','back','forward','tap'] as const).map(d=>(
                    <button key={d} disabled={selectedBlock===null}
                      onClick={()=>nudge(d)}
                      className="min-w-[48px] min-h-[44px] sm:min-h-[40px] px-[13px] py-[10px] sm:py-[8px] rounded-[12px] bg-white/[0.065] hover:bg-white/[0.13] active:scale-95 disabled:opacity-35 border border-white/[0.1] text-zinc-100 text-[15px] sm:text-[13px] font-[600] focus:outline-none focus:ring-2 focus:ring-sky-400/60 touch-manipulation">
                      {d==='left'?'←':d==='right'?'→':d==='forward'?'↑':d==='back'?'↓':'Tap'}
                    </button>
                  ))}
                  <span className="hidden xl:inline text-zinc-500 text-[11.5px] ml-2">Bloğu sürükle • Boş alan = kamera • Tekerlek = zoom</span>
                </div>
              ) : (
                <div className="text-zinc-300 text-[12.5px] sm:text-[13px] py-[5px]">
                  {status==='waiting' ? 'Oyun başlamadı.' : isMyTurn ? 'Sıra sende!' : `${turnPlayer?.name || 'Rakip'} oynuyor…`}
                </div>
              )}
            </div>
          </div>

          {/* collapse overlay */}
          {status==='collapsed' && (
            <div className="absolute inset-0 bg-[#070a11]/78 backdrop-blur-[2px] flex items-center justify-center p-4">
              <div className="bg-[#141f33]/96 border border-rose-400/30 rounded-[22px] px-6 sm:px-8 py-6 sm:py-7 text-center shadow-2xl max-w-[360px] w-full">
                <div className="text-[34px]">💥</div>
                <div className="text-[19px] sm:text-[21px] font-[750] mt-2 text-rose-200">KULE ÇÖKTÜ</div>
                <div className="text-zinc-300 mt-2 text-[13.5px]">{turnPlayer ? `${turnPlayer.name} hamlesinde.` : 'Kule dağıldı!'}</div>
                <button onClick={resetTower}
                  className="mt-5 w-full sm:w-auto px-5 py-[12px] rounded-xl bg-amber-400 text-[#201303] font-[730] text-[14px] focus:outline-none focus:ring-2 focus:ring-amber-300">
                  Yeniden Başlat
                </button>
                {!isHost && !isOffline && <div className="text-[11.5px] text-zinc-400 mt-3">Host sıfırlayabilir</div>}
              </div>
            </div>
          )}
        </div>

        {/* right / bottom panel */}
        <aside className="border-t lg:border-t-0 lg:border-l border-white/[0.08] bg-[#0f1524] flex flex-col min-h-[320px] lg:min-h-0 max-h-[44vh] lg:max-h-none">
          {/* players */}
          <div className="px-3 sm:px-4 pt-3 sm:pt-4 pb-3 border-b border-white/[0.07]">
            <div className="text-[10.5px] sm:text-[11px] uppercase tracking-widest text-zinc-500">Oyuncular</div>
            <div className="mt-2 space-y-[8px] sm:space-y-2 max-h-[160px] lg:max-h-none overflow-auto pr-1">
              {effectivePlayers.map((p, idx)=>(
                <div key={p.id}
                  className={`flex items-center gap-2.5 sm:gap-3 px-2.5 sm:px-3 py-[9px] sm:py-[10px] rounded-xl border text-[13px] ${p.id===turnPlayerId ? 'bg-emerald-500/10 border-emerald-400/25' : 'bg-white/[0.035] border-white/[0.07]'}`}>
                  <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center text-[11px] font-[800] text-[#151008] shrink-0" style={{ background:p.color }}>
                    {p.name.slice(0,2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13.5px] sm:text-[14px] font-[600] truncate">
                      {p.name}
                      {p.id==='human' && isOffline && <span className="text-[10px] text-amber-300 ml-1">SEN</span>}
                      {p.id===playerId && !isOffline && <span className="text-[10px] text-amber-300 ml-1">SEN</span>}
                      {p.id==='bot' && <span className="text-[10px] text-sky-300 ml-1">BOT</span>}
                    </div>
                    <div className="text-[11px] text-zinc-500">{idx===0 ? (isOffline?'İnsan':'Host') : (p.id==='bot' ? 'AI • orta' : `Sıra #${idx+1}`)}</div>
                  </div>
                  {p.id===turnPlayerId && <div className="text-[10px] px-2 py-1 rounded bg-emerald-400/20 text-emerald-200 shrink-0">{botThinking?'…':'Sıra'}</div>}
                </div>
              ))}
            </div>
            <button onClick={resetTower}
              className="mt-3 w-full py-[11px] rounded-xl text-[12.5px] sm:text-[13px] bg-white/[0.05] hover:bg-white/[0.1] active:scale-[0.98] border border-white/[0.08] focus:outline-none focus:ring-2 focus:ring-amber-400/50">
              Kuleyi Sıfırla
            </button>
          </div>

          {/* log */}
          <div className="px-3 sm:px-4 py-3 border-b border-white/[0.07]">
            <div className="text-[10.5px] sm:text-[11px] uppercase tracking-widest text-zinc-500 mb-[7px]">Hamle Kaydı</div>
            <div className="h-[96px] sm:h-[110px] overflow-auto text-[12px] sm:text-[12.5px] text-zinc-300 space-y-1 pr-1">
              {log.length ? log.map((m,i)=><div key={i} className="text-zinc-400">• {m}</div>) : <div className="text-zinc-500">Henüz hamle yok.</div>}
            </div>
          </div>

          {/* chat / bot info */}
          <div className="flex-1 min-h-[150px] flex flex-col">
            {isOffline ? (
              <div className="px-3 sm:px-4 py-3 flex-1">
                <div className="text-[10.5px] sm:text-[11px] uppercase tracking-widest text-zinc-500 mb-2">Bot Bilgisi</div>
                <div className="text-[12px] sm:text-[13px] text-zinc-300 leading-relaxed bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                  JengaBot TR • orta<br/>
                  • Güvenli orta kat seçimi<br/>
                  • 2–3 sn düşünme<br/>
                  • Kinematic taşıma + üst kata yerleştirme<br/>
                  • Sesler: WebAudio (dosya yok)
                </div>
                <div className="mt-3 text-[11.5px] text-zinc-500">Telefon / Tablet / PC / Smart TV uyumlu.</div>
              </div>
            ) : (
              <>
                <div className="px-3 sm:px-4 py-2 text-[10.5px] sm:text-[11px] uppercase tracking-widest text-zinc-500 border-b border-white/[0.06]">Sohbet</div>
                <div className="flex-1 overflow-auto px-3 sm:px-4 py-2 space-y-[6px] text-[12.5px] sm:text-[13px]">
                  {chat.map(c=>(
                    <div key={c.id}><span className="font-[650] mr-1" style={{ color: players.find(p=>p.id===c.pid)?.color || '#9aa4b2' }}>{c.name}:</span><span className="text-zinc-300">{c.text}</span></div>
                  ))}
                  {chat.length===0 && <div className="text-zinc-500">İlk mesajı sen yaz.</div>}
                </div>
                <div className="p-2.5 sm:p-3 border-t border-white/[0.07] flex gap-2">
                  <input value={chatInput} onChange={e=>setChatInput(e.target.value)}
                    onKeyDown={e=>{ if(e.key==='Enter') sendChat(); }}
                    placeholder="Mesaj yaz…"
                    className="flex-1 bg-[#0b111d] border border-white/[0.12] rounded-lg px-3 py-[10px] text-[13px] sm:text-[14px] outline-none focus:border-sky-400/60" />
                  <button onClick={sendChat}
                    className="px-[14px] py-[10px] rounded-lg bg-sky-500 text-white text-[12.5px] sm:text-[13px] font-[630] active:scale-95 focus:outline-none focus:ring-2 focus:ring-sky-300">
                    Gönder
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="px-3 sm:px-4 py-[9px] sm:py-[10px] border-t border-white/[0.07] text-[10px] sm:text-[10.5px] text-zinc-500 leading-relaxed">
            Blok 0.75 × 0.24 × 2.25 • 54 adet • Cannon-es • WebAudio • {isOffline ? 'OFFLINE' : `rooms/${roomId}`}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ============================================================
   ROOT APP – garanti geçişli hibrit router
   ============================================================ */
export default function App(){
  const [screen, setScreen] = useState<'login'|'lobby'|'game'>('login');
  const [gameMode, setGameMode] = useState<'offline'|'online'|null>(null);
  const [playerName, setPlayerName] = useState<string>('');
  const [nameInput, setNameInput] = useState('');
  const [roomId, setRoomId] = useState<string|null>(null);
  const [toastMsg, setToastMsg] = useState<string|null>(null);
  const [joinCode, setJoinCode] = useState('');
  const playerId = useMemo(()=> pid(), []);

  const showToast = useCallback((m:string)=>{ setToastMsg(m); setTimeout(()=>setToastMsg(null), 1900); }, []);

  // boot: isim varsa direkt lobi
  useEffect(()=>{
    const saved = localStorage.getItem('jenga_name');
    const urlRoom = new URLSearchParams(location.search).get('room')?.toUpperCase() || null;
    if(saved){
      setPlayerName(saved);
      setScreen('lobby');
      if(urlRoom){
        // URL’den gelen oda – online dene, yoksa lobby’de kal
        setJoinCode(urlRoom);
      }
    }
  }, []);

  // --- GARANTİ GEÇİŞ FONKSİYONLARI ---
  const enterOffline = useCallback(()=>{
    // anında geçiş, hiçbir async bekleme yok
    try{ ac()?.resume(); }catch{}
    setGameMode('offline');
    setRoomId(null);
    setScreen('game');
    showToast('Çevrimdışı bot modu başlatıldı');
  }, [showToast]);

  const enterOnlineCreate = useCallback(async ()=>{
    // ÖNCE EKRANI GEÇİR – sonra Firebase dene
    const code = roomCode();
    setGameMode('online');
    setRoomId(code);
    setScreen('game');
    showToast('Oda açılıyor… '+code);
    try{
      const db = getDbSafe();
      if(!db) throw new Error('db null');
      const initial = generateInitialBlocks();
      const blocksObj: Record<string, BlockState> = {};
      initial.forEach(b=> blocksObj[b.id]=b);
      const ok = await fbSafe(()=> set(ref(db, `rooms/${code}`), {
        createdAt: Date.now(),
        hostId: playerId,
        status: 'waiting',
        turnIndex: 0,
        turnPlayerId: playerId,
        moveCount: 0,
        blocks: blocksObj
      }), null);
      if(ok===null) throw new Error('set fail');
      await fbSafe(()=> set(ref(db, `rooms/${code}/players/${playerId}`), {
        name: playerName, joinedAt: Date.now(), color: PLAYER_COLORS[Math.floor(Math.random()*PLAYER_COLORS.length)], score:0
      }));
      try{ onDisconnect(ref(db, `rooms/${code}/players/${playerId}`)).remove(); }catch{}
      history.replaceState(null,'',`?room=${code}`);
      showToast('Oda hazır: '+code);
    }catch(e){
      console.warn(e);
      showToast('Firebase bağlanamadı → offline bot’a geçiliyor');
      // 1.2 sn sonra offline fallback – oyun donmasın
      setTimeout(()=> enterOffline(), 1200);
    }
  }, [playerId, playerName, showToast, enterOffline]);

  const enterOnlineJoin = useCallback(async (codeRaw:string)=>{
    const code = codeRaw.trim().toUpperCase();
    if(!code){ showToast('Kod gir'); return; }
    // önce ekranı geçir
    setGameMode('online');
    setRoomId(code);
    setScreen('game');
    showToast('Odaya bağlanılıyor…');
    try{
      const db = getDbSafe(); if(!db) throw new Error('no db');
      const snap: any = await fbSafe(()=> get(ref(db, `rooms/${code}`)));
      if(!snap || !snap.exists?.()) throw new Error('not found');
      await fbSafe(()=> set(ref(db, `rooms/${code}/players/${playerId}`), {
        name: playerName, joinedAt: Date.now(), color: PLAYER_COLORS[Math.floor(Math.random()*PLAYER_COLORS.length)], score:0
      }));
      try{ onDisconnect(ref(db, `rooms/${code}/players/${playerId}`)).remove(); }catch{}
      history.replaceState(null,'',`?room=${code}`);
      showToast('Katıldın: '+code);
    }catch(e){
      console.warn(e);
      showToast('Katılım başarısız → offline');
      setTimeout(()=> enterOffline(), 1100);
    }
  }, [playerId, playerName, showToast, enterOffline]);

  const quickMatch = useCallback(async ()=>{
    setGameMode('online');
    setScreen('game');
    showToast('Rastgele eşleşme aranıyor…');
    try{
      const db = getDbSafe(); if(!db) throw new Error('no db');
      const snap: any = await fbSafe(()=> get(ref(db, 'rooms')));
      const all = snap ? snap.val?.() || {} : {};
      let found: string | null = null;
      for(const [code, r] of Object.entries<any>(all)){
        if(r?.status==='waiting'){
          const pc = r.players ? Object.keys(r.players).length : 0;
          if(pc < 5){ found = code; break; }
        }
      }
      if(found){
        await enterOnlineJoin(found);
      } else {
        await enterOnlineCreate();
      }
    }catch(e){
      showToast('Eşleşme yok → offline');
      setTimeout(()=> enterOffline(), 900);
    }
  }, [enterOnlineCreate, enterOnlineJoin, showToast, enterOffline]);

  const exitToLobby = useCallback(()=>{
    // temiz çıkış
    if(gameMode==='online' && roomId){
      const db = getDbSafe();
      if(db) fbSafe(()=> remove(ref(db, `rooms/${roomId}/players/${playerId}`)));
    }
    setGameMode(null);
    setRoomId(null);
    setScreen('lobby');
    history.replaceState(null,'',location.pathname);
  }, [gameMode, roomId, playerId]);

  /* ---------------- RENDER ---------------- */

  // LOGIN
  if(screen==='login'){
    return (
      <div className="min-h-[100dvh] bg-[#0b0f17] text-zinc-100 flex items-center justify-center px-4 sm:px-5 md:px-6 relative overflow-hidden">
        {/* ambient */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-24 sm:-top-32 right-[-80px] sm:-right-24 w-[360px] sm:w-[520px] h-[360px] sm:h-[520px] rounded-full blur-[120px] sm:blur-[140px] opacity-[0.14]" style={{background:'radial-gradient(circle,#ff9b54 0%, #d44cff 45%, transparent 70%)'}}/>
          <div className="absolute -bottom-28 left-[-70px] sm:-left-24 w-[340px] sm:w-[520px] h-[340px] sm:h-[520px] rounded-full blur-[110px] sm:blur-[130px] opacity-[0.10]" style={{background:'radial-gradient(circle,#58c5ff 0%, #38e08b 45%, transparent 70%)'}}/>
        </div>

        <div className="relative z-10 w-full max-w-[1040px] grid lg:grid-cols-[1.15fr_.85fr] gap-7 sm:gap-9 items-center">
          <div className="px-1 sm:px-0">
            <div className="inline-flex items-center gap-2 text-[10px] sm:text-[11px] tracking-widest uppercase text-amber-300/90 bg-amber-400/10 border border-amber-400/20 rounded-full px-3 py-1.5 mb-4 sm:mb-5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              Three.js • Cannon-es • WebAudio • Hybrid
            </div>
            <h1 className="text-[40px] sm:text-[52px] md:text-[60px] font-[800] tracking-[-0.028em] leading-[0.92] text-zinc-50">
              3D Multiplayer<br/>JENGA<span className="text-[#ff9758]">.</span>
            </h1>
            <p className="mt-4 sm:mt-5 text-[14px] sm:text-[15.5px] leading-relaxed text-zinc-400 max-w-[520px]">
              Tarayıcı içi gerçek fizik. Sürükle-çek, orbit kamera, Web Audio API ahşap sesler.
              <b className="text-zinc-200"> Firebase multiplayer + Çevrimdışı Bot</b> hibrit.
            </p>
            <div className="mt-6 sm:mt-7 grid grid-cols-1 xs:grid-cols-3 sm:grid-cols-3 gap-2.5 sm:gap-3 text-[11.5px] sm:text-[12px] text-zinc-300 max-w-[540px]">
              {[
                ['54 Blok','Cannon-es'],
                ['WebAudio','0 dosya'],
                ['TV • Mobil','Responsive']
              ].map(([a,b])=>(
                <div key={a} className="rounded-2xl bg-white/[0.035] border border-white/[0.07] px-3 py-3 sm:py-[14px]">
                  <div className="font-[660] text-zinc-100">{a}</div>
                  <div className="text-zinc-500 mt-0.5">{b}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[24px] sm:rounded-[28px] bg-[#131a29]/95 backdrop-blur-xl border border-white/[0.09] shadow-[0_18px_70px_rgba(0,0,0,0.55)] p-5 sm:p-[26px]">
            <div className="text-[11px] tracking-[0.18em] uppercase text-zinc-500">Oyuncu Girişi</div>
            <div className="text-[20px] sm:text-[22px] font-[720] mt-1 tracking-tight">Jenga Tower’a katıl</div>
            <div className="mt-4 sm:mt-5 space-y-4">
              <div>
                <label className="text-[12px] text-zinc-400">Takma adın</label>
                <input
                  value={nameInput}
                  onChange={e=>setNameInput(e.target.value)}
                  onKeyDown={e=>{ if(e.key==='Enter' && nameInput.trim().length>=2){ const nn=nameInput.trim(); localStorage.setItem('jenga_name', nn); setPlayerName(nn); setScreen('lobby'); } }}
                  placeholder="ör. GMX / Meka"
                  maxLength={18}
                  autoFocus
                  className="mt-1.5 w-full bg-[#0e1422] border border-white/[0.12] rounded-xl px-4 py-[13px] sm:py-[14px] text-[15px] sm:text-[16px] outline-none focus:border-amber-400/70"
                />
              </div>
              <button
                onClick={()=>{
                  const nn = nameInput.trim();
                  if(nn.length < 2){ showToast('En az 2 karakter'); return; }
                  localStorage.setItem('jenga_name', nn);
                  setPlayerName(nn);
                  setScreen('lobby');
                }}
                className="w-full py-[13px] sm:py-[14px] rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 text-[#1a1205] font-[730] text-[15px] sm:text-[16px] shadow-lg shadow-orange-900/25 active:scale-[0.985] transition focus:outline-none focus:ring-2 focus:ring-amber-300"
              >
                Devam Et →
              </button>
              <p className="text-[11px] sm:text-[11.5px] text-zinc-500 leading-relaxed">
                Offline mod internet gerektirmez. TV kumandası / dokunmatik / mouse hepsi desteklenir.
              </p>
            </div>
          </div>
        </div>
        {toastMsg && (
          <div className="fixed bottom-4 sm:bottom-5 left-1/2 -translate-x-1/2 bg-[#151d2d] border border-white/[0.14] shadow-2xl px-4 py-[11px] rounded-xl text-[13px] text-zinc-100 z-50 max-w-[92vw] text-center">{toastMsg}</div>
        )}
      </div>
    );
  }

  // LOBBY
  if(screen==='lobby'){
    return (
      <div className="min-h-[100dvh] bg-[#090f18] text-zinc-100">
        <header className="border-b border-white/[0.07] bg-[#0f1524]/80 backdrop-blur px-3 sm:px-5 md:px-9 h-[60px] sm:h-[64px] flex items-center justify-between">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-[11px] sm:rounded-[12px] bg-gradient-to-br from-amber-400 to-orange-500 text-[#201104] font-black flex items-center justify-center text-[14px] sm:text-[15px]">J</div>
            <div className="min-w-0">
              <div className="font-[750] tracking-tight text-[15px] sm:text-[16px]">JENGA 3D</div>
              <div className="text-[10.5px] sm:text-[11px] text-zinc-500 -mt-0.5">Hybrid • TR</div>
            </div>
          </div>
          <div className="text-[13px] sm:text-sm text-zinc-300 truncate ml-2">Merhaba, <b className="text-amber-300">{playerName}</b>
            <button onClick={()=>{ localStorage.removeItem('jenga_name'); setPlayerName(''); setScreen('login'); }}
              className="ml-2 sm:ml-3 text-[11px] px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1]">Çıkış</button>
          </div>
        </header>

        <main className="max-w-[1100px] mx-auto px-4 sm:px-5 md:px-9 py-7 sm:py-10 grid lg:grid-cols-[1.08fr_.92fr] gap-6 sm:gap-8">
          {/* offline big card */}
          <section className="rounded-[22px] sm:rounded-[26px] border border-white/[0.09] bg-gradient-to-b from-[#111a2a] to-[#0e1524] p-5 sm:p-8 shadow-2xl">
            <div className="text-[10.5px] sm:text-[11px] tracking-widest uppercase text-emerald-300/90">Çevrimdışı • Hızlı Başla</div>
            <h2 className="text-[24px] sm:text-[28px] font-[780] tracking-tight mt-2">Bota Karşı Oyna</h2>
            <p className="text-zinc-400 mt-2.5 sm:mt-3 text-[13.5px] sm:text-[14px] leading-relaxed">
              Firebase olmadan, tamamen yerel. Three.js + Cannon-es + WebAudio. Telefon, tablet, PC ve Smart TV uyumlu. Bot 2–3 sn düşünür, güvenli blok çeker, üste koyar.
            </p>
            <button
              onClick={enterOffline}
              className="mt-5 sm:mt-6 w-full sm:w-auto px-5 sm:px-6 py-[13px] sm:py-[14px] rounded-xl bg-emerald-400 text-emerald-950 font-[760] text-[15px] sm:text-[16px] hover:brightness-105 active:scale-[0.985] transition shadow-lg shadow-emerald-900/25 focus:outline-none focus:ring-2 focus:ring-emerald-300"
            >
              🤖 Bota Karşı Oyna (Çevrimdışı)
            </button>
            <div className="mt-6 sm:mt-7 grid sm:grid-cols-2 gap-3 text-[12px] sm:text-[12.5px] text-zinc-400">
              <div className="bg-white/[0.032] border border-white/[0.065] rounded-xl p-3">• Orbit: boş alan sürükle<br/>• Çek: blok basılı tut</div>
              <div className="bg-white/[0.032] border border-white/[0.065] rounded-xl p-3">• Ses: scrape / thud / crash<br/>• 0 dosya – WebAudio</div>
            </div>
          </section>

          {/* online */}
          <section className="rounded-[22px] sm:rounded-[26px] border border-white/[0.09] bg-[#111829]/92 p-5 sm:p-8 flex flex-col">
            <div className="text-[10.5px] sm:text-[11px] tracking-widest uppercase text-sky-300/90">Online Multiplayer</div>
            <h3 className="text-[20px] sm:text-[22px] font-[720] tracking-tight mt-2">Firebase Realtime</h3>

            <button onClick={quickMatch}
              className="mt-4 sm:mt-5 w-full py-[13px] sm:py-[14px] rounded-xl bg-sky-500 text-white font-[680] text-[14.5px] sm:text-[15px] hover:bg-sky-400 active:scale-[0.985] transition focus:outline-none focus:ring-2 focus:ring-sky-300">
              🎯 Rastgele Oyuncu Bul
            </button>
            <button onClick={enterOnlineCreate}
              className="mt-3 w-full py-[12px] sm:py-[13px] rounded-xl bg-amber-400 text-[#1a1204] font-[730] text-[14.5px] sm:text-[15px] hover:brightness-105 active:scale-[0.985] transition focus:outline-none focus:ring-2 focus:ring-amber-300">
              ＋ Oda Oluştur
            </button>

            <div className="flex items-center gap-3 my-4 sm:my-5">
              <div className="h-px bg-white/[0.08] flex-1" />
              <span className="text-[11px] text-zinc-500">veya kodla katıl</span>
              <div className="h-px bg-white/[0.08] flex-1" />
            </div>

            <input
              value={joinCode}
              onChange={e=>setJoinCode(e.target.value.toUpperCase())}
              placeholder="Örn: KJ5PA"
              maxLength={5}
              className="w-full bg-[#0c121f] border border-white/[0.13] rounded-xl px-4 py-[13px] sm:py-[14px] tracking-[0.20em] text-center text-[17px] sm:text-[18px] font-[650] outline-none focus:border-sky-400/70 uppercase"
            />
            <button onClick={()=> enterOnlineJoin(joinCode)}
              className="mt-3 w-full py-[12px] sm:py-[13px] rounded-xl bg-white/[0.065] hover:bg-white/[0.11] active:scale-[0.985] border border-white/[0.11] font-[600] text-[14px] focus:outline-none focus:ring-2 focus:ring-white/30">
              Katıl
            </button>

            <div className="text-[11px] sm:text-[11.5px] text-zinc-500 mt-4">
              URL ile: <span className="text-zinc-300">?room=KOD</span> • Test için 2 sekme aç.
            </div>
          </section>
        </main>

        <footer className="max-w-[1100px] mx-auto px-4 sm:px-5 md:px-9 pb-10 sm:pb-14 text-[11.5px] sm:text-[12.5px] text-zinc-500 leading-relaxed">
          • Three r0.160 • cannon-es 0.20 • Firebase 10.x • React 19 • Tailwind 4<br/>
          Blok 0.75 × 0.24 × 2.25m • Kat 18 • mass 0.42 • friction 0.51 • Telefon / Tablet / PC / Smart TV optimize
        </footer>

        {toastMsg && (
          <div className="fixed bottom-4 sm:bottom-5 left-1/2 -translate-x-1/2 bg-[#151d2d] border border-white/[0.14] shadow-2xl px-4 py-[11px] rounded-xl text-[13px] text-zinc-100 z-50 max-w-[92vw] text-center">{toastMsg}</div>
        )}
      </div>
    );
  }

  // GAME
  return (
    <div key={(gameMode||'none')+'-'+(roomId||'local')}>
      <GameView
        mode={(gameMode as 'offline'|'online') || 'offline'}
        playerName={playerName}
        playerId={playerId}
        roomId={roomId}
        onExit={exitToLobby}
        toast={showToast}
      />
      {toastMsg && (
        <div className="fixed bottom-4 sm:bottom-5 left-1/2 -translate-x-1/2 bg-[#151d2d] border border-white/[0.14] shadow-2xl px-4 py-[11px] rounded-xl text-[13px] text-zinc-100 z-50 max-w-[92vw] text-center">{toastMsg}</div>
      )}
      {/* TV / large screen tweaks */}
      <style>{`
        @media (min-width: 1920px){ html{ font-size:18px; } }
        @media (pointer:coarse){
          button{ min-height:44px; }
        }
        @media (max-width: 640px){
          canvas{ touch-action:none; }
        }
        * { -webkit-tap-highlight-color: transparent; }
        ::-webkit-scrollbar{ width:8px; height:8px; }
        ::-webkit-scrollbar-thumb{ background:#2a3448; border-radius:6px; }
      `}</style>
    </div>
  );
}