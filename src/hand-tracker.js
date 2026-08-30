/**
 * hand-tracker.js — Vanilla JS hand-tracking drawing engine
 *
 * Uses @mediapipe/tasks-vision (new API, better mobile support).
 * Architecture: detectForVideo in RAF render loop → gesture classification → canvas drawing.
 * Zero React state updates in the hot path.
 */

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

// ─── Shared mutable state ────────────────────────────────────────────────────
const cfg = {
  color: '#ff0055',
  brushSize: 8,
  isErasing: false,
};

// ─── DOM + canvas refs (populated by init()) ─────────────────────────────────
let videoEl = null;
let ctxOut = null;
let ctxDraw = null;
let ctxCursor = null;
let canvasDraw = null;
let canvasOut = null;

// ─── Runtime state ───────────────────────────────────────────────────────────
const state = {
  hands: [],
  isPenDown: false,
  prevPt: null,
  undoHistory: [],
  frameCount: 0,
  lastFpsTime: performance.now(),
};

let animFrameId = null;
let handLandmarker = null;
let stream = null;
let lastVideoTime = -1;

// ─── Landmark smoothing (reduces jitter on mobile) ──────────────────────────
const SMOOTH_FRAMES = 3;
const landmarkBuffer = [];

function smoothLandmarks(raw) {
  landmarkBuffer.push(raw.map(l => ({ x: l.x, y: l.y, z: l.z })));
  if (landmarkBuffer.length > SMOOTH_FRAMES) landmarkBuffer.shift();
  if (landmarkBuffer.length === 1) return raw;

  const count = landmarkBuffer.length;
  return raw.map((_, i) => ({
    x: landmarkBuffer.reduce((s, f) => s + f[i].x, 0) / count,
    y: landmarkBuffer.reduce((s, f) => s + f[i].y, 0) / count,
    z: landmarkBuffer.reduce((s, f) => s + f[i].z, 0) / count,
  }));
}

// ─── Undo stack ──────────────────────────────────────────────────────────────
const MAX_UNDO = 30;

function pushSnapshot() {
  if (!canvasDraw || !ctxDraw) return;
  try {
    state.undoHistory.push(ctxDraw.getImageData(0, 0, canvasDraw.width, canvasDraw.height));
    if (state.undoHistory.length > MAX_UNDO) state.undoHistory.shift();
  } catch (_) {}
}

function undo() {
  if (state.undoHistory.length > 0 && ctxDraw) {
    ctxDraw.putImageData(state.undoHistory.pop(), 0, 0);
  }
  return state.undoHistory.length;
}

function clearCanvas() {
  if (!ctxDraw || !canvasDraw) return 0;
  pushSnapshot();
  ctxDraw.clearRect(0, 0, canvasDraw.width, canvasDraw.height);
  return state.undoHistory.length;
}

function download() {
  if (!canvasDraw || !videoEl) return;
  const merge = document.createElement('canvas');
  merge.width = canvasDraw.width;
  merge.height = canvasDraw.height;
  const mCtx = merge.getContext('2d');

  mCtx.fillStyle = '#0a0a0f';
  mCtx.fillRect(0, 0, merge.width, merge.height);

  // Camera feed (manual flip to match CSS-mirrored on-screen appearance)
  mCtx.save();
  mCtx.translate(merge.width, 0);
  mCtx.scale(-1, 1);
  mCtx.drawImage(videoEl, 0, 0, merge.width, merge.height);
  mCtx.restore();

  mCtx.fillStyle = 'rgba(10,10,15,0.15)';
  mCtx.fillRect(0, 0, merge.width, merge.height);

  // Drawing layer (manual flip to match CSS-mirrored on-screen appearance)
  mCtx.save();
  mCtx.translate(merge.width, 0);
  mCtx.scale(-1, 1);
  mCtx.drawImage(canvasDraw, 0, 0);
  mCtx.restore();

  const link = document.createElement('a');
  link.download = `air-canvas-${Date.now()}.png`;
  link.href = merge.toDataURL('image/png');
  link.click();
}

