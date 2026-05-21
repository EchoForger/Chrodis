import React from 'react';
import { type Track } from '../api';
import { type PresetLibraryData } from '../realtime/project';
import { deepMergePreset, normalizeSynthEngine } from '../lib/presets';
import { DeferredRange } from './controls';
import { PresetPicker } from './PresetPicker';

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
  const synthEngine = normalizeSynthEngine(basePreset.synth_engine);
  if (synthEngine === 'o3') {
    return <O3Editor track={track} trackIndex={trackIndex} presets={presets} onPatchTrack={onPatchTrack} onClose={onClose} renderTrackIcon={renderTrackIcon} />;
  }
  const overrides = (track.synth_params || {}) as Record<string, unknown>;
  const merged = deepMergePreset(basePreset, overrides);
  const oscs = Array.isArray(merged.oscillators) ? merged.oscillators as Record<string, unknown>[] : [];
  const env = (merged.amp_envelope as Record<string, unknown>) || {};
  const filt = (merged.filter as Record<string, unknown>) || {};

  function update(path: string[], value: unknown) {
    const updated = setNestedValue((track.synth_params as Record<string, unknown>) || {}, path, value) as Record<string, unknown>;
    onPatchTrack(trackIndex, { synth_params: updated });
  }

  function resetSection(key: string) {
    const next = { ...(overrides) };
    delete next[key];
    onPatchTrack(trackIndex, { synth_params: Object.keys(next).length ? next : null });
  }

  const hasOverride = (key: string) => key in overrides;

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="synth-editor" onClick={e => e.stopPropagation()}>
      <div className="synth-editor-title">
        {renderTrackIcon(track, 22)}
        <strong>{track.name}</strong>
        <PresetPicker presets={presets} value={track.preset} engine="chordsynth" className="synth-preset-select" onChange={name => onPatchTrack(trackIndex, { preset: name || undefined, synth_params: null })} />
      </div>

      <section className={`synth-section${hasOverride('oscillators') ? ' overridden' : ''}`}>
        <h3>振荡器{hasOverride('oscillators') && <><span className="override-dot" />  <button className="reset-section-btn" onClick={() => resetSection('oscillators')}>↺</button></>}</h3>
        {oscs.map((osc, i) => <div key={i} className="osc-row">
          <label>波形<select value={String(osc.wave || 'sine')} onChange={e => update(['oscillators', String(i), 'wave'], e.target.value)}>
            {['sine', 'square', 'saw', 'triangle'].map(w => <option key={w} value={w}>{w}</option>)}
          </select></label>
          <label>倍频<input type="number" step="0.01" min="0.1" max="8" value={Number(osc.ratio ?? 1)} onChange={e => update(['oscillators', String(i), 'ratio'], Number(e.target.value))} /></label>
          <label>增益<DeferredRange min={0} max={2} step={0.01} value={Number(osc.gain ?? 1)} onCommit={v => update(['oscillators', String(i), 'gain'], v)} /></label>
          <label>微调<input type="number" step="1" min="-100" max="100" value={Number(osc.detune_cents ?? 0)} onChange={e => update(['oscillators', String(i), 'detune_cents'], Number(e.target.value))} /></label>
        </div>)}
        {oscs.length === 0 && <div className="empty-state" style={{ fontSize: 12, padding: '8px 0' }}>无振荡器数据</div>}
      </section>

      <section className={`synth-section${hasOverride('amp_envelope') ? ' overridden' : ''}`}>
        <h3>包络 (ADSR){hasOverride('amp_envelope') && <><span className="override-dot" /><button className="reset-section-btn" onClick={() => resetSection('amp_envelope')}>↺</button></>}</h3>
        <div className="adsr-grid">
          {(['attack', 'decay', 'sustain', 'release'] as const).map(k => <label key={k}>
            {k.toUpperCase()}
            <DeferredRange min={0} max={k === 'sustain' ? 1 : 5} step={0.001} value={Number(env[k] ?? 0)} onCommit={v => update(['amp_envelope', k], v)} />
            <span className="param-val">{Number(env[k] ?? 0).toFixed(3)}</span>
          </label>)}
        </div>
      </section>

      <section className={`synth-section${hasOverride('filter') ? ' overridden' : ''}`}>
        <h3>滤波器{hasOverride('filter') && <><span className="override-dot" /><button className="reset-section-btn" onClick={() => resetSection('filter')}>↺</button></>}</h3>
        <label>类型<select value={String(filt.type || 'none')} onChange={e => update(['filter', 'type'], e.target.value)}>
          <option value="none">无</option><option value="lowpass">低通</option>
        </select></label>
        {filt.type === 'lowpass' && <>
          <label>截止频率 {Number(filt.cutoff_hz ?? 5000).toFixed(0)} Hz
            <DeferredRange min={80} max={18000} step={10} value={Number(filt.cutoff_hz ?? 5000)} onCommit={v => update(['filter', 'cutoff_hz'], v)} /></label>
          <label>键位追踪<DeferredRange min={0} max={1} step={0.01} value={Number(filt.key_tracking ?? 0)} onCommit={v => update(['filter', 'key_tracking'], v)} /></label>
        </>}
      </section>

      <section className={`synth-section${hasOverride('output_gain') ? ' overridden' : ''}`}>
        <label>输出增益 {Number(merged.output_gain ?? 0.35).toFixed(2)}
          {hasOverride('output_gain') && <><span className="override-dot" /><button className="reset-section-btn" onClick={() => resetSection('output_gain')}>↺</button></>}
          <DeferredRange min={0} max={1.5} step={0.01} value={Number(merged.output_gain ?? 0.35)} onCommit={v => update(['output_gain'], v)} />
        </label>
      </section>

      <div className="button-row" style={{ marginTop: 16 }}>
        <button onClick={() => onPatchTrack(trackIndex, { synth_params: null })}>重置默认</button>
        <button className="primary" onClick={onClose}>完成</button>
      </div>
    </div>
  </div>;
}

