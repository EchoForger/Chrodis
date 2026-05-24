import React from 'react';
import { type Track } from '../api';
import { type PresetLibraryData } from '../realtime/project';
import { deepMergePreset, normalizeSynthEngine } from '../lib/presets';
import { DeferredRange } from './controls';
import { PresetPicker } from './PresetPicker';

const WAVE_OPTIONS = ['sine', 'square', 'saw', 'triangle'] as const;
const SERUMIS_WAVES = ['basic', 'mirror', 'metal', 'vowel', 'digital'] as const;
const CORE_ENGINES = ['flexis', 'sytrix', 'harmonis', 'padis', 'drumis'] as const;

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

function SynthHeader({ engine, title, subtitle, track, presets, presetValue, onPreset, onClose, renderTrackIcon }: {
  engine: string;
  title: string;
  subtitle: string;
  track: Track;
  presets: PresetLibraryData | null;
  presetValue: string | undefined;
  onPreset: (name: string | undefined) => void;
  onClose: () => void;
  renderTrackIcon: (track: Track, size: number) => React.ReactNode;
}) {
  return <div className={`synth-hardware-header ${engine}-hardware-header`}>
    <div className="synth-rack-screws" aria-hidden="true"><span /><span /></div>
    <div className="synth-brand-plate">
      <span className="synth-brand-led" />
      <strong>{title}</strong>
      <em>{subtitle}</em>
    </div>
    <div className="synth-track-readout">
      {renderTrackIcon(track, 22)}
      <span>{track.name}</span>
    </div>
    <PresetPicker presets={presets} value={presetValue} engine={engine} className="synth-preset-select" onChange={onPreset} />
    <button type="button" className="synth-header-done" onClick={onClose}>完成</button>
  </div>;
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
  const engine = normalizeSynthEngine(merged.synth_engine);
  if (engine === 'serumis') {
    return <SerumisEditor track={track} trackIndex={trackIndex} presets={presets} overrides={overrides} merged={merged} onPatchTrack={onPatchTrack} onClose={onClose} renderTrackIcon={renderTrackIcon} />;
  }
  if ((CORE_ENGINES as readonly string[]).includes(engine)) {
    return <CoreSynthEditor engine={engine as typeof CORE_ENGINES[number]} track={track} trackIndex={trackIndex} presets={presets} overrides={overrides} merged={merged} onPatchTrack={onPatchTrack} onClose={onClose} renderTrackIcon={renderTrackIcon} />;
  }
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
      <SynthHeader engine="o3" title="O3" subtitle="3 OSC SYNTHESIZER" track={track} presets={presets} presetValue={track.preset} onPreset={name => onPatchTrack(trackIndex, { preset: name || undefined, synth_params: null })} onClose={onClose} renderTrackIcon={renderTrackIcon} />

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

function CoreSynthEditor({ engine, track, trackIndex, presets, overrides, merged, onPatchTrack, onClose, renderTrackIcon }: {
  engine: typeof CORE_ENGINES[number];
  track: Track;
  trackIndex: number;
  presets: PresetLibraryData | null;
  overrides: Record<string, unknown>;
  merged: Record<string, unknown>;
  onPatchTrack: (index: number, patch: Partial<Track>) => void;
  onClose: () => void;
  renderTrackIcon: (track: Track, size: number) => React.ReactNode;
}) {
  const hasOverride = (key: string) => key in overrides;
  function update(path: string[], value: unknown) {
    const updated = setNestedValue((track.synth_params as Record<string, unknown>) || {}, path, value) as Record<string, unknown>;
    onPatchTrack(trackIndex, { synth_params: updated });
  }
  function updateList(listKey: string, index: number, key: string, value: unknown, defaults: Record<string, unknown>[]) {
    const source = Array.isArray(merged[listKey]) ? merged[listKey] as Record<string, unknown>[] : [];
    const next = defaults.map((item, i) => ({ ...item, ...(source[i] || {}) }));
    next[index] = { ...next[index], [key]: value };
    onPatchTrack(trackIndex, { synth_params: { ...overrides, [listKey]: next } });
  }
  function resetSection(key: string) {
    const next = { ...overrides };
    delete next[key];
    onPatchTrack(trackIndex, { synth_params: Object.keys(next).length ? next : null });
  }
  return <div className="modal-backdrop" onClick={onClose}>
    <div className={`synth-editor core-synth-panel ${engine}-panel`} onClick={e => e.stopPropagation()}>
      <SynthHeader engine={engine} title={engine.toUpperCase()} subtitle={coreEngineDescription(engine).toUpperCase()} track={track} presets={presets} presetValue={track.preset} onPreset={name => onPatchTrack(trackIndex, { preset: name || undefined, synth_params: null })} onClose={onClose} renderTrackIcon={renderTrackIcon} />
      <div className="core-synth-body">
        {engine === 'flexis' && <FlexisControls merged={merged} hasOverride={hasOverride} update={update} resetSection={resetSection} />}
        {engine === 'sytrix' && <SytrixControls merged={merged} hasOverride={hasOverride} updateList={updateList} update={update} resetSection={resetSection} />}
        {engine === 'harmonis' && <HarmonisControls merged={merged} hasOverride={hasOverride} update={update} resetSection={resetSection} />}
        {engine === 'padis' && <PadisControls merged={merged} hasOverride={hasOverride} updateList={updateList} update={update} resetSection={resetSection} />}
        {engine === 'drumis' && <DrumisControls merged={merged} hasOverride={hasOverride} update={update} resetSection={resetSection} />}
      </div>
      <div className="core-synth-footer"><button onClick={() => onPatchTrack(trackIndex, { synth_params: null })}>重置默认</button><span>{coreEngineDescription(engine)}</span></div>
    </div>
  </div>;
}

function FlexisControls({ merged, hasOverride, update, resetSection }: CoreControlProps) {
  const macros = (merged.macros as Record<string, unknown>) || {};
  const items = ['tone', 'shape', 'motion', 'attack', 'release', 'space', 'drive', 'mix'];
  return <section className={`core-card${hasOverride('macros') ? ' overridden' : ''}`}><header>8 MACROS{hasOverride('macros') && <button className="reset-section-btn" onClick={() => resetSection('macros')}>↺</button>}</header><div className="macro-grid">{items.map(key => <CoreKnob key={key} label={key.toUpperCase()} min={0} max={1} step={0.01} value={Number(macros[key] ?? 0.5)} onChange={v => update(['macros', key], v)} />)}</div></section>;
}

function SytrixControls({ merged, hasOverride, updateList, update, resetSection }: CoreListControlProps) {
  const defaults = sytrixOperatorDefaults();
  const ops = listWithDefaults(merged.operators, defaults);
  const matrix = Array.isArray(merged.matrix) ? merged.matrix as number[][] : [[0, 0.42, 0.12, 0], [0, 0, 0.08, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  return <>
    <section className={`core-card${hasOverride('operators') ? ' overridden' : ''}`}><header>OPERATORS{hasOverride('operators') && <button className="reset-section-btn" onClick={() => resetSection('operators')}>↺</button>}</header><div className="operator-grid">{ops.map((op, i) => <div className="operator-card" key={i}><strong>OP {i + 1}</strong><CoreSlider label="Ratio" min={0.25} max={8} step={0.01} value={Number(op.ratio ?? 1)} onChange={v => updateList('operators', i, 'ratio', v, defaults)} /><CoreSlider label="Level" min={0} max={1.5} step={0.01} value={Number(op.level ?? 0.5)} onChange={v => updateList('operators', i, 'level', v, defaults)} /><CoreSlider label="Feedback" min={0} max={1} step={0.01} value={Number(op.feedback ?? 0)} onChange={v => updateList('operators', i, 'feedback', v, defaults)} /><select value={String(op.role || 'carrier')} onChange={e => updateList('operators', i, 'role', e.target.value, defaults)}><option value="carrier">Carrier</option><option value="modulator">Modulator</option></select></div>)}</div></section>
    <section className={`core-card${hasOverride('matrix') ? ' overridden' : ''}`}><header>FM MATRIX{hasOverride('matrix') && <button className="reset-section-btn" onClick={() => resetSection('matrix')}>↺</button>}</header><div className="matrix-grid">{matrix.map((row, r) => row.map((value, c) => <label key={`${r}-${c}`}>OP{c + 1}→OP{r + 1}<input type="number" min={0} max={1} step={0.01} value={Number(value || 0)} onChange={e => { const next = matrix.map(item => [...item]); next[r][c] = Number(e.target.value); update(['matrix'], next); }} /></label>))}</div></section>
  </>;
}

function HarmonisControls({ merged, hasOverride, update, resetSection }: CoreControlProps) {
  const h = (merged.harmonics as Record<string, unknown>) || {};
  return <section className={`core-card${hasOverride('harmonics') ? ' overridden' : ''}`}><header>HARMONIC BANK{hasOverride('harmonics') && <button className="reset-section-btn" onClick={() => resetSection('harmonics')}>↺</button>}</header><div className="macro-grid"><CoreKnob label="COUNT" min={4} max={32} step={1} value={Number(h.count ?? 16)} onChange={v => update(['harmonics', 'count'], v)} /><CoreKnob label="BRIGHT" min={0} max={1} step={0.01} value={Number(h.brightness ?? 0.58)} onChange={v => update(['harmonics', 'brightness'], v)} /><CoreKnob label="ODD/EVEN" min={-1} max={1} step={0.01} value={Number(h.odd_even ?? 0.1)} onChange={v => update(['harmonics', 'odd_even'], v)} /><CoreKnob label="TILT" min={0.05} max={2.5} step={0.01} value={Number(h.tilt ?? 1.1)} onChange={v => update(['harmonics', 'tilt'], v)} /><CoreKnob label="PLUCK" min={0} max={1} step={0.01} value={Number(h.pluck ?? 0.2)} onChange={v => update(['harmonics', 'pluck'], v)} /><CoreKnob label="UNISON" min={1} max={5} step={1} value={Number(h.unison ?? 1)} onChange={v => update(['harmonics', 'unison'], v)} /></div></section>;
}

function PadisControls({ merged, hasOverride, updateList, update, resetSection }: CoreListControlProps) {
  const defaults = padisLayerDefaults();
  const layers = listWithDefaults(merged.layers, defaults);
  const texture = (merged.texture as Record<string, unknown>) || {};
  return <>
    <section className={`core-card${hasOverride('layers') ? ' overridden' : ''}`}><header>GRAIN LAYERS{hasOverride('layers') && <button className="reset-section-btn" onClick={() => resetSection('layers')}>↺</button>}</header><div className="operator-grid">{layers.map((layer, i) => <div className="operator-card" key={i}><strong>LAYER {i === 0 ? 'A' : 'B'}</strong><select value={String(layer.wave || 'vowel')} onChange={e => updateList('layers', i, 'wave', e.target.value, defaults)}>{SERUMIS_WAVES.map(w => <option key={w} value={w}>{w}</option>)}</select>{['ratio', 'gain', 'grain_size', 'density', 'motion', 'spread'].map(key => <CoreSlider key={key} label={key} min={key === 'ratio' ? 0.25 : 0} max={key === 'ratio' ? 4 : 1} step={0.01} value={Number(layer[key] ?? 0.5)} onChange={v => updateList('layers', i, key, v, defaults)} />)}</div>)}</div></section>
    <section className={`core-card${hasOverride('texture') ? ' overridden' : ''}`}><header>TEXTURE{hasOverride('texture') && <button className="reset-section-btn" onClick={() => resetSection('texture')}>↺</button>}</header><label className="check-row"><input type="checkbox" checked={texture.noise !== false} onChange={e => update(['texture', 'noise'], e.currentTarget.checked)} />Noise texture</label><CoreSlider label="Texture Gain" min={0} max={0.2} step={0.001} value={Number(texture.gain ?? 0.035)} onChange={v => update(['texture', 'gain'], v)} /></section>
  </>;
}

function DrumisControls({ merged, hasOverride, update, resetSection }: CoreControlProps) {
  const tone = (merged.tone as Record<string, unknown>) || {};
  return <section className={`core-card${hasOverride('tone') ? ' overridden' : ''}`}><header>DRUM VOICE{hasOverride('tone') && <button className="reset-section-btn" onClick={() => resetSection('tone')}>↺</button>}</header><select value={String(merged.drum_type || 'auto')} onChange={e => update(['drum_type'], e.target.value)}><option value="auto">Auto Kit Map</option><option value="kick">Kick</option><option value="snare">Snare</option><option value="hat">Hat</option><option value="clap">Clap</option><option value="perc">Perc</option></select><div className="macro-grid"><CoreKnob label="BODY" min={0} max={1.5} step={0.01} value={Number(tone.body ?? 0.8)} onChange={v => update(['tone', 'body'], v)} /><CoreKnob label="SNAP" min={0} max={1} step={0.01} value={Number(tone.snap ?? 0.35)} onChange={v => update(['tone', 'snap'], v)} /><CoreKnob label="DECAY" min={0.02} max={2} step={0.01} value={Number(tone.decay ?? 0.28)} onChange={v => update(['tone', 'decay'], v)} /></div><div className="drumis-pattern">KICK · SNARE · HAT · CLAP · PERC</div></section>;
}

type CoreControlProps = { merged: Record<string, unknown>; hasOverride: (key: string) => boolean; update: (path: string[], value: unknown) => void; resetSection: (key: string) => void };
type CoreListControlProps = CoreControlProps & { updateList: (listKey: string, index: number, key: string, value: unknown, defaults: Record<string, unknown>[]) => void };

function CoreKnob({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  const normalized = max === min ? 0 : (value - min) / (max - min);
  const rotation = -135 + Math.max(0, Math.min(1, normalized)) * 270;
  return <label className="core-knob">
    <span>{label}</span>
    <i className="core-knob-face" style={{ '--knob-rotation': `${rotation}deg` } as React.CSSProperties}><b /></i>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.currentTarget.value))} />
    <em>{formatKnobValue(value)}</em>
  </label>;
}

function CoreSlider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <label className="core-slider"><span>{label}</span><input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.currentTarget.value))} /><em>{formatKnobValue(value)}</em></label>;
}

