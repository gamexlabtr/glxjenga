import { useState, useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { database } from './firebase';
import { ref, onValue, set, update } from 'firebase/database';

// Constants
const BLOCK_SIZE = 1.0;
const BLOCK_SIZE_LIGHT = 0.95;
const MAX_LEVELS = 15;

interface BlockData {
  id: string;
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
  size: number;
  removed: boolean;
  level: number;
}

interface GameState {
  status: 'waiting' | 'playing' | 'finished';
  currentPlayer: number;
  blocks: BlockData[];
  lastMoveTime: number;
}

export default function App() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const worldRef = useRef<CANNON.World | null>(null);
  const bodiesRef = useRef<Map<string, CANNON.Body>>(new Map());
  const visualMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const isDraggingRef = useRef(false);
  const draggedBlockRef = useRef<string | null>(null);
  
  // Game states
  const [gameMode, setGameMode] = useState<'menu' | 'multiplayer' | 'singleplayer'>('menu');
  const [gameState, setGameState] = useState<'menu' | 'playing' | 'gameOver'>('menu');
  const [roomId, setRoomId] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [players, setPlayers] = useState<Record<string, { score: number; ready: boolean }>>({});
  const [gameError, setGameError] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [message, setMessage] = useState('');
  const isAIThinkingRef = useRef(false);
  const [, setPlayersState] = useState({});
  
  // Local game state (for offline mode)
  const [localGameState, setLocalGameState] = useState<GameState>({
    status: 'waiting',
    currentPlayer: 1,
    blocks: [],
    lastMoveTime: Date.now()
  });

  // Initialize audio context
  const initAudio = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
  }, []);

  // Sound effects using Web Audio API
  const playSound = useCallback((type: 'scrape' | 'thud' | 'crash') => {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    switch (type) {
      case 'scrape':
        oscillator.frequency.setValueAtTime(110, ctx.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.3);
        gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.3);
        break;
      case 'thud':
        oscillator.frequency.setValueAtTime(82, ctx.currentTime);
        gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.2);
        break;
      case 'crash':
        oscillator.frequency.setValueAtTime(65, ctx.currentTime);
        gainNode.gain.setValueAtTime(0.4, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.5);
        break;
    }
  }, []);

  // Initialize Three.js scene
  const initScene = useCallback(() => {
    if (!canvasRef.current) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.set(10, 10, 10);
    camera.lookAt(0, 4, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    canvasRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 30, 20);
    scene.add(directionalLight);

    const groundGeometry = new THREE.PlaneGeometry(30, 30);
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x2E7D32 });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    scene.add(ground);

    const world = new CANNON.World();
    world.gravity.set(0, -20, 0);
    worldRef.current = world;

    const groundBody = new CANNON.Body({ mass: 0 });
    groundBody.addShape(new CANNON.Plane());
    groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI / 2);
    world.addBody(groundBody);

    // Mouse event handlers
    const handleMouseDown = (e: MouseEvent) => {
      if (!worldRef.current || !cameraRef.current || gameMode !== 'singleplayer') return;
      isDraggingRef.current = true;
      const rect = canvasRef.current!.getBoundingClientRect();
      const mouse = new THREE.Vector2();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, camera!);
      const meshes = Array.from(visualMeshesRef.current.values());
      const intersects = raycaster.intersectObjects(meshes);
      if (intersects.length > 0) {
        draggedBlockRef.current = intersects[0].object.userData.id;
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !draggedBlockRef.current || !cameraRef.current) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const mouse = new THREE.Vector2();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, camera!);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const intersection = new THREE.Vector3();
      raycaster.ray.intersectPlane(plane, intersection);
      const body = bodiesRef.current.get(draggedBlockRef.current!);
      if (body) {
        body.position.set(intersection.x, intersection.y + 0.5, intersection.z);
      }
    };

    const handleMouseUp = () => {
      if (!isDraggingRef.current || !draggedBlockRef.current) {
        isDraggingRef.current = false;
        return;
      }
      playSound('thud');
      isDraggingRef.current = false;
      draggedBlockRef.current = null;
    };

    canvasRef.current.addEventListener('mousedown', handleMouseDown);
    canvasRef.current.addEventListener('mousemove', handleMouseMove);
    canvasRef.current.addEventListener('mouseup', handleMouseUp);

    const handleResize = () => {
      if (camera && renderer) {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      canvasRef.current?.removeEventListener('mousedown', handleMouseDown);
      canvasRef.current?.removeEventListener('mousemove', handleMouseMove);
      canvasRef.current?.removeEventListener('mouseup', handleMouseUp);
    };
  }, [playSound, gameMode]);

  // Create tower
  const createTower = useCallback((isLocal = gameMode === 'singleplayer') => {
    const newBlocks: BlockData[] = [];
    const scene = sceneRef.current;
    const world = worldRef.current;
    
    for (let level = 0; level < MAX_LEVELS; level++) {
      const isTopLevel = level >= MAX_LEVELS - 2;
      const size = isTopLevel ? BLOCK_SIZE_LIGHT : BLOCK_SIZE;
      const numBlocks = level === 0 ? 3 : 2;
      const offset = (numBlocks === 3) ? -(numBlocks - 1) * 0.5 * size : 0;
      
      for (let i = 0; i < numBlocks; i++) {
        const posX = offset + i * size;
        const posY = level * size + size / 2;
        let quatX = 0, quatY = 0, quatZ = 0, quatW = 1;
        if (level % 3 === 2) {
          quatY = Math.sin(Math.PI / 4);
          quatW = Math.cos(Math.PI / 4);
        }
        
        const block: BlockData = {
          id: `block_${level}_${i}`,
          position: { x: posX, y: posY, z: 0 },
          quaternion: { x: quatX, y: quatY, z: quatZ, w: quatW },
          size,
          removed: false,
          level
        };
        newBlocks.push(block);
        
        const geometry = new THREE.BoxGeometry(block.size, block.size, block.size);
        const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(0xD2B48C), roughness: 0.7 });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData = { id: block.id };
        mesh.position.set(block.position.x, block.position.y, block.position.z);
        mesh.quaternion.set(block.quaternion.x, block.quaternion.y, block.quaternion.z, block.quaternion.w);
        if (scene) scene.add(mesh);
        if (world) {
          const body = new CANNON.Body({
            mass: 0.5,
            shape: new CANNON.Box(new CANNON.Vec3(block.size/2, block.size/2, block.size/2))
          });
          body.position.set(block.position.x, block.position.y, block.position.z);
          body.quaternion.set(block.quaternion.x, block.quaternion.y, block.quaternion.z, block.quaternion.w);
          world.addBody(body);
          bodiesRef.current.set(block.id, body);
          visualMeshesRef.current.set(block.id, mesh);
        }
      }
    }
    
    if (isLocal) {
      setLocalGameState(prev => ({ ...prev, blocks: newBlocks }));
    }
    return newBlocks;
  }, [gameMode]);

  // AI move
  const aiMove = useCallback(() => {
    if (isAIThinkingRef.current || !localGameState.blocks) return;
    isAIThinkingRef.current = true;
    
    setTimeout(() => {
      const availableBlocks = localGameState.blocks.filter(b => 
        !b.removed && b.level > 2 && b.level < MAX_LEVELS - 3
      );
      if (availableBlocks.length === 0) {
        isAIThinkingRef.current = false;
        return;
      }
      
      const block = availableBlocks[Math.floor(Math.random() * availableBlocks.length)];
      const newBlocks = localGameState.blocks.map(b => 
        b.id === block.id ? { ...b, removed: true } : b
      );
      
      playSound('scrape');
      
      setTimeout(() => {
        setLocalGameState(prev => ({
          ...prev,
          blocks: newBlocks,
          currentPlayer: 1
        }));
        playSound('thud');
        isAIThinkingRef.current = false;
      }, 1000);
    }, 2000);
  }, [localGameState, playSound]);

  // Animation loop
  useEffect(() => {
    if (!sceneRef.current || !rendererRef.current || !worldRef.current) return;

    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    const world = worldRef.current;
    const camera = cameraRef.current;

    let animationId: number;
    const animate = () => {
      if (scene && renderer && world && camera) {
        world.step(1/60);
        visualMeshesRef.current.forEach((mesh, id) => {
          const body = bodiesRef.current.get(id);
          if (body && mesh) {
            mesh.position.set(body.position.x, body.position.y, body.position.z);
            mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
          }
        });
        renderer.render(scene, camera);
      }
      animationId = requestAnimationFrame(animate);
    };
    animate();
    return () => cancelAnimationFrame(animationId);
  }, []);

  // Firebase listeners
  useEffect(() => {
    if (!roomId || gameMode !== 'multiplayer') return;
    
    const gameRef = ref(database, `rooms/${roomId}/game`);
    const playersRef = ref(database, `rooms/${roomId}/players`);

    const unsubscribeGame = onValue(gameRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        setLocalGameState(data);
        if (data.status === 'finished') {
          setGameState('gameOver');
        }
      }
    });

    const unsubscribePlayers = onValue(playersRef, (snapshot) => {
      const data = snapshot.val();
      if (data) setPlayers(data);
    });

    return () => {
      unsubscribeGame();
      unsubscribePlayers();
    };
  }, [roomId, gameMode]);

  // Initialize scene
  useEffect(() => {
    initScene();
    initAudio();
    return () => {
      if (rendererRef.current && canvasRef.current) {
        canvasRef.current.removeChild(rendererRef.current.domElement);
      }
    };
  }, [initScene, initAudio]);

  // Handle game start
  const startGame = () => {
    if (gameMode === 'multiplayer' && !roomId) return;
    
    createTower(gameMode === 'singleplayer');
    
    if (gameMode === 'multiplayer') {
      const gameRef = ref(database, `rooms/${roomId}/game`);
      set(gameRef, {
        status: 'playing',
        currentPlayer: 1,
        blocks: [],
        lastMoveTime: Date.now()
      });
    } else {
      setLocalGameState({
        status: 'playing',
        currentPlayer: 1,
        blocks: [],
        lastMoveTime: Date.now()
      });
    }
    setGameState('playing');
    setMessage(gameMode === 'singleplayer' ? 'Oyuncu sıra! Block çıkarın.' : 'Oyun başladı!');
  };

  // Handle block removal
  const removeBlock = (blockId: string) => {
    if (gameMode === 'singleplayer') {
      const newBlocks = localGameState.blocks.map(b => 
        b.id === blockId ? { ...b, removed: true } : b
      );
      playSound('scrape');
      setTimeout(() => {
        setLocalGameState(prev => ({ ...prev, blocks: newBlocks, currentPlayer: 2 }));
        playSound('thud');
        aiMove();
      }, 500);
    } else if (roomId) {
      const gameRef = ref(database, `rooms/${roomId}/game`);
      const newBlocks = localGameState.blocks.map(b => 
        b.id === blockId ? { ...b, removed: true } : b
      );
      update(gameRef, { blocks: newBlocks, currentPlayer: 3 - localGameState.currentPlayer });
    }
  };

  // Join room
  const joinRoom = () => {
    if (!playerName.trim()) {
      setGameError('Lütfen bir isim girin');
      return;
    }
    const newRoomId = roomId.trim() || Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomId(newRoomId);
    const playerRef = ref(database, `rooms/${newRoomId}/players/${playerName}`);
    set(playerRef, { score: 0, ready: true });
    setIsConnected(true);
  };

  return (
    <div className="w-full h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-indigo-900 to-slate-900">
      <div ref={canvasRef} className="absolute inset-0" />
      
      <div className="relative z-10 bg-black/60 backdrop-blur rounded-2xl p-6 border border-white/20 w-full max-w-md">
        {gameState === 'menu' && (
          <div className="text-white">
            <h1 className="text-3xl font-bold mb-4 text-center">🎮 3D Multiplayer JENGA</h1>
            
            {gameMode === 'menu' && (
              <div className="space-y-3">
                <button
                  onClick={() => setGameMode('singleplayer')}
                  className="w-full py-3 bg-gradient-to-r from-green-500 to-emerald-600 rounded-lg font-semibold hover:from-green-600 hover:to-emerald-700 transition"
                >
                  🤖 Bota Karşı Oyna (Çevrimdışı)
                </button>
                <button
                  onClick={() => setGameMode('multiplayer')}
                  className="w-full py-3 bg-gradient-to-r from-violet-500 to-indigo-600 rounded-lg font-semibold hover:from-violet-600 hover:to-indigo-700 transition"
                >
                  👥 Odaya Katıl / Oda Oluştur
                </button>
              </div>
            )}
            
            {gameMode === 'multiplayer' && (
              <div className="mb-4">
                <input
                  type="text"
                  placeholder="İsminizi girin"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg bg-white/20 border border-white/30 text-white placeholder:text-gray-400 mb-2"
                />
                <input
                  type="text"
                  placeholder="Oda kodu (boş bırakıp enter edin)"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg bg-white/20 border border-white/30 text-white placeholder:text-gray-400"
                />
              </div>
            )}
            
            {gameError && <p className="text-red-400 mb-2">{gameError}</p>}
            
            <div className="flex gap-2">
              {gameMode === 'multiplayer' && (
                <button
                  onClick={joinRoom}
                  className="flex-1 py-3 bg-gradient-to-r from-violet-500 to-indigo-600 rounded-lg font-semibold"
                >
                  Odaya Katıl
                </button>
              )}
              {gameMode === 'multiplayer' && (
                <button
                  onClick={() => { setRoomId(roomId || Math.random().toString(36).substring(2, 8).toUpperCase()); }}
                  className="flex-1 py-3 bg-gradient-to-r from-blue-500 to-cyan-600 rounded-lg font-semibold"
                >
                  Oda Oluştur
                </button>
              )}
              {gameMode === 'menu' && (
                <button
                  onClick={() => setGameMode('menu')}
                  className="px-4 py-2 bg-gray-600 rounded-lg"
                >
                  ← Geri
                </button>
              )}
            </div>
          </div>
        )}

        {gameState === 'playing' && (
          <div className="text-white">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold">🎮 JENGA</h2>
              <div className="text-sm">
                <p>Sıra: <span className="font-bold text-violet-400">Oyuncu {localGameState.currentPlayer}</span></p>
                <p className="text-gray-300">{gameMode === 'multiplayer' ? (isConnected ? '☁️ Bulut' : '❌ Bağlantı yok') : '💻 Çevrimdışı'}</p>
              </div>
            </div>
            
            <p className="text-sm mb-4 text-violet-300">{message}</p>
            
            <button
              onClick={startGame}
              className="w-full py-2 bg-gradient-to-r from-green-500 to-emerald-600 rounded-lg font-semibold"
            >
              Oyunu Başlat
            </button>
          </div>
        )}

        {gameState === 'gameOver' && (
          <div className="text-center text-white">
            <h2 className="text-3xl font-bold mb-4 text-red-400">💥 OYUM BİTİŞİ</h2>
            <p className="mb-4">{message}</p>
            <button
              onClick={() => { setGameState('menu'); setGameMode('menu'); }}
              className="py-2 px-6 bg-gradient-to-r from-violet-500 to-indigo-600 rounded-lg"
            >
              Menüye Dön
            </button>
          </div>
        )}
      </div>
    </div>
  );
}