// ─── Resize handler ──────────────────────────────────────────────────────────
function handleResize() {
  if (!canvasOut || !canvasDraw) return;
  const w = window.innerWidth;
  const h = window.innerHeight;

  for (const c of [canvasOut, canvasDraw]) {
    let saved = null;
    if (c.width > 0 && c.height > 0) {
      const ctx = c.getContext('2d', { willReadFrequently: true });
      try { saved = ctx.getImageData(0, 0, c.width, c.height); } catch (_) {}
    }

    c.width = w;
    c.height = h;
    c.style.width = w + 'px';
    c.style.height = h + 'px';

    if (saved) {
      const ctx = c.getContext('2d');
      ctx.putImageData(saved, 0, 0);
    }
  }
}

// ─── Finger extension detection ──────────────────────────────────────────────
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function fingerExtended(hand, tipIdx, mcpIdx) {
  return dist(hand[tipIdx], hand[0]) > dist(hand[mcpIdx], hand[0]) * 1.2;
}

/**
 * Gesture classifier — uses FINGER POSE, not pinch.
 *
 *   Index UP + Middle DOWN → DRAW (point to draw)
 *   Index UP + Middle UP (close together) → HOVER (pause, show cursor)
 *   Everything else → IDLE (pen up)
 */
function classifyGesture(hand) {
  const iE = fingerExtended(hand, 8, 5);  // index extended
  const mE = fingerExtended(hand, 12, 9); // middle extended
  const rE = fingerExtended(hand, 16, 13); // ring extended
  const pE = fingerExtended(hand, 20, 17); // pinky extended

  // Index UP + Middle DOWN → DRAW
  if (iE && !mE) {
    if (!state.isPenDown) {
      state.isPenDown = true;
      return 'draw';
    }
    return 'draw';
  }

  // Index was drawing but now middle came up → end stroke
  if (state.isPenDown && iE && mE) {
    state.isPenDown = false;
    return 'hover';
  }

  // Index UP + Middle UP (close together) → HOVER
  if (iE && mE) {
    const d = dist(hand[8], hand[12]);
    if (d < 0.10) return 'hover';
  }

  // Fingers went down → end stroke
  if (state.isPenDown) {
    state.isPenDown = false;
    return 'idle';
  }

  return 'idle';
}

// ─── Drawing strokes ─────────────────────────────────────────────────────────
function beginStroke(pt) {
  state.prevPt = pt;
}

function continueStroke(pt) {
  if (!state.prevPt || !ctxDraw) {
    beginStroke(pt);
    return;
  }
  const from = state.prevPt;
  const to = pt;
  if (Math.hypot(to.x - from.x, to.y - from.y) < 1) return;

  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;

  ctxDraw.beginPath();
  ctxDraw.moveTo(from.x, from.y);
  ctxDraw.quadraticCurveTo(from.x, from.y, midX, midY);

  if (cfg.isErasing) {
    ctxDraw.globalCompositeOperation = 'destination-out';
    ctxDraw.strokeStyle = 'rgba(0,0,0,1)';
    ctxDraw.lineWidth = cfg.brushSize * 4;
  } else {
    ctxDraw.globalCompositeOperation = 'source-over';
    ctxDraw.strokeStyle = cfg.color;
    ctxDraw.lineWidth = cfg.brushSize;
  }

  ctxDraw.lineCap = 'round';
  ctxDraw.lineJoin = 'round';
  ctxDraw.stroke();

  state.prevPt = to;
}

function endStroke() {
  if (state.isPenDown || state.prevPt !== null) {
    state.isPenDown = false;
    state.prevPt = null;
    pushSnapshot();
  }
}

// ─── Cursor drawing — large glowing round indicator ──────────────────────────
let cursorPhase = 0;

