import { useState, useCallback, useRef, useEffect } from 'react';
import Canvas from './components/Canvas';
import ControlPanel from './components/ControlPanel';
import Loading from './components/Loading';
import './App.css';

export default function App() {
  const [color, setColor] = useState('#ff0055');
  const [brushSize, setBrushSize] = useState(6);
  const [isErasing, setIsErasing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);
  const [status, setStatus] = useState('no-hand');
  const [mode, setMode] = useState('idle');
  const [fps, setFps] = useState(0);

  const trackerRef = useRef(null);

  const handleReady = useCallback(() => setLoading(false), []);

  const handleError = useCallback((msg) => {
    setLoading(false);
    setErrorMsg(msg);
  }, []);

  const handleStatus = useCallback((s) => setStatus(s), []);
  const handleMode = useCallback((m) => setMode(m), []);
  const handleFps = useCallback((f) => setFps(f), []);

  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 8000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (trackerRef.current) trackerRef.current.setConfig({ color, brushSize, isErasing });
  }, [color, brushSize, isErasing]);

  const handleUndo = useCallback(() => {
    if (trackerRef.current) trackerRef.current.undo();
  }, []);

  const handleClear = useCallback(() => {
    if (trackerRef.current) trackerRef.current.clear();
  }, []);

  const handleDownload = useCallback(() => {
    if (trackerRef.current) trackerRef.current.download();
  }, []);

  const handleToggleEraser = useCallback(() => setIsErasing(p => !p), []);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo]);

  const isDrawing = mode === 'draw';
  const isHovering = mode === 'hover';
  const handDetected = status === 'tracked' || isDrawing || isHovering;

  let statusText = 'Show your hand to start';
  let statusIcon = 'hand';
  if (loading) {
    statusText = 'Loading...';
    statusIcon = 'loading';
  } else if (errorMsg) {
    statusText = errorMsg;
    statusIcon = 'error';
  } else if (isDrawing) {
    statusText = 'Drawing...';
    statusIcon = 'draw';
  } else if (isHovering) {
    statusText = 'Hovering - point index finger to draw';
    statusIcon = 'hover';
  } else if (handDetected) {
    statusText = 'Hand detected - raise index finger to draw';
    statusIcon = 'detected';
  }

  return (
    <div className="app">
      {loading && <Loading />}

      {errorMsg && (
        <div className="error-overlay">
          <div className="error-icon" />
          <p className="error-msg">{errorMsg}</p>
        </div>
      )}

      <Canvas
        onReady={handleReady}
        onError={handleError}
        onStatus={handleStatus}
        onMode={handleMode}
        onFps={handleFps}
        trackerRef={trackerRef}
      />

      {/* Prominent centered status indicator */}
      <div className={`status-indicator ${statusIcon}`}>
        <div className="status-dot-lg" />
        <span className="status-label">{statusText}</span>
      </div>

      {/* Branded nav bar */}
      <div className="nav-bar">
        <div className="nav-left">
          <img src="/icon.svg" alt="" className="nav-logo" />
          <span className="nav-title">Air Canvas</span>
        </div>
        <div className="nav-right">
          <div className={`dot ${isDrawing ? 'draw' : isHovering ? 'hover' : handDetected ? 'detected' : ''}`} />
          <span className="nav-fps">{fps} FPS</span>
        </div>
      </div>

      <ControlPanel
        color={color}
        onColorChange={setColor}
        brushSize={brushSize}
        onBrushSizeChange={setBrushSize}
        isErasing={isErasing}
        onToggleEraser={handleToggleEraser}
        onUndo={handleUndo}
        onClear={handleClear}
        onDownload={handleDownload}
      />
    </div>
  );
}
