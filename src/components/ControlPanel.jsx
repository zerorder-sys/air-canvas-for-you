import { useCallback } from 'react';
import './ControlPanel.css';

const COLORS = [
  { value: '#ff0055', label: 'Red' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#22c55e', label: 'Green' },
  { value: '#eab308', label: 'Yellow' },
  { value: '#ffffff', label: 'White' },
  { value: '#bf5af2', label: 'Purple' },
];

const STAMPS = [
  { value: 'circle', icon: '●', label: 'Circle' },
  { value: 'square', icon: '■', label: 'Square' },
  { value: 'triangle', icon: '▲', label: 'Triangle' },
  { value: 'star', icon: '★', label: 'Star' },
  { value: 'heart', icon: '♥', label: 'Heart' },
  { value: 'diamond', icon: '◆', label: 'Diamond' },
];

export default function ControlPanel({
  color, onColorChange,
  brushSize, onBrushSizeChange,
  isErasing, onToggleEraser,
  stamp, onStampChange,
  customStampChar, onCustomStampChange,
  onUndo, onClear, onDownload,
}) {
  const handleSize = useCallback(
    (e) => onBrushSizeChange(Number(e.target.value)),
    [onBrushSizeChange]
  );

  const handleCustomInput = useCallback(
    (e) => {
      const val = e.target.value;
      if (val.length <= 1) {
        onCustomStampChange(val);
        if (val) onStampChange('custom');
      }
    },
    [onCustomStampChange, onStampChange]
  );

  return (
    <div className="ctrl-panel">
      <div className="ctrl-row">
        <div className="ctrl-group colors">
          {COLORS.map((c) => (
            <button
              key={c.value}
              className={`color-btn${color === c.value && !isErasing ? ' active' : ''}`}
              style={{ background: c.value }}
              title={c.label}
              onClick={() => onColorChange(c.value)}
            />
          ))}
        </div>

        <div className="divider" />

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
      </div>

      {stamp && (
        <div className="ctrl-row stamp-row">
          <div className="ctrl-group stamp-picker">
            {STAMPS.map((s) => (
              <button
                key={s.value}
                className={`stamp-btn${stamp === s.value ? ' active' : ''}`}
                title={s.label}
                onClick={() => onStampChange(stamp === s.value ? null : s.value)}
              >
                {s.icon}
              </button>
            ))}
            <input
              type="text"
              className={`custom-stamp-input${stamp === 'custom' ? ' active' : ''}`}
              value={customStampChar}
              onChange={handleCustomInput}
              placeholder="Aa"
              maxLength={1}
              title="Type a letter or emoji"
            />
          </div>
        </div>
      )}

      <div className="ctrl-row">
        <button
          className={`ctrl-btn${stamp ? ' active' : ''}`}
          onClick={() => {
            if (stamp) {
              onStampChange(null);
            } else {
              onStampChange('circle');
              if (isErasing) onToggleEraser();
            }
          }}
        >
          Stamp
        </button>
        <button
          className={`ctrl-btn${isErasing ? ' active' : ''}`}
          onClick={() => {
            onToggleEraser();
            if (stamp) onStampChange(null);
          }}
        >
          Eraser
        </button>
        <button className="ctrl-btn" onClick={onUndo}>Undo</button>
        <button className="ctrl-btn danger" onClick={onClear}>Clear</button>
        <button className="ctrl-btn save" onClick={onDownload}>Save</button>
      </div>
    </div>
  );
}
