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
  brushSize: 6,
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
const landmarkBuffer = []; // Array of last SMOOTH_FRAMES landmark arrays

function smoothLandmarks(raw) {
  landmarkBuffer.push(raw.map(l => ({ x: l.x, y: l.y, z: l.z })));
  if (landmarkBuffer.length > SMOOTH_FRAMES) landmarkBuffer.shift();
  if (landmarkBuffer.length === 1) return raw;

  // Average all buffered frames per landmark
  const count = landmarkBuffer.length;
  return raw.map((_, i) => ({
    x: landmarkBuffer.reduce((s, f) => s + f[i].x, 0) / count,
    y: landmarkBuffer.reduce((s, f) => s + f[i].y, 0) / count,
    z: landmarkBuffer.reduce((s, f) => s + f[i].z, 0) / count,
  }));
}

// ─── Pinch thresholds (hysteresis prevents flicker) ──────────────────────────
const PINCH_ENTER = 0.07;
const PINCH_EXIT = 0.10;

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

  mCtx.fillStyle = 'rgba(10,10,15,0.25)';
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

// ─── Gesture classifier ──────────────────────────────────────────────────────
function classifyGesture(hand) {
  const pinchDist = dist(hand[4], hand[8]); // thumb tip ↔ index tip

  // Pinch → draw
  if (state.isPenDown && pinchDist > PINCH_EXIT) {
    state.isPenDown = false;
    return 'idle';
  }
  if (!state.isPenDown && pinchDist < PINCH_ENTER) {
    state.isPenDown = true;
    return 'pinch-draw';
  }
  if (state.isPenDown) return 'pinch-draw';

  // Index + middle extended close together → hover
  const iE = fingerExtended(hand, 8, 5);
  const mE = fingerExtended(hand, 12, 9);
  if (iE && mE) {
    const d = dist(hand[8], hand[12]);
    if (d < 0.08) return 'hover';
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

// ─── Cursor drawing ──────────────────────────────────────────────────────────
let cursorPhase = 0;

function drawCursor(hand) {
  if (!ctxCursor || !hand || !hand[8]) return;

  const index = hand[8];
  const x = index.x * window.innerWidth;
  const y = index.y * window.innerHeight;

  cursorPhase = (cursorPhase + 0.12) % (Math.PI * 2);
  const pulse = Math.sin(cursorPhase);
  const r = Math.max(8, cfg.brushSize * 0.6 + 6 + pulse * 1.5);

  ctxCursor.save();
  ctxCursor.clearRect(0, 0, window.innerWidth, window.innerHeight);

  if (state.isPenDown) {
    ctxCursor.beginPath();
    ctxCursor.arc(x, y, r * 0.7 + 2, 0, Math.PI * 2);
    ctxCursor.strokeStyle = cfg.color;
    ctxCursor.lineWidth = 2.5;
    ctxCursor.shadowBlur = 14;
    ctxCursor.shadowColor = cfg.color;
    ctxCursor.globalAlpha = 0.9;
    ctxCursor.stroke();

    ctxCursor.beginPath();
    ctxCursor.arc(x, y, 2.5, 0, Math.PI * 2);
    ctxCursor.fillStyle = '#fff';
    ctxCursor.shadowBlur = 4;
    ctxCursor.globalAlpha = 1;
    ctxCursor.fill();
  } else {
    ctxCursor.beginPath();
    ctxCursor.arc(x, y, r, 0, Math.PI * 2);
    ctxCursor.setLineDash([5, 6]);
    ctxCursor.lineDashOffset = -cursorPhase * 8;
    ctxCursor.strokeStyle = 'rgba(255,255,255,0.6)';
    ctxCursor.lineWidth = 1.5;
    ctxCursor.shadowBlur = 5;
    ctxCursor.shadowColor = 'rgba(255,255,255,0.3)';
    ctxCursor.globalAlpha = 0.7;
    ctxCursor.stroke();

    ctxCursor.setLineDash([]);
    ctxCursor.beginPath();
    ctxCursor.arc(x, y, 2, 0, Math.PI * 2);
    ctxCursor.fillStyle = cfg.color;
    ctxCursor.shadowBlur = 4;
    ctxCursor.shadowColor = cfg.color;
    ctxCursor.globalAlpha = 0.9;
    ctxCursor.fill();
  }

  ctxCursor.restore();
}

// ─── Render loop — runs detection + drawing in RAF ───────────────────────────
function renderLoop() {
  animFrameId = requestAnimationFrame(renderLoop);

  if (!ctxOut || !ctxDraw || !canvasOut || !canvasDraw || !videoEl) return;

  const w = canvasOut.width;
  const h = canvasOut.height;

  // --- Hand detection (runs inside RAF, not a separate callback) ---
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
      } catch (err) {
        // Swallow frame errors to keep pipeline alive
      }
    }
  }

  // --- Draw camera feed ---
  ctxOut.clearRect(0, 0, w, h);
  ctxOut.drawImage(videoEl, 0, 0, w, h);
  ctxOut.fillStyle = 'rgba(0,0,0,0.12)';
  ctxOut.fillRect(0, 0, w, h);

  // --- FPS counter (direct DOM, zero React) ---
  state.frameCount++;
  const now = performance.now();
  if (now - state.lastFpsTime >= 1000) {
    const fpsEl = document.getElementById('fps-counter');
    if (fpsEl) fpsEl.textContent = state.frameCount + ' FPS';
    state.frameCount = 0;
    state.lastFpsTime = now;
  }

  // --- Clear cursor canvas ---
  if (ctxCursor) {
    ctxCursor.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  const hand = state.hands[0];

  if (hand) {
    // Update status bar (direct DOM)
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    if (dot && !dot.classList.contains('connected')) dot.classList.add('connected');
    if (txt) txt.textContent = 'Hand tracked';

    const gesture = classifyGesture(hand);
    const badge = document.getElementById('mode-badge');

    if (gesture === 'pinch-draw') {
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

// ─── Start camera stream directly (no Camera utility needed) ─────────────────
async function startCamera() {
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  const constraints = {
    video: {
      facingMode: 'user',
      width: { ideal: isMobile ? 640 : 1280 },
      height: { ideal: isMobile ? 480 : 720 },
    },
    audio: false,
  };

  stream = await navigator.mediaDevices.getUserMedia(constraints);
  videoEl.srcObject = stream;
  await videoEl.play();

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
  console.log('[HandTracker] HandLandmarker ready');
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

  // Start render loop immediately (will wait for handLandmarker to be ready)
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

  return { undo, clear: clearCanvas, download, getUndoCount: () => state.undoHistory.length, destroy };
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