function drawCursor(hand) {
  if (!ctxCursor || !hand || !hand[8]) return;

  const index = hand[8];
  const x = index.x * window.innerWidth;
  const y = index.y * window.innerHeight;

  cursorPhase = (cursorPhase + 0.1) % (Math.PI * 2);
  const pulse = Math.sin(cursorPhase);

  const brushR = Math.max(6, cfg.brushSize * 0.8);
  const outerR = brushR + 18 + pulse * 3;

  ctxCursor.save();
  ctxCursor.clearRect(0, 0, window.innerWidth, window.innerHeight);

  if (cfg.isErasing) {
    // ── Eraser cursor: large red hollow circle with crosshair ──
    const eraserR = brushR * 3 + pulse * 2;
    ctxCursor.beginPath();
    ctxCursor.arc(x, y, eraserR, 0, Math.PI * 2);
    ctxCursor.strokeStyle = 'rgba(255,100,100,0.8)';
    ctxCursor.lineWidth = 2.5;
    ctxCursor.shadowBlur = 16;
    ctxCursor.shadowColor = 'rgba(255,100,100,0.6)';
    ctxCursor.globalAlpha = 0.9;
    ctxCursor.stroke();

    // Crosshair
    ctxCursor.setLineDash([]);
    ctxCursor.lineWidth = 1.5;
    ctxCursor.globalAlpha = 0.5;
    ctxCursor.strokeStyle = 'rgba(255,100,100,0.7)';
    ctxCursor.beginPath();
    ctxCursor.moveTo(x - 8, y); ctxCursor.lineTo(x + 8, y);
    ctxCursor.stroke();
    ctxCursor.beginPath();
    ctxCursor.moveTo(x, y - 8); ctxCursor.lineTo(x, y + 8);
    ctxCursor.stroke();
  } else if (state.isPenDown) {
    // ── Drawing cursor: solid colored glow ring + center dot ──
    // Outer glow halo
    ctxCursor.beginPath();
    ctxCursor.arc(x, y, outerR + 6, 0, Math.PI * 2);
    ctxCursor.strokeStyle = cfg.color;
    ctxCursor.lineWidth = 1;
    ctxCursor.shadowBlur = 30;
    ctxCursor.shadowColor = cfg.color;
    ctxCursor.globalAlpha = 0.25 + pulse * 0.1;
    ctxCursor.stroke();

    // Main ring
    ctxCursor.beginPath();
    ctxCursor.arc(x, y, outerR, 0, Math.PI * 2);
    ctxCursor.strokeStyle = cfg.color;
    ctxCursor.lineWidth = 3;
    ctxCursor.shadowBlur = 20;
    ctxCursor.shadowColor = cfg.color;
    ctxCursor.globalAlpha = 0.95;
    ctxCursor.stroke();

    // Brush size preview circle (inner)
    ctxCursor.beginPath();
    ctxCursor.arc(x, y, brushR * 0.7, 0, Math.PI * 2);
    ctxCursor.strokeStyle = cfg.color;
    ctxCursor.lineWidth = 1.5;
    ctxCursor.shadowBlur = 10;
    ctxCursor.globalAlpha = 0.6;
    ctxCursor.stroke();

    // Center dot
    ctxCursor.beginPath();
    ctxCursor.arc(x, y, 3, 0, Math.PI * 2);
    ctxCursor.fillStyle = '#ffffff';
    ctxCursor.shadowBlur = 8;
    ctxCursor.shadowColor = '#ffffff';
    ctxCursor.globalAlpha = 1;
    ctxCursor.fill();
  } else {
    // ── Hover/Idle cursor: spinning dashed glow ring + center dot ──
    // Outer glow
    ctxCursor.beginPath();
    ctxCursor.arc(x, y, outerR + 4, 0, Math.PI * 2);
    ctxCursor.strokeStyle = 'rgba(255,255,255,0.15)';
    ctxCursor.lineWidth = 1;
    ctxCursor.shadowBlur = 20;
    ctxCursor.shadowColor = 'rgba(255,255,255,0.3)';
    ctxCursor.globalAlpha = 0.4 + pulse * 0.15;
    ctxCursor.stroke();

    // Spinning dashed ring
    ctxCursor.beginPath();
    ctxCursor.arc(x, y, outerR, 0, Math.PI * 2);
    ctxCursor.setLineDash([6, 7]);
    ctxCursor.lineDashOffset = -cursorPhase * 10;
    ctxCursor.strokeStyle = 'rgba(255,255,255,0.7)';
    ctxCursor.lineWidth = 2;
    ctxCursor.shadowBlur = 12;
    ctxCursor.shadowColor = 'rgba(255,255,255,0.5)';
    ctxCursor.globalAlpha = 0.8;
    ctxCursor.stroke();

    // Center dot with current color
    ctxCursor.setLineDash([]);
    ctxCursor.beginPath();
    ctxCursor.arc(x, y, 3, 0, Math.PI * 2);
    ctxCursor.fillStyle = cfg.color;
    ctxCursor.shadowBlur = 10;
    ctxCursor.shadowColor = cfg.color;
    ctxCursor.globalAlpha = 1;
    ctxCursor.fill();

    // Inner ring showing brush size
    ctxCursor.beginPath();
    ctxCursor.arc(x, y, brushR * 0.7, 0, Math.PI * 2);
    ctxCursor.strokeStyle = cfg.color;
    ctxCursor.lineWidth = 1;
    ctxCursor.shadowBlur = 6;
    ctxCursor.shadowColor = cfg.color;
    ctxCursor.globalAlpha = 0.4;
    ctxCursor.stroke();
  }

  ctxCursor.restore();
}