function O3Editor({ track, trackIndex, presets, onPatchTrack, onClose, renderTrackIcon }: {
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
  const oscs = Array.isArray(merged.oscillators) ? merged.oscillators as Record<string, unknown>[] : [{}, {}, {}];
  const env = (merged.amp_envelope as Record<string, unknown>) || {};

  function update(path: string[], value: unknown) {
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
    <div className="synth-editor" onClick={e => e.stopPropagation()}>
      <div className="synth-editor-title">
        {renderTrackIcon(track, 22)}
        <strong>{track.name}</strong>
        <PresetPicker presets={presets} value={track.preset} engine="o3" className="synth-preset-select" onChange={name => onPatchTrack(trackIndex, { preset: name || undefined, synth_params: null })} />
      </div>

      <section className={`synth-section${hasOverride('oscillators') ? ' overridden' : ''}`}>
        <h3>振荡器（固定3个）{hasOverride('oscillators') && <><span className="override-dot" /><button className="reset-section-btn" onClick={() => resetSection('oscillators')}>↺</button></>}</h3>
        {oscs.map((osc, i) => <div key={i} className="osc-row">
          <label>波形<select value={String(osc.wave || 'sine')} onChange={e => update(['oscillators', String(i), 'wave'], e.target.value)}>
            {['sine', 'square', 'saw', 'triangle'].map(w => <option key={w} value={w}>{w}</option>)}
          </select></label>
          <label>倍频<input type="number" step="0.01" min="0.1" max="8" value={Number(osc.ratio ?? 1)} onChange={e => update(['oscillators', String(i), 'ratio'], Number(e.target.value))} /></label>
          <label>增益<DeferredRange min={0} max={2} step={0.01} value={Number(osc.gain ?? 1)} onCommit={v => update(['oscillators', String(i), 'gain'], v)} /></label>
          <label>微调<input type="number" step="1" min="-100" max="100" value={Number(osc.detune_cents ?? 0)} onChange={e => update(['oscillators', String(i), 'detune_cents'], Number(e.target.value))} /></label>
        </div>)}
      </section>

      <section className={`synth-section${hasOverride('amp_envelope') ? ' overridden' : ''}`}>
        <h3>包络 (ADSR){hasOverride('amp_envelope') && <><span className="override-dot" /><button className="reset-section-btn" onClick={() => resetSection('amp_envelope')}>↺</button></>}</h3>
        <div className="adsr-grid">
          {(['attack', 'decay', 'sustain', 'release'] as const).map(k => <label key={k}>
            {k.toUpperCase()}
            <DeferredRange min={0} max={k === 'sustain' ? 1 : 5} step={0.001} value={Number(env[k] ?? 0)} onCommit={v => update(['amp_envelope', k], v)} />
            <span className="param-val">{Number(env[k] ?? 0).toFixed(3)}</span>
          </label>)}
        </div>
      </section>

      <section className={`synth-section${hasOverride('output_gain') ? ' overridden' : ''}`}>
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
