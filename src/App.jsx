import { useState, useCallback, useRef, useEffect } from 'react';
import Canvas from './components/Canvas';
import ControlPanel from './components/ControlPanel';
import Loading from './components/Loading';

function App() {
  const [color, setColor] = useState('#ff0055');
  const [brushSize, setBrushSize] = useState(6);
  const [isErasing, setIsErasing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);

  const apiRef = useRef(null);

  const handleReady = useCallback(() => {
    setLoading(false);
  }, []);

  const handleError = useCallback((msg) => {
    setLoading(false);
    setErrorMsg(msg);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 8000);
    return () => clearTimeout(timer);
  }, []);

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
      {loading && <Loading />}

      {errorMsg && (
        <div className="error-overlay" style={{ display: 'flex' }}>
          <p>{errorMsg}</p>
        </div>
      )}

      <Canvas
        onReady={handleReady}
        onError={handleError}
        onApiReady={(api) => { apiRef.current = api; }}
      />

      <div className="status-bar">
        <div id="status-dot" className="status-dot" />
        <span id="status-text" className="status-text">No hand detected</span>
        <span id="mode-badge" className="mode-badge" />
      </div>
      <div id="fps-counter" className="fps-counter">0 FPS</div>

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