// ─── Render loop — runs detection + drawing in RAF ───────────────────────────
function renderLoop() {
  animFrameId = requestAnimationFrame(renderLoop);

  if (!ctxOut || !ctxDraw || !canvasOut || !canvasDraw || !videoEl) return;

  const w = canvasOut.width;
  const h = canvasOut.height;

  // --- Hand detection ---
  if (handLandmarker && videoEl.readyState >= 2) {
    const now = videoEl.currentTime;
    if (now !== lastVideoTime) {
      lastVideoTime = now;
      try {
        const results = handLandmarker.detectForVideo(videoEl, performance.now());
        if (results.landmarks && results.landmarks.length > 0) {
          state.hands = results.landmarks.map(lm => smoothLandmarks(lm));
        } else {
          state.hands = [];
          landmarkBuffer.length = 0;
        }
      } catch (_) {
        // Swallow frame errors
      }
    }
  }

  // --- Draw camera feed (bright, no heavy darkening) ---
  ctxOut.clearRect(0, 0, w, h);
  ctxOut.drawImage(videoEl, 0, 0, w, h);

  // Very subtle darken — just enough so strokes are visible
  ctxOut.fillStyle = 'rgba(0,0,0,0.06)';
  ctxOut.fillRect(0, 0, w, h);

  // --- FPS counter ---
  state.frameCount++;
  const t = performance.now();
  if (t - state.lastFpsTime >= 1000) {
    const fpsEl = document.getElementById('fps-counter');
    if (fpsEl) fpsEl.textContent = state.frameCount + ' FPS';
    state.frameCount = 0;
    state.lastFpsTime = t;
  }

  // --- Clear cursor canvas ---
  if (ctxCursor) {
    ctxCursor.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  const hand = state.hands[0];

  if (hand) {
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    if (dot && !dot.classList.contains('connected')) dot.classList.add('connected');
    if (txt) txt.textContent = 'Hand tracked';

    const gesture = classifyGesture(hand);
    const badge = document.getElementById('mode-badge');

    if (gesture === 'draw') {
      const lm = hand[8]; // index fingertip
      const pt = { x: lm.x * w, y: lm.y * h };

      if (state.prevPt === null) {
        beginStroke(pt);
      } else {
        continueStroke(pt);
      }

      if (badge) {
        badge.textContent = '✏ DRAW';
        badge.className = 'mode-badge draw';
      }
    } else if (gesture === 'hover') {
      endStroke();
      state.prevPt = null;
      if (badge) {
        badge.textContent = '👆 HOVER';
        badge.className = 'mode-badge hover';
      }
    } else {
      endStroke();
      state.prevPt = null;
      if (badge) {
        badge.textContent = '';
        badge.className = 'mode-badge';
      }
    }

    drawCursor(hand);
  } else {
    endStroke();
    state.prevPt = null;

    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    if (dot) dot.classList.remove('connected');
    if (txt) txt.textContent = 'No hand detected';

    const badge = document.getElementById('mode-badge');
    if (badge) {
      badge.textContent = '';
      badge.className = 'mode-badge';
    }
  }
}

// ─── Error display ───────────────────────────────────────────────────────────
function updateError(msg) {
  console.error('[HandTracker]', msg);
  const el = document.getElementById('tracking-error');
  if (el) {
    el.textContent = msg;
    el.style.display = 'flex';
  }
}

function updateStatus(msg) {
  const txt = document.getElementById('status-text');
  if (txt) txt.textContent = msg;
}

// ─── Start camera with HIGH QUALITY stream ───────────────────────────────────
async function startCamera() {
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  // Request the highest quality available — browser picks the closest match
  const constraints = {
    video: {
      facingMode: 'user',
      width: { ideal: isMobile ? 1280 : 1920 },
      height: { ideal: isMobile ? 720 : 1080 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  };

  stream = await navigator.mediaDevices.getUserMedia(constraints);
  videoEl.srcObject = stream;
  await videoEl.play();

  // Log the ACTUAL resolution the camera gave us
  console.log('[HandTracker] Camera started:', videoEl.videoWidth, 'x', videoEl.videoHeight);
}

// ─── Initialize MediaPipe HandLandmarker ─────────────────────────────────────
async function initMediaPipe() {
  console.log('[HandTracker] Loading MediaPipe Tasks Vision...');
  updateStatus('Loading AI model...');

  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  );
  console.log('[HandTracker] WASM loaded');

  // Try GPU first, fall back to CPU if GPU fails (some mobile GPUs crash)
  try {
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: '/models/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    console.log('[HandTracker] HandLandmarker ready (GPU)');
  } catch (gpuErr) {
    console.warn('[HandTracker] GPU delegate failed, falling back to CPU:', gpuErr.message);
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: '/models/hand_landmarker.task',
        delegate: 'CPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    console.log('[HandTracker] HandLandmarker ready (CPU fallback)');
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function init(dom) {
  videoEl = dom.video;
  canvasOut = dom.canvasOut;
  canvasDraw = dom.canvasDraw;

  ctxOut = canvasOut.getContext('2d');
  ctxDraw = canvasDraw.getContext('2d', { willReadFrequently: true });
  ctxCursor = dom.canvasCursor ? dom.canvasCursor.getContext('2d') : null;

  handleResize();
  window.addEventListener('resize', handleResize);

  // Start render loop immediately
  if (!animFrameId) {
    animFrameId = requestAnimationFrame(renderLoop);
  }

  // Async init: camera → MediaPipe → start detecting
  async function boot() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        updateError('Camera requires HTTPS. Open this page over https:// or on localhost.');
        return;
      }

      await startCamera();
      await initMediaPipe();

      updateStatus('Show your hand to start drawing');
    } catch (err) {
      console.error('[HandTracker] Init failed:', err);
      if (err.name === 'NotAllowedError') {
        updateError('Camera access denied. Please allow camera access and reload.');
      } else if (err.name === 'NotFoundError') {
        updateError('No camera found. Please connect a camera and reload.');
      } else {
        updateError('Failed to start: ' + (err.message || err));
      }
    }
  }

  boot();

  return { undo, clear: clearCanvas, download, getUndoCount: () => state.undoHistory.length, setConfig, destroy };
}

function setConfig(newCfg) {
  if (newCfg.color !== undefined) cfg.color = newCfg.color;
  if (newCfg.brushSize !== undefined) cfg.brushSize = newCfg.brushSize;
  if (newCfg.isErasing !== undefined) cfg.isErasing = newCfg.isErasing;
}

function destroy() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  if (handLandmarker) {
    handLandmarker.close();
    handLandmarker = null;
  }
  window.removeEventListener('resize', handleResize);
}
