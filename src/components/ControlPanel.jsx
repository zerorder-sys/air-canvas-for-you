import { useCallback } from 'react';
import './ControlPanel.css';

const COLORS = [
  { value: '#ff0055', label: 'Red' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#22c55e', label: 'Green' },
  { value: '#eab308', label: 'Yellow' },
  { value: '#ffffff', label: 'White' },
  { value: '#bf5af2', label: 'Neon Purple' },
];

export default function ControlPanel({
  color,
  onColorChange,
  brushSize,
  onBrushSizeChange,
  isErasing,
  onToggleEraser,
  onUndo,
  onClear,
  onDownload,
}) {
  const handleSize = useCallback(
    (e) => onBrushSizeChange(Number(e.target.value)),
    [onBrushSizeChange]
  );

  return (
    <div className="control-panel">
      {/* Color palette */}
      <div className="ctrl-group">
        {COLORS.map((c) => (
          <button
            key={c.value}
            className={`color-btn${color === c.value && !isErasing ? ' active' : ''}`}
            style={{ background: c.value, color: c.value }}
            data-color={c.value}
            title={c.label}
            onClick={() => onColorChange(c.value)}
          />
        ))}
      </div>

      <div className="divider" />

      {/* Brush size */}
      <div className="ctrl-group">
        <div className="slider-wrap">
          <label>Size</label>
          <input
            type="range"
            min="2"
            max="25"
            value={brushSize}
            onChange={handleSize}
          />
          <span className="size-val">{brushSize}px</span>
        </div>
      </div>

      <div className="divider" />

      {/* Action buttons */}
      <div className="ctrl-group">
        <button
          className={`ctrl-btn${isErasing ? ' active' : ''}`}
          onClick={onToggleEraser}
        >
          🧹 Eraser
        </button>
        <button className="ctrl-btn" onClick={onUndo}>
          ↩ Undo
        </button>
        <button className="ctrl-btn danger" onClick={onClear}>
          ✕ Clear
        </button>
        <button className="ctrl-btn download" onClick={onDownload}>
          💾 Save
        </button>
      </div>
    </div>
  );
}
