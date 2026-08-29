/**
 * hand-tracker.js — Vanilla JS hand-tracking drawing engine
 *
 * Architecture (proven pattern from working air canvas projects):
 *   MediaPipe onResults → stores landmarks in plain object
 *   requestAnimationFrame → reads landmarks → gesture classification → canvas drawing
 *
 * Zero React state updates in the hot path. All canvas + DOM manipulation is direct.
 */

// ─── Shared mutable state ────────────────────────────────────────────────────
// Updated by React via setConfig(). Read by the render loop.
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
  velocity: 0,
  frameCount: 0,
  lastFpsTime: performance.now(),
  penUpPrevPt: null, // for smooth transition from pen-up to pen-down
};

let animFrameId = null;
let cameraInstance = null;
let handsInstance = null;

// ─── Pinch thresholds (hysteresis prevents flicker) ──────────────────────────
const PINCH_ENTER = 0.06;
const PINCH_EXIT = 0.09;

// ─── Undo stack ──────────────────────────────────────────────────────────────
const MAX_UNDO = 30;

function pushSnapshot() {
  if (!canvasDraw || !ctxDraw) return;
  state.undoHistory.push(ctxDraw.getImageData(0, 0, canvasDraw.width, canvasDraw.height));
  if (state.undoHistory.length > MAX_UNDO) state.undoHistory.shift();
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

  // Dark background
  mCtx.fillStyle = '#0a0a0f';
  mCtx.fillRect(0, 0, merge.width, merge.height);

  // Camera feed (mirrored to match on-screen appearance)
  mCtx.save();
  mCtx.translate(merge.width, 0);
  mCtx.scale(-1, 1);
  mCtx.drawImage(videoEl, 0, 0, merge.width, merge.height);
  mCtx.restore();

  // Slight dim overlay
  mCtx.fillStyle = 'rgba(10,10,15,0.25)';
  mCtx.fillRect(0, 0, merge.width, merge.height);

  // Drawing layer (canvas already has CSS mirror, so draw raw → matches screen)
  mCtx.drawImage(canvasDraw, 0, 0);

  const link = document.createElement('a');
  link.download = `air-canvas-${Date.now()}.png`;
  link.href = merge.toDataURL('image/png');
  link.click();
}

function getUndoCount() {
  return state.undoHistory.length;
}

// ─── Resize handler ──────────────────────────────────────────────────────────
function handleResize() {
  if (!canvasOut || !canvasDraw) return;
  const w = window.innerWidth;
  const h = window.innerHeight;

  for (const c of [canvasOut, canvasDraw]) {
    // Save drawing content
    let saved = null;
    if (c.width > 0 && c.height > 0) {
      const ctx = c.getContext('2d');
      try {
        saved = ctx.getImageData(0, 0, c.width, c.height);
      } catch (_) {}
    }

    c.width = w;
    c.height = h;
    c.style.width = w + 'px';
    c.style.height = h + 'px';

    // Restore drawing content
    if (saved) {
      const ctx = c.getContext('2d');
      ctx.putImageData(saved, 0, 0);
    }
  }
}

// ─── Finger extension detection (distance-from-wrist, more robust than tip<pip) ──
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function fingerExtended(hand, tipIdx, mcpIdx) {
  return dist(hand[tipIdx], hand[0]) > dist(hand[mcpIdx], hand[0]) * 1.2;
}

// ─── Gesture classifier ──────────────────────────────────────────────────────
// Returns 'pinch-draw' | 'hover' | 'idle'
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
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < 1) return;

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

// ─── Cursor drawing (on cursorCanvas, cleared each frame) ────────────────────
let cursorPhase = 0;

