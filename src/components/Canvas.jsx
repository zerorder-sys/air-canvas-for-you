import { useRef, useEffect } from 'react';
import { init } from '../hand-tracker';
import './Canvas.css';

export default function Canvas({ onReady, onError, onApiReady }) {
  const videoRef = useRef(null);
  const canvasOutRef = useRef(null);
  const canvasDrawRef = useRef(null);
  const canvasCursorRef = useRef(null);

  useEffect(() => {
    if (!videoRef.current || !canvasOutRef.current || !canvasDrawRef.current) return;

    const api = init(
      {
        video: videoRef.current,
        canvasOut: canvasOutRef.current,
        canvasDraw: canvasDrawRef.current,
        canvasCursor: canvasCursorRef.current,
      },
      {
        onReady: () => {
          if (onReady) onReady();
        },
        onError: (msg) => {
          if (onError) onError(msg);
        },
      }
    );

    if (onApiReady) onApiReady(api);

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
