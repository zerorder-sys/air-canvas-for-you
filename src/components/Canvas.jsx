import { useRef, useEffect } from 'react';
import { init } from '../hand-tracker';
import './Canvas.css';

/**
 * Canvas component — mounts DOM elements and hands off all drawing
 * logic to the vanilla JS hand-tracker module. Zero React state
 * in the hot path; React only mounts the DOM tree.
 */
export default function Canvas({ onReady }) {
  const videoRef = useRef(null);
  const canvasOutRef = useRef(null);
  const canvasDrawRef = useRef(null);
  const canvasCursorRef = useRef(null);

  useEffect(() => {
    if (!videoRef.current || !canvasOutRef.current || !canvasDrawRef.current) return;

    const api = init({
      video: videoRef.current,
      canvasOut: canvasOutRef.current,
      canvasDraw: canvasDrawRef.current,
      canvasCursor: canvasCursorRef.current,
    });

    if (onReady) onReady(api);

    return () => {
      if (api && api.destroy) api.destroy();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="canvas-container">
      <video
        ref={videoRef}
        className="input-video"
        autoPlay
        playsInline
        muted
      />
      <canvas ref={canvasOutRef} className="output-canvas" />
      <canvas ref={canvasDrawRef} className="draw-canvas" />
      <canvas ref={canvasCursorRef} className="cursor-canvas" />
    </div>
  );
}