function drawCursor(hand) {
  if (!ctxCursor || !hand || !hand[8]) return;

  const index = hand[8];
  // Mirror x to match the CSS-mirrored video/canvas appearance
  const x = (1 - index.x) * window.innerWidth;
  const y = index.y * window.innerHeight;

  cursorPhase = (cursorPhase + 0.12) % (Math.PI * 2);
  const pulse = Math.sin(cursorPhase);
  const r = Math.max(8, cfg.brushSize * 0.6 + 6 + pulse * 1.5);

  ctxCursor.save();
  ctxCursor.clearRect(0, 0, window.innerWidth, window.innerHeight);

  if (state.isPenDown) {
    // Drawing: solid colored ring + center dot
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
    // Not drawing: spinning dashed ring
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

// ─── Render loop (separate from MediaPipe — this is the key architectural fix) ──
function renderLoop() {
  animFrameId = requestAnimationFrame(renderLoop);

  if (!ctxOut || !ctxDraw || !canvasOut || !canvasDraw) return;

  const w = canvasOut.width;
  const h = canvasOut.height;

  // Clear overlays
  ctxOut.clearRect(0, 0, w, h);

  // Draw camera feed (mirrored so it looks like a selfie mirror)
  ctxOut.save();
  ctxOut.translate(w, 0);
  ctxOut.scale(-1, 1);
  ctxOut.drawImage(videoEl, 0, 0, w, h);
  ctxOut.restore();

  // Slight darken so strokes pop
  ctxOut.fillStyle = 'rgba(0,0,0,0.12)';
  ctxOut.fillRect(0, 0, w, h);

  // FPS counter (direct DOM, zero React)
  state.frameCount++;
  const now = performance.now();
  if (now - state.lastFpsTime >= 1000) {
    const fpsEl = document.getElementById('fps-counter');
    if (fpsEl) fpsEl.textContent = state.frameCount + ' FPS';
    state.frameCount = 0;
    state.lastFpsTime = now;
  }

  // Clear cursor canvas
  if (ctxCursor) {
    ctxCursor.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  const hand = state.hands[0];

  if (hand) {
    // Update status bar (direct DOM, zero React)
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
    // No hand
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

  // Pen indicator
  const penEl = document.getElementById('pen-status');
  if (penEl) penEl.textContent = state.isPenDown ? 'DOWN ●' : 'UP';
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize the hand tracker.
 * @param {object} dom — { video, canvasOut, canvasDraw, canvasCursor }
 * @returns {{ undo, clear, download, getUndoCount, destroy }}
 */
export function init(dom) {
  videoEl = dom.video;
  canvasOut = dom.canvasOut;
  canvasDraw = dom.canvasDraw;

  ctxOut = canvasOut.getContext('2d');
  ctxDraw = canvasDraw.getContext('2d');
  ctxCursor = dom.canvasCursor ? dom.canvasCursor.getContext('2d') : null;

  // Size canvases
  handleResize();
  window.addEventListener('resize', handleResize);

  // Check secure context
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const msg = window.isSecureContext
      ? 'Camera API not available on this device.'
      : 'Camera requires HTTPS. Open this page over https:// or on localhost.';
    updateError(msg);
    return { undo, clear: () => { clearCanvas(); return 0; }, download, getUndoCount, setConfig, destroy };
  }

  // Start MediaPipe + Camera
  startMediaPipe();

  // Start render loop
  if (!animFrameId) {
    animFrameId = requestAnimationFrame(renderLoop);
  }

  return { undo, clear: clearCanvas, download, getUndoCount, destroy };
}

function updateError(msg) {
  const el = document.getElementById('tracking-error');
  if (el) {
    el.textContent = msg;
    el.style.display = 'flex';
  }
}

function startMediaPipe() {
  console.log('[HandTracker] Starting MediaPipe...');
  console.log('[HandTracker] Hands available:', typeof Hands !== 'undefined');
  console.log('[HandTracker] Camera available:', typeof Camera !== 'undefined');

  // eslint-disable-next-line no-undef
  if (typeof Hands === 'undefined') {
    console.error('[HandTracker] MediaPipe Hands not loaded');
    updateError('MediaPipe failed to load. Check your internet connection.');
    return;
  }

  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  // eslint-disable-next-line no-undef
  handsInstance = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  handsInstance.setOptions({
    maxNumHands: 1,
    modelComplexity: isMobile ? 0 : 1,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  handsInstance.onResults((results) => {
    // Store landmarks — the render loop reads them
    const handCount = results.multiHandLandmarks ? results.multiHandLandmarks.length : 0;
    if (handCount > 0) {
      console.log('[HandTracker] Hands detected:', handCount);
    }
    state.hands = results.multiHandLandmarks || [];
  });

  // eslint-disable-next-line no-undef
  cameraInstance = new Camera(videoEl, {
    onFrame: async () => {
      if (handsInstance && videoEl) {
        try {
          await handsInstance.send({ image: videoEl });
        } catch (_) {
          // Swallow isolated frame errors to keep pipeline alive
        }
      }
    },
    width: isMobile ? 640 : 1280,
    height: isMobile ? 480 : 720,
    facingMode: 'user',
  });

  cameraInstance.start().then(() => {
    console.log('[HandTracker] Camera started successfully');
  }).catch((err) => {
    console.error('[HandTracker] Camera start failed:', err);
    updateError('Camera access denied. Please allow camera access and reload.');
  });
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
  if (cameraInstance) {
    cameraInstance.stop();
    cameraInstance = null;
  }
  if (handsInstance) {
    handsInstance.close();
    handsInstance = null;
  }
  window.removeEventListener('resize', handleResize);
}
