import React, { useState } from 'react';
import { type Effect, type Project, type Track } from '../api';
import { PanKnob, VerticalFader } from './controls';

const PLUGINS = [
  { type: 'eq', label: 'EQ', group: 'Equalizer' },
  { type: 'gate', label: 'GATE', group: 'Dynamics' },
  { type: 'compressor', label: 'COMP', group: 'Dynamics' },
  { type: 'limiter', label: 'LIMIT', group: 'Dynamics' },
  { type: 'pitch_shifter', label: 'PITCH', group: 'Pitch' },
  { type: 'delay', label: 'DLY', group: 'Space' },
  { type: 'reverb', label: 'RVB', group: 'Space' }
] as const;

const SLOT_COUNT = 6;

type PluginSelection = { scope: 'track'; trackIndex: number; index: number } | { scope: 'master'; index: number };

export function Mixer({ project, onPatchTrack, onPatchProject, renderTrackIcon }: {
  project: Project;
  onPatchTrack: (index: number, patch: Partial<Track>) => void;
  onPatchProject: (patch: Partial<Project>) => void;
  renderTrackIcon: (track: Track) => React.ReactNode;
}) {
  const [selection, setSelection] = useState<PluginSelection | null>(null);
  const selectedEffects = selection?.scope === 'master'
    ? project.master_effects
    : selection
      ? project.tracks[selection.trackIndex]?.effects || []
      : [];
  const selectedEffect = selection ? selectedEffects[selection.index] : undefined;

  function patchEffects(selection: PluginSelection, effects: Effect[]) {
    if (selection.scope === 'master') {
      onPatchProject({ master_effects: effects });
    } else {
      onPatchTrack(selection.trackIndex, { effects });
    }
  }

  function replaceSelected(effect: Effect) {
    if (!selection) return;
    const next = selectedEffects.map((item, index) => index === selection.index ? effect : item);
    patchEffects(selection, next);
  }

  function removeSelected() {
    if (!selection) return;
    patchEffects(selection, selectedEffects.filter((_, index) => index !== selection.index));
    setSelection(null);
  }

  function moveSelected(direction: -1 | 1) {
    if (!selection) return;
    const target = selection.index + direction;
    if (target < 0 || target >= selectedEffects.length) return;
    const next = [...selectedEffects];
    [next[selection.index], next[target]] = [next[target], next[selection.index]];
    patchEffects(selection, next);
    setSelection({ ...selection, index: target });
  }

  return <div className="mixer">
    <div className="mixer-channels">
      {project.tracks.map((track, index) => (
        <MixerChannel key={index} track={track} trackIndex={index} selected={selection?.scope === 'track' && selection.trackIndex === index ? selection.index : null} onSelect={slot => setSelection({ scope: 'track', trackIndex: index, index: slot })} onPatch={patch => onPatchTrack(index, patch)} renderTrackIcon={renderTrackIcon} />
      ))}
      <MasterChannel project={project} selected={selection?.scope === 'master' ? selection.index : null} onSelect={slot => setSelection({ scope: 'master', index: slot })} onPatchProject={onPatchProject} />
    </div>
    {selection && <PluginEditor
      effect={selectedEffect}
      selection={selection}
      effects={selectedEffects}
      onAdd={type => {
        const next = [...selectedEffects, defaultEffect(type)];
        patchEffects(selection, next);
        setSelection({ ...selection, index: next.length - 1 });
      }}
      onChange={replaceSelected}
      onRemove={removeSelected}
      onMove={moveSelected}
      onClose={() => setSelection(null)}
    />}
  </div>;
}

function MixerChannel({ track, trackIndex, selected, onSelect, onPatch, renderTrackIcon }: {
  track: Track;
  trackIndex: number;
  selected: number | null;
  onSelect: (slot: number) => void;
  onPatch: (patch: Partial<Track>) => void;
  renderTrackIcon: (track: Track) => React.ReactNode;
}) {
  return <div className={`mixer-channel${track.muted ? ' muted' : ''}${track.solo ? ' solo' : ''}`}>
    <div className="mixer-channel-number">{trackIndex + 1}</div>
    <PluginSlots effects={track.effects || []} selected={selected} onSelect={onSelect} />
    <PanKnob value={track.pan} onChange={pan => onPatch({ pan })} />
    <div className="fader-area"><VerticalFader value={track.volume} onChange={volume => onPatch({ volume })} /></div>
    <div className="mixer-buttons">
      <button className={`mini${track.muted ? ' active' : ''}`} onClick={() => onPatch({ muted: !track.muted })}>M</button>
      <button className={`mini${track.solo ? ' active' : ''}`} onClick={() => onPatch({ solo: !track.solo })}>S</button>
      <button className={`mini record${track.record_armed ? ' active' : ''}`} onClick={() => onPatch({ record_armed: !track.record_armed })}>R</button>
    </div>
    {renderTrackIcon(track)}
    <div className="mixer-name" title={track.name}>{track.name}</div>
  </div>;
}