function listWithDefaults(source: unknown, defaults: Record<string, unknown>[]): Record<string, unknown>[] {
  const items = Array.isArray(source) ? source as Record<string, unknown>[] : [];
  return defaults.map((item, index) => ({ ...item, ...(items[index] || {}) }));
}

function sytrixOperatorDefaults(): Record<string, unknown>[] {
  return [{ ratio: 1, level: 0.85, role: 'carrier', feedback: 0 }, { ratio: 2, level: 0.35, role: 'modulator', feedback: 0 }, { ratio: 3, level: 0.18, role: 'modulator', feedback: 0 }, { ratio: 0.5, level: 0.25, role: 'carrier', feedback: 0 }];
}

function padisLayerDefaults(): Record<string, unknown>[] {
  return [{ wave: 'vowel', ratio: 1, gain: 0.5, grain_size: 0.28, density: 0.55, motion: 0.18, spread: 0.25 }, { wave: 'mirror', ratio: 1.5, gain: 0.34, grain_size: 0.45, density: 0.4, motion: 0.28, spread: 0.35 }];
}

function coreEngineDescription(engine: typeof CORE_ENGINES[number]): string {
  return { flexis: 'Preset macro synth', sytrix: 'FM operator synth', harmonis: 'Additive spectrum synth', padis: 'Granular texture synth', drumis: 'Drum synth and kit mapper' }[engine];
}

