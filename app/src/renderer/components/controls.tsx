import React, { useEffect, useRef, useState } from 'react';
import { clamp, controlAngle } from '../lib/controls';

export function DeferredRange({ value, min, max, step = 1, className, onClick, onCommit }: { value: number; min: number; max: number; step?: number; className?: string; onClick?: (event: React.MouseEvent<HTMLInputElement>) => void; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(value);
  }, [value, dirty]);
  function commit() {
    if (!dirty) return;
    setDirty(false);
    if (draft !== value) onCommit(draft);
  }
  return <input className={className} type="range" min={min} max={max} step={step} value={draft} onClick={onClick} onChange={event => {
    setDirty(true);
    setDraft(Number(event.currentTarget.value));
  }} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />;
}

function Fader({ value, min, max, step = 1, defaultValue, orientation = 'horizontal', className, onClick, onChange }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue: number;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  onClick?: (event: React.MouseEvent<HTMLInputElement>) => void;
  onChange: (value: number) => void;
}) {
  return <input
    className={`control-range ${orientation}${className ? ` ${className}` : ''}`}
    type="range"
    min={min}
    max={max}
    step={step}
    value={value}
    title={`${value}`}
    onClick={onClick}
    onChange={event => onChange(Number(event.currentTarget.value))}
    onDoubleClick={event => {
      event.stopPropagation();
      onChange(defaultValue);
    }}
  />;
}

export function ValueFader({ value, orientation = 'horizontal', className, onClick, onChange }: {
  value: number;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  onClick?: (event: React.MouseEvent<HTMLInputElement>) => void;
  onChange: (value: number) => void;
}) {
  return <Fader value={value} min={0} max={127} defaultValue={96} orientation={orientation} className={className} onClick={onClick} onChange={onChange} />;
}

export function VerticalFader({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return <ValueFader value={value} orientation="vertical" onChange={onChange} />;
}

function Knob({ value, min = 0, max = 127, center, title: titleProp, onChange }: {
  value: number; min?: number; max?: number; center?: number; title?: string;
  onChange: (v: number) => void;
}) {
  const startRef = useRef<{ y: number; v: number } | null>(null);
  const S = 36; const cx = S / 2; const cy = S / 2; const r = 13;
  const START = 135; const RANGE = 270;
  const norm = clamp((value - min) / (max - min), 0, 1);
  const deg = controlAngle(value, min, max, center);
  const toXY = (d: number) => ({ x: cx + r * Math.cos(d * Math.PI / 180), y: cy + r * Math.sin(d * Math.PI / 180) });
  const startPt = toXY(START);
  const trackEnd = toXY(START + RANGE);
  const fillEnd = toXY(deg);
  const largeArc = norm * RANGE > 180 ? 1 : 0;
  const centerNorm = center !== undefined ? (center - min) / (max - min) : undefined;
  const centerPt = centerNorm !== undefined ? toXY(START + centerNorm * RANGE) : null;
  return <svg className="knob" width={S} height={S} aria-label={titleProp}
    style={{ cursor: 'ns-resize', flexShrink: 0 }}
    onMouseDown={e => {
      e.preventDefault();
      startRef.current = { y: e.clientY, v: value };
      const onMove = (ev: MouseEvent) => {
        if (!startRef.current) return;
        const delta = Math.round((startRef.current.y - ev.clientY) * 0.9);
        onChange(Math.max(min, Math.min(max, startRef.current.v + delta)));
      };
      const onUp = () => { startRef.current = null; window.removeEventListener('mousemove', onMove); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp, { once: true });
    }}
    onDoubleClick={() => onChange(center ?? min)}>
    <circle cx={cx} cy={cy} r={r + 2} fill="url(#knob-bg)" stroke="#3a4050" strokeWidth={1} />
    <path d={`M ${startPt.x} ${startPt.y} A ${r} ${r} 0 1 1 ${trackEnd.x} ${trackEnd.y}`}
      stroke="#2a2e38" strokeWidth={3} fill="none" strokeLinecap="round" />
    {norm > 0.005 && <path d={`M ${startPt.x} ${startPt.y} A ${r} ${r} 0 ${largeArc} 1 ${fillEnd.x} ${fillEnd.y}`}
      stroke="#5aa9ff" strokeWidth={3} fill="none" strokeLinecap="round" />}
    {centerPt && <circle cx={centerPt.x} cy={centerPt.y} r={1.5} fill="#556070" />}
    <line x1={cx} y1={cy} x2={fillEnd.x} y2={fillEnd.y} stroke="#c8e8ff" strokeWidth={1.5} strokeLinecap="round" />
    <defs>
      <radialGradient id="knob-bg" cx="40%" cy="35%"><stop offset="0%" stopColor="#5a6070" /><stop offset="100%" stopColor="#2a2e38" /></radialGradient>
    </defs>
  </svg>;
}

export function PanKnob({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return <Knob value={value} min={0} max={127} center={64} title={`Pan: ${value}`} onChange={onChange} />;
}