function MasterChannel({ project, selected, onSelect, onPatchProject }: {
  project: Project;
  selected: number | null;
  onSelect: (slot: number) => void;
  onPatchProject: (patch: Partial<Project>) => void;
}) {
  return <div className="mixer-channel master-channel">
    <div className="mixer-channel-number">M</div>
    <PluginSlots effects={project.master_effects || []} selected={selected} onSelect={onSelect} />
    <PanKnob value={64} onChange={() => {}} />
    <div className="fader-area"><VerticalFader value={100} onChange={() => {}} /></div>
    <div className="mixer-buttons"><button className="mini" onClick={() => onPatchProject({ master_effects: defaultMasterEffects() })}>FX</button></div>
    <div className="track-index-icon master-icon">Σ</div>
    <div className="mixer-name">Master</div>
  </div>;
}

function PluginSlots({ effects, selected, onSelect }: { effects: Effect[]; selected: number | null; onSelect: (slot: number) => void }) {
  return <div className="mixer-effects-slots">
    {Array.from({ length: SLOT_COUNT }, (_, index) => {
      const effect = effects[index];
      return <button key={index} className={`effect-slot${effect?.enabled ? ' active' : ''}${selected === index ? ' selected' : ''}${effect && !effect.enabled ? ' bypassed' : ''}`} title={effect ? pluginLabel(effect.type) : '添加插件'} onClick={() => onSelect(index)}>
        {effect ? pluginLabel(effect.type) : '+'}
      </button>;
    })}
  </div>;
}

function PluginEditor({ effect, selection, effects, onAdd, onChange, onRemove, onMove, onClose }: {
  effect: Effect | undefined;
  selection: PluginSelection;
  effects: Effect[];
  onAdd: (type: string) => void;
  onChange: (effect: Effect) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onClose: () => void;
}) {
  if (!effect) {
    return <div className="plugin-editor empty">
      <header><strong>添加插件</strong><button onClick={onClose}>×</button></header>
      <div className="plugin-menu">
        {PLUGINS.map(plugin => <button key={plugin.type} onClick={() => onAdd(plugin.type)}>
          <strong>{plugin.label}</strong><span>{plugin.group}</span>
        </button>)}
      </div>
    </div>;
  }
  const currentEffect = effect;
  function patchParam(key: string, value: unknown) {
    onChange({ ...currentEffect, params: { ...(currentEffect.params || {}), [key]: value } });
  }
  function patchBand(index: number, key: string, value: unknown) {
    const bands = defaultEqBands(currentEffect.params?.bands).map((band, bandIndex) => bandIndex === index ? { ...band, [key]: value } : band);
    patchParam('bands', bands);
  }
  return <div className="plugin-editor">
    <header>
      <strong>{pluginName(currentEffect.type)}</strong>
      <div className="plugin-editor-actions">
        <button onClick={() => onChange({ ...currentEffect, enabled: !currentEffect.enabled })}>{currentEffect.enabled ? 'Bypass' : 'Enable'}</button>
        <button disabled={selection.index <= 0} onClick={() => onMove(-1)}>↑</button>
        <button disabled={selection.index >= effects.length - 1} onClick={() => onMove(1)}>↓</button>
        <button onClick={onRemove}>删除</button>
        <button onClick={onClose}>×</button>
      </div>
    </header>
    {currentEffect.type === 'eq' && <EQEditor params={currentEffect.params || {}} onBand={patchBand} />}
    {(currentEffect.type === 'gate' || currentEffect.type === 'compressor' || currentEffect.type === 'limiter') && <DynamicsEditor effect={currentEffect} onParam={patchParam} />}
    {currentEffect.type === 'pitch_shifter' && <PitchEditor params={currentEffect.params || {}} onParam={patchParam} />}
    {(currentEffect.type === 'delay' || currentEffect.type === 'reverb') && <SpaceEditor effect={currentEffect} onParam={patchParam} />}
  </div>;
}