function SerumisEditor({ track, trackIndex, presets, overrides, merged, onPatchTrack, onClose, renderTrackIcon }: {
  track: Track;
  trackIndex: number;
  presets: PresetLibraryData | null;
  overrides: Record<string, unknown>;
  merged: Record<string, unknown>;
  onPatchTrack: (index: number, patch: Partial<Track>) => void;
  onClose: () => void;
  renderTrackIcon: (track: Track, size: number) => React.ReactNode;
}) {
  const oscs = serumisOscillators(merged);
  const filter = (merged.filter as Record<string, unknown>) || {};
  const env = (merged.amp_envelope as Record<string, unknown>) || {};
  const lfo = (merged.lfo as Record<string, unknown>) || {};
  const sub = (merged.sub as Record<string, unknown>) || {};
  const noise = (merged.noise as Record<string, unknown>) || {};
  const hasOverride = (key: string) => key in overrides;

  function update(path: string[], value: unknown) {
    if (path[0] === 'serumis_oscillators' && path.length === 3) {
      const index = Number(path[1]);
      const key = path[2];
      const nextOscs = serumisOscillators(merged);
      nextOscs[index] = { ...nextOscs[index], [key]: value };
      onPatchTrack(trackIndex, { synth_params: { ...overrides, serumis_oscillators: nextOscs } });
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

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="synth-editor serumis-panel" onClick={e => e.stopPropagation()}>
      <SynthHeader engine="serumis" title="SERUMIS" subtitle="WAVETABLE SYNTHESIZER" track={track} presets={presets} presetValue={track.preset} onPreset={name => onPatchTrack(trackIndex, { preset: name || undefined, synth_params: null })} onClose={onClose} renderTrackIcon={renderTrackIcon} />
      <div className="serumis-tabs"><span className="active">OSC</span><span>FX</span><span>MATRIX</span><span>GLOBAL</span></div>
      <div className="serumis-body">
        <div className="serumis-side">
          {renderTrackIcon(track, 22)}
          <strong>{track.name}</strong>
          <SerumisMiniPanel title="SUB" active={Boolean(sub.enabled)} value={Number(sub.gain ?? 0.2)} onToggle={() => update(['sub', 'enabled'], !sub.enabled)} onValue={v => update(['sub', 'gain'], v)} />
          <SerumisMiniPanel title="NOISE" active={Boolean(noise.enabled)} value={Number(noise.gain ?? 0.04)} onToggle={() => update(['noise', 'enabled'], !noise.enabled)} onValue={v => update(['noise', 'gain'], v)} />
        </div>
        <div className="serumis-main-grid">
          {oscs.map((osc, index) => <section key={index} className={`serumis-osc-card${hasOverride('serumis_oscillators') ? ' overridden' : ''}`}>
            <header><label><input type="checkbox" checked={osc.enabled !== false} onChange={e => update(['serumis_oscillators', String(index), 'enabled'], e.currentTarget.checked)} /> OSC {index === 0 ? 'A' : 'B'}</label>{index === 0 && hasOverride('serumis_oscillators') && <button className="reset-section-btn" onClick={() => resetSection('serumis_oscillators')}>↺</button>}</header>
            <select value={String(osc.wave || 'basic')} onChange={e => update(['serumis_oscillators', String(index), 'wave'], e.target.value)}>
              {SERUMIS_WAVES.map(wave => <option key={wave} value={wave}>{wave}</option>)}
            </select>
            <SerumisWaveDisplay wave={String(osc.wave || 'basic')} warp={Number(osc.warp ?? 0)} />
            <div className="serumis-osc-controls">
              <SerumisSlider label="UNISON" min={1} max={7} step={1} value={Number(osc.unison ?? 1)} onChange={v => update(['serumis_oscillators', String(index), 'unison'], v)} />
              <SerumisSlider label="DETUNE" min={-50} max={50} step={1} value={Number(osc.detune_cents ?? 0)} onChange={v => update(['serumis_oscillators', String(index), 'detune_cents'], v)} />
              <SerumisSlider label="BLEND" min={0} max={1} step={0.01} value={Number(osc.blend ?? 0)} onChange={v => update(['serumis_oscillators', String(index), 'blend'], v)} />
              <SerumisSlider label="WARP" min={0} max={1} step={0.01} value={Number(osc.warp ?? 0)} onChange={v => update(['serumis_oscillators', String(index), 'warp'], v)} />
              <SerumisSlider label="LEVEL" min={0} max={1.5} step={0.01} value={Number(osc.gain ?? 0.5)} onChange={v => update(['serumis_oscillators', String(index), 'gain'], v)} />
            </div>
          </section>)}
          <section className={`serumis-filter-card${hasOverride('filter') ? ' overridden' : ''}`}>
            <header><label><input type="checkbox" checked={filter.enabled !== false} onChange={e => update(['filter', 'enabled'], e.currentTarget.checked)} /> FILTER</label>{hasOverride('filter') && <button className="reset-section-btn" onClick={() => resetSection('filter')}>↺</button>}</header>
            <select value={String(filter.type || 'lowpass')} onChange={e => update(['filter', 'type'], e.target.value)}>
              <option value="lowpass">MG Low 12</option><option value="highpass">MG High 12</option><option value="bandpass">Band 24</option>
            </select>
            <SerumisFilterDisplay cutoff={Number(filter.cutoff_hz ?? 6000)} />
            <SerumisSlider label="CUTOFF" min={80} max={18000} step={10} value={Number(filter.cutoff_hz ?? 6000)} onChange={v => update(['filter', 'cutoff_hz'], v)} />
            <SerumisSlider label="RES" min={0} max={1} step={0.01} value={Number(filter.resonance ?? 0.2)} onChange={v => update(['filter', 'resonance'], v)} />
            <SerumisSlider label="DRIVE" min={0} max={1} step={0.01} value={Number(filter.drive ?? 0)} onChange={v => update(['filter', 'drive'], v)} />
          </section>
        </div>
      </div>
      <div className="serumis-mod-grid">
        <section className={`serumis-env${hasOverride('amp_envelope') ? ' overridden' : ''}`}>
          <header>ENV 1{hasOverride('amp_envelope') && <button className="reset-section-btn" onClick={() => resetSection('amp_envelope')}>↺</button>}</header>
          <div className="serumis-env-display"><span style={{ left: `${Math.min(48, Number(env.attack ?? 0.01) * 1000)}%` }} /><span style={{ left: '48%', top: `${90 - Number(env.sustain ?? 0.7) * 70}%` }} /><span style={{ right: `${Math.min(32, Number(env.release ?? 0.1) * 200)}%` }} /></div>
          <div className="serumis-env-controls">
            {(['attack', 'decay', 'sustain', 'release'] as const).map(key => <SerumisSlider key={key} label={key.toUpperCase()} min={0} max={key === 'sustain' ? 1 : 3} step={0.001} value={Number(env[key] ?? 0)} onChange={v => update(['amp_envelope', key], v)} />)}
          </div>
        </section>
        <section className={`serumis-lfo${hasOverride('lfo') ? ' overridden' : ''}`}>
          <header><label><input type="checkbox" checked={Boolean(lfo.enabled)} onChange={e => update(['lfo', 'enabled'], e.currentTarget.checked)} /> LFO 1</label>{hasOverride('lfo') && <button className="reset-section-btn" onClick={() => resetSection('lfo')}>↺</button>}</header>
          <div className="serumis-lfo-display" />
          <div className="serumis-env-controls">
            <SerumisSlider label="RATE" min={0.1} max={12} step={0.1} value={Number(lfo.rate_hz ?? 2)} onChange={v => update(['lfo', 'rate_hz'], v)} />
            <SerumisSlider label="FILTER" min={0} max={1} step={0.01} value={Number(lfo.filter_amount ?? 0)} onChange={v => update(['lfo', 'filter_amount'], v)} />
            <SerumisSlider label="OUT" min={0} max={1.5} step={0.01} value={Number(merged.output_gain ?? 0.28)} onChange={v => update(['output_gain'], v)} />
          </div>
        </section>
      </div>
      <div className="serumis-footer"><button onClick={() => onPatchTrack(trackIndex, { synth_params: null })}>重置默认</button><span>Serumis wavetable synth</span></div>
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

function SerumisMiniPanel({ title, active, value, onToggle, onValue }: {
  title: string; active: boolean; value: number; onToggle: () => void; onValue: (value: number) => void;
}) {
  return <section className="serumis-mini">
    <header><label><input type="checkbox" checked={active} onChange={onToggle} /> {title}</label></header>
    <SerumisWaveDisplay wave={title === 'SUB' ? 'basic' : 'digital'} warp={0.55} compact />
    <SerumisSlider label="LEVEL" min={0} max={1} step={0.01} value={value} onChange={onValue} />
  </section>;
}

function SerumisSlider({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void;
}) {
  return <label className="serumis-slider">
    <span>{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.currentTarget.value))} />
    <em>{formatKnobValue(value)}</em>
  </label>;
}

function SerumisWaveDisplay({ wave, warp, compact = false }: { wave: string; warp: number; compact?: boolean }) {
  const points = Array.from({ length: 34 }, (_, index) => {
    const x = index / 33;
    const y = serumisPreviewValue(wave, x, warp);
    return `${(x * 100).toFixed(2)},${(50 - y * 34).toFixed(2)}`;
  }).join(' ');
  return <div className={compact ? 'serumis-wave compact' : 'serumis-wave'}>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,100 ${points} 100,100`} />
      <polyline points={points} />
    </svg>
  </div>;
}

function SerumisFilterDisplay({ cutoff }: { cutoff: number }) {
  const x = Math.max(8, Math.min(94, cutoff / 18000 * 100));
  return <div className="serumis-filter-display">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path d={`M 0 28 C ${x * 0.65} 28 ${x} 28 100 74`} />
    </svg>
  </div>;
}

function serumisPreviewValue(wave: string, phase: number, warp: number): number {
  if (wave === 'metal') return Math.tanh(Math.sin(Math.PI * 2 * phase) * (1 + 5 * warp) + 0.45 * Math.sin(Math.PI * 14 * phase));
  if (wave === 'vowel') return 0.58 * Math.sin(Math.PI * 2 * phase) + 0.28 * Math.sin(Math.PI * 2 * phase * (2 + warp * 2)) + 0.18 * Math.sin(Math.PI * 10 * phase);
  if (wave === 'digital') {
    const steps = Math.max(3, Math.round(18 - 14 * warp));
    return 2 * (Math.floor(phase * steps) / Math.max(1, steps - 1)) - 1;
  }
  if (wave === 'mirror') {
    const folded = Math.abs(2 * phase - 1);
    return Math.sin(Math.PI * 2 * (folded + warp * Math.sin(Math.PI * 2 * phase) * 0.12));
  }
  return (1 - warp) * Math.sin(Math.PI * 2 * phase) + warp * (2 * phase - 1);
}

function serumisOscillators(preset: Record<string, unknown>): Record<string, unknown>[] {
  const source = Array.isArray(preset.serumis_oscillators) ? preset.serumis_oscillators as Record<string, unknown>[] : [];
  const defaults = [
    { enabled: true, wave: 'basic', ratio: 1, gain: 0.52, detune_cents: 0, unison: 1, blend: 0, warp: 0 },
    { enabled: true, wave: 'metal', ratio: 1, gain: 0.38, detune_cents: 7, unison: 3, blend: 0.45, warp: 0.35 }
  ];
  return defaults.map((osc, index) => ({ ...osc, ...(source[index] || {}) }));
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
