import { useRef, useEffect } from 'react';
import { createHandTracker } from '../hand-tracker';
import './Canvas.css';

export default function Canvas({ onReady, onError, onStatus, onMode, onFps, trackerRef }) {
  const videoRef = useRef(null);
  const outputRef = useRef(null);
  const drawRef = useRef(null);
  const cursorRef = useRef(null);

  useEffect(() => {
    const v = videoRef.current;
    const o = outputRef.current;
    const d = drawRef.current;
    const c = cursorRef.current;
    if (!v || !o || !d || !c) return;

    const tracker = createHandTracker(v, o, d, c, { onReady, onError, onStatus, onMode, onFps });
    trackerRef.current = tracker;
    tracker.init();

    return () => tracker.destroy();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="canvas-wrap">
      <video ref={videoRef} className="cam" autoPlay playsInline muted />
      <canvas ref={outputRef} className="output-layer" />
      <canvas ref={drawRef} className="draw-layer" />
      <canvas ref={cursorRef} className="cursor-layer" />
    </div>
  );
}
