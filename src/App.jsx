import { useState, useCallback, useRef, useEffect } from 'react';
import Canvas from './components/Canvas';
import ControlPanel from './components/ControlPanel';
import Loading from './components/Loading';

function App() {
  const [color, setColor] = useState('#ff0055');
  const [brushSize, setBrushSize] = useState(6);
  const [isErasing, setIsErasing] = useState(false);
  const [loading, setLoading] = useState(true);

  // Imperative API from hand-tracker (undo, clear, download)
  const apiRef = useRef(null);

  const handleReady = useCallback((api) => {
    apiRef.current = api;
    // Hide loading after model starts
    setTimeout(() => setLoading(false), 2000);
  }, []);

  // Safety net: always dismiss loading after 6s even if init fails
  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 6000);
    return () => clearTimeout(timer);
  }, []);

  // Forward color/brushSize/eraser changes to hand-tracker config
  useEffect(() => {
    const api = apiRef.current;
    if (api && api.setConfig) {
      api.setConfig({ color, brushSize, isErasing });
    }
  }, [color, brushSize, isErasing]);

  const handleUndo = useCallback(() => {
    if (apiRef.current) apiRef.current.undo();
  }, []);

  const handleClear = useCallback(() => {
    if (apiRef.current) apiRef.current.clear();
  }, []);

  const handleDownload = useCallback(() => {
    if (apiRef.current) apiRef.current.download();
  }, []);

  const handleToggleEraser = useCallback(() => {
    setIsErasing((prev) => !prev);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleUndo]);

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      {/* Loading overlay */}
      {loading && <Loading />}

      {/* Camera error overlay */}
      <div id="tracking-error" className="error-overlay" />

      {/* Canvas + video layers (all drawing logic in hand-tracker.js) */}
      <Canvas onReady={handleReady} />

      {/* Status bar — updated by hand-tracker via direct DOM */}
      <div className="status-bar">
        <div id="status-dot" className="status-dot" />
        <span id="status-text" className="status-text">No hand detected</span>
        <span id="mode-badge" className="mode-badge" />
      </div>
      <div id="fps-counter" className="fps-counter">0 FPS</div>
      <div id="pen-status" className="pen-status" />

      {/* Control panel — React manages UI state only */}
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

export default App;
