import React from 'react';
import { type Track } from '../api';
import { type PresetLibraryData } from '../realtime/project';
import { deepMergePreset } from '../lib/presets';
import { DeferredRange } from './controls';
import { PresetPicker } from './PresetPicker';

const WAVE_OPTIONS = ['sine', 'square', 'saw', 'triangle'] as const;

function setNestedValue(obj: Record<string, unknown> | unknown[], path: string[], value: unknown): Record<string, unknown> | unknown[] {
  if (path.length === 0) return obj;
  const [head, ...rest] = path;
  const key = /^\d+$/.test(head) ? Number(head) : head;
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  if (rest.length === 0) {
    (clone as Record<string, unknown>)[String(key)] = value;
    return clone;
  }
  const current = (clone as Record<string, unknown>)[String(key)];
  const nextIsArray = /^\d+$/.test(rest[0]);
  const child = current && typeof current === 'object' ? current as Record<string, unknown> | unknown[] : nextIsArray ? [] : {};
  (clone as Record<string, unknown>)[String(key)] = setNestedValue(child, rest, value);
  return clone;
}

export function SynthEditor({ track, trackIndex, presets, onPatchTrack, onClose, renderTrackIcon }: {
  track: Track;
  trackIndex: number;
  presets: PresetLibraryData | null;
  onPatchTrack: (index: number, patch: Partial<Track>) => void;
  onClose: () => void;
  renderTrackIcon: (track: Track, size: number) => React.ReactNode;
}) {
  const basePreset = (presets?.presets.find(p => p.name === track.preset) || {}) as Record<string, unknown>;
  const overrides = (track.synth_params || {}) as Record<string, unknown>;
  const merged = deepMergePreset(basePreset, overrides);
  const oscs = o3Oscillators(merged);
  const env = (merged.amp_envelope as Record<string, unknown>) || {};

  function update(path: string[], value: unknown) {
    if (path[0] === 'oscillators' && path.length === 3) {
      const index = Number(path[1]);
      const key = path[2];
      const nextOscs = o3Oscillators(merged);
      nextOscs[index] = { ...nextOscs[index], [key]: value };
      onPatchTrack(trackIndex, { synth_params: { ...overrides, oscillators: nextOscs } });
      return;
    }
    const updated = setNestedValue((track.synth_params as Record<string, unknown>) || {}, path, value) as Record<string, unknown>;
    onPatchTrack(trackIndex, { synth_params: updated });
  }

  function resetSection(key: string) {
    const next = { ...overrides };
    delete next[key];
    onPatchTrack(trackIndex, { synth_params: Object.keys(next).length ? next : null });
  }

  const hasOverride = (key: string) => key in overrides;

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="synth-editor o3-panel" onClick={e => e.stopPropagation()}>
      <div className="synth-editor-title o3-titlebar">
        <div className="o3-title-left">
          {renderTrackIcon(track, 22)}
          <strong>3x Osc</strong>
          <span>{track.name}</span>
        </div>
        <PresetPicker presets={presets} value={track.preset} engine="o3" className="synth-preset-select" onChange={name => onPatchTrack(trackIndex, { preset: name || undefined, synth_params: null })} />
      </div>

      <section className={`synth-section o3-osc-section${hasOverride('oscillators') ? ' overridden' : ''}`}>
        <h3>O3 发声装置{hasOverride('oscillators') && <><span className="override-dot" /><button className="reset-section-btn" onClick={() => resetSection('oscillators')}>↺</button></>}</h3>
        <div className="o3-osc-stack">
          {oscs.map((osc, i) => <div key={i} className="o3-osc-strip">
            <div className="o3-osc-index">{i + 1}</div>
            <div className="o3-wave-bank" aria-label={`Osc ${i + 1} 波形`}>
              {WAVE_OPTIONS.map(wave => <WaveButton key={wave} wave={wave} active={String(osc.wave || 'sine') === wave} onClick={() => update(['oscillators', String(i), 'wave'], wave)} />)}
            </div>
            <div className="o3-fader-bank">
              <O3Fader label="倍频" min={0.1} max={8} step={0.01} value={Number(osc.ratio ?? 1)} onChange={v => update(['oscillators', String(i), 'ratio'], v)} />
              <O3Fader label="混合" min={0} max={2} step={0.01} value={Number(osc.gain ?? 1)} onChange={v => update(['oscillators', String(i), 'gain'], v)} />
            </div>
            <div className="o3-knob-bank">
              <O3Knob label="倍频" value={Number(osc.ratio ?? 1)} min={0.1} max={8} step={0.01} onChange={v => update(['oscillators', String(i), 'ratio'], v)} />
              <O3Knob label="微调" value={Number(osc.detune_cents ?? 0)} min={-100} max={100} step={1} onChange={v => update(['oscillators', String(i), 'detune_cents'], v)} />
              <O3Knob label="音量" value={Number(osc.gain ?? 1)} min={0} max={2} step={0.01} onChange={v => update(['oscillators', String(i), 'gain'], v)} />
            </div>
          </div>)}
        </div>
      </section>

      <section className={`synth-section o3-bottom-section${hasOverride('amp_envelope') ? ' overridden' : ''}`}>
        <h3>包络 (ADSR){hasOverride('amp_envelope') && <><span className="override-dot" /><button className="reset-section-btn" onClick={() => resetSection('amp_envelope')}>↺</button></>}</h3>
        <div className="adsr-grid">
          {(['attack', 'decay', 'sustain', 'release'] as const).map(k => <label key={k}>
            {k.toUpperCase()}
            <DeferredRange min={0} max={k === 'sustain' ? 1 : 5} step={0.001} value={Number(env[k] ?? 0)} onCommit={v => update(['amp_envelope', k], v)} />
            <span className="param-val">{Number(env[k] ?? 0).toFixed(3)}</span>
          </label>)}
        </div>
      </section>

      <section className={`synth-section o3-output-section${hasOverride('output_gain') ? ' overridden' : ''}`}>
        <label>输出增益 {Number(merged.output_gain ?? 0.3).toFixed(2)}
          {hasOverride('output_gain') && <><span className="override-dot" /><button className="reset-section-btn" onClick={() => resetSection('output_gain')}>↺</button></>}
          <DeferredRange min={0} max={1.5} step={0.01} value={Number(merged.output_gain ?? 0.3)} onCommit={v => update(['output_gain'], v)} />
        </label>
      </section>

      <div className="button-row" style={{ marginTop: 16 }}>
        <button onClick={() => onPatchTrack(trackIndex, { synth_params: null })}>重置默认</button>
        <button className="primary" onClick={onClose}>完成</button>
      </div>
    </div>
  </div>;
}

