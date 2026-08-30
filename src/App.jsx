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
  const [status, setStatus] = useState('No hand detected');
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

  const modeLabel = mode === 'draw' ? 'DRAW' : mode === 'hover' ? 'HOVER' : '';

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

      <div className="hud">
        <div className="hud-left">
          <div className={`dot ${mode === 'draw' ? 'draw' : mode === 'hover' ? 'hover' : ''}`} />
          <span className="hud-status">{status}</span>
          {modeLabel && <span className={`badge ${mode}`}>{modeLabel}</span>}
        </div>
        <span className="hud-fps">{fps} FPS</span>
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
