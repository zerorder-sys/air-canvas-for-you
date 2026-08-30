import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const MODEL_URL = '/models/hand_landmarker.task';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const SMOOTH_FRAMES = 3;
const MAX_UNDO = 30;

export function createHandTracker(videoEl, drawCanvas, cursorCanvas, callbacks) {
  const { onReady, onError, onStatus, onMode, onFps } = callbacks;

  let drawCtx = drawCanvas.getContext('2d', { willReadFrequently: true });
  let cursorCtx = cursorCanvas.getContext('2d');
  let handLandmarker = null;
  let stream = null;
  let rafId = null;
  let lastVideoTime = -1;
  let frameCount = 0;
  let lastFpsTime = performance.now();

  const cfg = { color: '#ff0055', brushSize: 6, isErasing: false };

  let isPenDown = false;
  let prevPoint = null;
  const undoStack = [];

  const landmarkBuffer = [];
  let cursorPhase = 0;

  function smoothLandmarks(raw) {
    landmarkBuffer.push(raw.map(l => ({ x: l.x, y: l.y, z: l.z })));
    if (landmarkBuffer.length > SMOOTH_FRAMES) landmarkBuffer.shift();
    if (landmarkBuffer.length === 1) return raw;
    const n = landmarkBuffer.length;
    return raw.map((_, i) => ({
      x: landmarkBuffer.reduce((s, f) => s + f[i].x, 0) / n,
      y: landmarkBuffer.reduce((s, f) => s + f[i].y, 0) / n,
      z: landmarkBuffer.reduce((s, f) => s + f[i].z, 0) / n,
    }));
  }

  function pushUndo() {
    try {
      undoStack.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
      if (undoStack.length > MAX_UNDO) undoStack.shift();
    } catch {}
  }

  function fingerExtended(hand, tipIdx, pipIdx) {
    const tip = hand[tipIdx];
    const pip = hand[pipIdx];
    const wrist = hand[0];
    return Math.hypot(tip.x - wrist.x, tip.y - wrist.y) >
           Math.hypot(pip.x - wrist.x, pip.y - wrist.y) * 1.15;
  }

  function classifyGesture(hand) {
    const indexUp = fingerExtended(hand, 8, 6);
    const middleUp = fingerExtended(hand, 12, 10);

    if (indexUp && !middleUp) {
      if (!isPenDown) isPenDown = true;
      return 'draw';
    }
    if (isPenDown && indexUp && middleUp) {
      isPenDown = false;
      return 'hover';
    }
    if (indexUp && middleUp) {
      const d = Math.hypot(hand[8].x - hand[12].x, hand[8].y - hand[12].y);
      if (d < 0.08) return 'hover';
    }
    if (isPenDown) {
      isPenDown = false;
      return 'idle';
    }
    return 'idle';
  }

  function drawStroke(from, to) {
    drawCtx.beginPath();
    drawCtx.moveTo(from.x, from.y);
    drawCtx.lineTo(to.x, to.y);
    if (cfg.isErasing) {
      drawCtx.globalCompositeOperation = 'destination-out';
      drawCtx.strokeStyle = 'rgba(0,0,0,1)';
      drawCtx.lineWidth = cfg.brushSize * 4;
    } else {
      drawCtx.globalCompositeOperation = 'source-over';
      drawCtx.strokeStyle = cfg.color;
      drawCtx.lineWidth = cfg.brushSize;
    }
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';
    drawCtx.stroke();
  }

  function endStroke() {
    if (isPenDown || prevPoint !== null) {
      isPenDown = false;
      prevPoint = null;
      pushUndo();
    }
  }

  function drawCursor(x, y, gesture) {
    cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
    cursorCtx.save();

    const brushR = Math.max(4, cfg.brushSize * 0.7);

    if (gesture === 'draw') {
      cursorCtx.beginPath();
      cursorCtx.arc(x, y, brushR, 0, Math.PI * 2);
      cursorCtx.fillStyle = cfg.color;
      cursorCtx.globalAlpha = 0.9;
      cursorCtx.fill();
      cursorCtx.beginPath();
      cursorCtx.arc(x, y, 3, 0, Math.PI * 2);
      cursorCtx.fillStyle = '#fff';
      cursorCtx.globalAlpha = 1;
      cursorCtx.fill();
    } else if (gesture === 'hover') {
      cursorPhase = (cursorPhase + 0.08) % (Math.PI * 2);
      const pulse = Math.sin(cursorPhase);
      const r = brushR + 12 + pulse * 3;
      cursorCtx.beginPath();
      cursorCtx.arc(x, y, r, 0, Math.PI * 2);
      cursorCtx.strokeStyle = 'rgba(255,255,255,0.7)';
      cursorCtx.lineWidth = 2;
      cursorCtx.setLineDash([5, 5]);
      cursorCtx.lineDashOffset = -cursorPhase * 8;
      cursorCtx.stroke();
      cursorCtx.setLineDash([]);
      cursorCtx.beginPath();
      cursorCtx.arc(x, y, 3, 0, Math.PI * 2);
      cursorCtx.fillStyle = cfg.color;
      cursorCtx.fill();
    } else {
      cursorCtx.beginPath();
      cursorCtx.arc(x, y, 8, 0, Math.PI * 2);
      cursorCtx.strokeStyle = 'rgba(255,255,255,0.3)';
      cursorCtx.lineWidth = 1.5;
      cursorCtx.stroke();
      cursorCtx.beginPath();
      cursorCtx.arc(x, y, 2, 0, Math.PI * 2);
      cursorCtx.fillStyle = 'rgba(255,255,255,0.5)';
      cursorCtx.fill();
    }

    cursorCtx.restore();
  }

  function renderLoop() {
    rafId = requestAnimationFrame(renderLoop);

    const w = drawCanvas.width;
    const h = drawCanvas.height;

    if (!handLandmarker || videoEl.readyState < 2) return;

    const now = videoEl.currentTime;
    if (now !== lastVideoTime) {
      lastVideoTime = now;
      try {
        const results = handLandmarker.detectForVideo(videoEl, performance.now());
        const hands = results.landmarks && results.landmarks.length > 0
          ? results.landmarks.map(lm => smoothLandmarks(lm))
          : [];

        if (hands.length === 0) {
          landmarkBuffer.length = 0;
          endStroke();
          if (onStatus) onStatus('No hand detected');
          if (onMode) onMode('idle');
          drawCursor(w / 2, h / 2, 'idle');
          return;
        }

        const hand = hands[0];
        if (onStatus) onStatus('Hand tracked');

        const gesture = classifyGesture(hand);
        if (onMode) onMode(gesture);

        const tipX = hand[8].x * w;
        const tipY = hand[8].y * h;

        if (gesture === 'draw') {
          if (prevPoint) {
            drawStroke(prevPoint, { x: tipX, y: tipY });
          } else {
            prevPoint = { x: tipX, y: tipY };
          }
        } else {
          endStroke();
        }

        prevPoint = gesture === 'draw' ? { x: tipX, y: tipY } : null;
        drawCursor(tipX, tipY, gesture);
      } catch {}
    }

    frameCount++;
    const t = performance.now();
    if (t - lastFpsTime >= 1000) {
      if (onFps) onFps(frameCount);
      frameCount = 0;
      lastFpsTime = t;
    }
  }

  function handleResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const c of [drawCanvas, cursorCanvas]) {
      c.width = w;
      c.height = h;
    }
  }

  async function startCamera() {
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: isMobile ? 1280 : 1920 },
        height: { ideal: isMobile ? 720 : 1080 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play();
  }

  async function initMediaPipe() {
    if (onStatus) onStatus('Loading AI model...');
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);

    try {
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    } catch {
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    }
  }

  async function boot() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        if (onError) onError('Camera requires HTTPS. Open this page over https:// or on localhost.');
        return;
      }
      await startCamera();
      await initMediaPipe();
      if (onReady) onReady();
    } catch (err) {
      if (onError) {
        if (err.name === 'NotAllowedError') {
          onError('Camera access denied. Please allow camera access and reload.');
        } else if (err.name === 'NotFoundError') {
          onError('No camera found. Please connect a camera and reload.');
        } else {
          onError('Failed to start: ' + (err.message || err));
        }
      }
    }
  }

  function init() {
    handleResize();
    window.addEventListener('resize', handleResize);
    rafId = requestAnimationFrame(renderLoop);
    boot();
  }

  function destroy() {
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (handLandmarker) handLandmarker.close();
    window.removeEventListener('resize', handleResize);
  }

  function undo() {
    if (undoStack.length > 0) {
      drawCtx.putImageData(undoStack.pop(), 0, 0);
    }
    return undoStack.length;
  }

  function clear() {
    pushUndo();
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    return undoStack.length;
  }

  function download() {
    const merge = document.createElement('canvas');
    merge.width = drawCanvas.width;
    merge.height = drawCanvas.height;
    const mCtx = merge.getContext('2d');

    mCtx.fillStyle = '#0a0a0f';
    mCtx.fillRect(0, 0, merge.width, merge.height);

    mCtx.save();
    mCtx.translate(merge.width, 0);
    mCtx.scale(-1, 1);
    mCtx.drawImage(videoEl, 0, 0, merge.width, merge.height);
    mCtx.restore();

    mCtx.fillStyle = 'rgba(10,10,15,0.15)';
    mCtx.fillRect(0, 0, merge.width, merge.height);

    mCtx.save();
    mCtx.translate(merge.width, 0);
    mCtx.scale(-1, 1);
    mCtx.drawImage(drawCanvas, 0, 0);
    mCtx.restore();

    const link = document.createElement('a');
    link.download = `air-canvas-${Date.now()}.png`;
    link.href = merge.toDataURL('image/png');
    link.click();
  }

  function setConfig(newCfg) {
    if (newCfg.color !== undefined) cfg.color = newCfg.color;
    if (newCfg.brushSize !== undefined) cfg.brushSize = newCfg.brushSize;
    if (newCfg.isErasing !== undefined) cfg.isErasing = newCfg.isErasing;
  }

  return { init, destroy, undo, clear, download, setConfig, getUndoCount: () => undoStack.length };
}