function WaveButton({ wave, active, onClick }: { wave: typeof WAVE_OPTIONS[number]; active: boolean; onClick: () => void }) {
  return <button type="button" className={`o3-wave-btn ${active ? 'active' : ''}`} title={wave} onClick={onClick}>
    <WaveIcon wave={wave} />
  </button>;
}

function WaveIcon({ wave }: { wave: typeof WAVE_OPTIONS[number] }) {
  const paths = {
    sine: 'M2 14 C8 2 12 2 18 14 S28 26 34 14',
    square: 'M3 22 V8 H15 V22 H27 V8 H35',
    saw: 'M3 22 L18 8 V22 L35 8',
    triangle: 'M3 22 L11 8 L19 22 L27 8 L35 22'
  };
  return <svg viewBox="0 0 38 30" aria-hidden="true">
    <path d={paths[wave]} />
  </svg>;
}

function O3Fader({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void;
}) {
  return <label className="o3-fader">
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.currentTarget.value))} />
    <span>{label}</span>
  </label>;
}

function O3Knob({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void;
}) {
  const normalized = max === min ? 0 : (value - min) / (max - min);
  const rotation = -135 + Math.max(0, Math.min(1, normalized)) * 270;
  return <label className="o3-knob">
    <span className="o3-knob-face" style={{ '--knob-rotation': `${rotation}deg` } as React.CSSProperties}>
      <span>{formatKnobValue(value)}</span>
    </span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.currentTarget.value))} />
    <em>{label}</em>
  </label>;
}

function formatKnobValue(value: number): string {
  if (Math.abs(value) >= 10) return String(Math.round(value));
  return Number(value.toFixed(2)).toString();
}

function o3Oscillators(preset: Record<string, unknown>): Record<string, unknown>[] {
  const source = Array.isArray(preset.oscillators) ? preset.oscillators as Record<string, unknown>[] : [];
  const defaults = [
    { wave: 'sine', ratio: 1, gain: 1, detune_cents: 0 },
    { wave: 'sine', ratio: 2, gain: 0, detune_cents: 0 },
    { wave: 'sine', ratio: 0.5, gain: 0, detune_cents: 0 }
  ];
  return defaults.map((osc, index) => ({ ...osc, ...(source[index] || {}) }));
}