function EQEditor({ params, onBand }: { params: Record<string, unknown>; onBand: (index: number, key: string, value: unknown) => void }) {
  return <div className="plugin-param-grid eq-grid">
    {defaultEqBands(params.bands).map((band, index) => <section key={index} className="eq-band">
      <strong>{index === 0 ? 'LOW' : index === 1 ? 'MID' : 'HIGH'}</strong>
      <select value={String(band.type)} onChange={event => onBand(index, 'type', event.target.value)}>
        <option value="low_shelf">Low Shelf</option>
        <option value="peaking">Peak</option>
        <option value="high_shelf">High Shelf</option>
      </select>
      <PluginSlider label="Freq" min={20} max={18000} step={10} value={Number(band.frequency)} onChange={value => onBand(index, 'frequency', value)} />
      <PluginSlider label="Gain" min={-18} max={18} step={0.5} value={Number(band.gain_db)} onChange={value => onBand(index, 'gain_db', value)} suffix=" dB" />
      <PluginSlider label="Q" min={0.1} max={8} step={0.1} value={Number(band.q)} onChange={value => onBand(index, 'q', value)} />
    </section>)}
  </div>;
}

function DynamicsEditor({ effect, onParam }: { effect: Effect; onParam: (key: string, value: unknown) => void }) {
  const p = effect.params || {};
  if (effect.type === 'limiter') {
    return <div className="plugin-param-grid">
      <PluginKnob label="Ceiling" min={-24} max={0} step={0.1} value={Number(p.ceiling_db ?? -0.8)} onChange={v => onParam('ceiling_db', v)} suffix=" dB" />
      <PluginKnob label="Release" min={0.001} max={1} step={0.001} value={Number(p.release ?? 0.08)} onChange={v => onParam('release', v)} suffix=" s" />
    </div>;
  }
  if (effect.type === 'gate') {
    return <div className="plugin-param-grid">
      <PluginKnob label="Threshold" min={-80} max={0} step={0.5} value={Number(p.threshold_db ?? -42)} onChange={v => onParam('threshold_db', v)} suffix=" dB" />
      <PluginKnob label="Range" min={-80} max={0} step={0.5} value={Number(p.range_db ?? -48)} onChange={v => onParam('range_db', v)} suffix=" dB" />
      <PluginKnob label="Attack" min={0.001} max={0.2} step={0.001} value={Number(p.attack ?? 0.004)} onChange={v => onParam('attack', v)} suffix=" s" />
      <PluginKnob label="Release" min={0.005} max={1} step={0.001} value={Number(p.release ?? 0.08)} onChange={v => onParam('release', v)} suffix=" s" />
    </div>;
  }
  return <div className="plugin-param-grid">
    <PluginKnob label="Threshold" min={-60} max={0} step={0.5} value={Number(p.threshold_db ?? -18)} onChange={v => onParam('threshold_db', v)} suffix=" dB" />
    <PluginKnob label="Ratio" min={1} max={20} step={0.1} value={Number(p.ratio ?? 3)} onChange={v => onParam('ratio', v)} />
    <PluginKnob label="Attack" min={0.001} max={0.2} step={0.001} value={Number(p.attack ?? 0.01)} onChange={v => onParam('attack', v)} suffix=" s" />
    <PluginKnob label="Release" min={0.005} max={1} step={0.001} value={Number(p.release ?? 0.08)} onChange={v => onParam('release', v)} suffix=" s" />
    <PluginKnob label="Makeup" min={-12} max={18} step={0.5} value={Number(p.makeup_db ?? 0)} onChange={v => onParam('makeup_db', v)} suffix=" dB" />
  </div>;
}

function PitchEditor({ params, onParam }: { params: Record<string, unknown>; onParam: (key: string, value: unknown) => void }) {
  return <div className="plugin-param-grid">
    <PluginKnob label="Semitones" min={-24} max={24} step={1} value={Number(params.semitones ?? 0)} onChange={v => onParam('semitones', v)} />
    <PluginKnob label="Mix" min={0} max={1} step={0.01} value={Number(params.mix ?? 1)} onChange={v => onParam('mix', v)} />
    <div className="plugin-note">实时播放中 Pitch Shifter 使用轻量模式；导出时会渲染变调结果。</div>
  </div>;
}

function SpaceEditor({ effect, onParam }: { effect: Effect; onParam: (key: string, value: unknown) => void }) {
  const p = effect.params || {};
  return <div className="plugin-param-grid">
    {effect.type === 'delay' && <>
      <PluginKnob label="Time" min={0.02} max={1.5} step={0.01} value={Number(p.time ?? 0.25)} onChange={v => onParam('time', v)} suffix=" s" />
      <PluginKnob label="Feedback" min={0} max={0.95} step={0.01} value={Number(p.feedback ?? 0.25)} onChange={v => onParam('feedback', v)} />
    </>}
    {effect.type === 'reverb' && <PluginKnob label="Decay" min={0} max={0.95} step={0.01} value={Number(p.decay ?? 0.45)} onChange={v => onParam('decay', v)} />}
    <PluginKnob label="Mix" min={0} max={1} step={0.01} value={Number(p.mix ?? 0.2)} onChange={v => onParam('mix', v)} />
  </div>;
}

function PluginKnob({ label, value, min, max, step, suffix = '', onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void }) {
  const norm = max === min ? 0 : (value - min) / (max - min);
  const rotation = -135 + Math.max(0, Math.min(1, norm)) * 270;
  return <label className="plugin-knob">
    <span>{label}</span>
    <i style={{ '--plugin-knob-rotation': `${rotation}deg` } as React.CSSProperties} />
    <input type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.currentTarget.value))} />
    <em>{formatValue(value)}{suffix}</em>
  </label>;
}

function PluginSlider({ label, value, min, max, step, suffix = '', onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void }) {
  return <label className="plugin-slider"><span>{label}</span><input type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.currentTarget.value))} /><em>{formatValue(value)}{suffix}</em></label>;
}

function defaultEffect(type: string): Effect {
  if (type === 'eq') return { type, enabled: true, params: { bands: defaultEqBands(undefined) } };
  if (type === 'gate') return { type, enabled: true, params: { threshold_db: -42, attack: 0.004, release: 0.08, range_db: -48 } };
  if (type === 'compressor') return { type, enabled: true, params: { threshold_db: -18, ratio: 3, attack: 0.01, release: 0.08, makeup_db: 0 } };
  if (type === 'limiter') return { type, enabled: true, params: { ceiling_db: -0.8, release: 0.08 } };
  if (type === 'pitch_shifter') return { type, enabled: true, params: { semitones: 0, mix: 1 } };
  if (type === 'delay') return { type, enabled: true, params: { time: 0.25, feedback: 0.25, mix: 0.2 } };
  return { type: 'reverb', enabled: true, params: { mix: 0.18, decay: 0.45 } };
}

function defaultMasterEffects(): Effect[] {
  return [
    defaultEffect('eq'),
    { type: 'compressor', enabled: true, params: { threshold_db: -16, ratio: 2, attack: 0.02, release: 0.12, makeup_db: 0 } },
    { type: 'limiter', enabled: true, params: { ceiling_db: -1, release: 0.08 } }
  ];
}

function defaultEqBands(source: unknown): Array<{ type: string; frequency: number; gain_db: number; q: number }> {
  const defaults = [
    { type: 'low_shelf', frequency: 120, gain_db: 0, q: 0.707 },
    { type: 'peaking', frequency: 1000, gain_db: 0, q: 1 },
    { type: 'high_shelf', frequency: 8000, gain_db: 0, q: 0.707 }
  ];
  const bands = Array.isArray(source) ? source as Array<Record<string, unknown>> : [];
  return defaults.map((band, index) => ({ ...band, ...(bands[index] || {}) }));
}

function pluginLabel(type: string): string {
  return PLUGINS.find(plugin => plugin.type === type)?.label || type.slice(0, 5).toUpperCase();
}

function pluginName(type: string): string {
  const plugin = PLUGINS.find(item => item.type === type);
  return plugin ? `${plugin.group} · ${plugin.label}` : type;
}

function formatValue(value: number): string {
  if (Math.abs(value) >= 100) return String(Math.round(value));
  if (Math.abs(value) >= 10) return Number(value.toFixed(1)).toString();
  return Number(value.toFixed(2)).toString();
}
