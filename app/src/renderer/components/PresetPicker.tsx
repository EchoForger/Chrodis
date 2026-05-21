import React, { useEffect, useRef, useState } from 'react';
import { type PresetLibraryData } from '../realtime/project';
import { normalizeSynthEngine, presetCategories, presetCategory, presetEngine, synthEngineLabel } from '../lib/presets';

export function PresetPicker({ presets, value, engine, className, onChange }: {
  presets: PresetLibraryData | null; value: string | undefined; engine?: string;
  className?: string; onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<string>('');
  const rootRef = useRef<HTMLDivElement>(null);
  const normalizedEngine = engine ? normalizeSynthEngine(engine) : undefined;
  const filtered = engine
    ? (presets?.presets.filter(p => presetEngine(p) === normalizedEngine) ?? [])
    : (presets?.presets ?? []);
  const categories = presetCategories(filtered);
  const current = filtered.find(p => p.name === value);
  const currentCategory = categories.includes(category) ? category : (presetCategory(current ?? { name: '' }) ?? categories[0] ?? '其他');
  const categoryPresets = filtered.filter(p => presetCategory(p) === currentCategory);

  useEffect(() => {
    const cat = current ? presetCategory(current) : undefined;
    if (cat) setCategory(cat);
  }, [current?.name]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return <div className={`preset-picker${className ? ` ${className}` : ''}`} ref={rootRef}>
    <button type="button" className="preset-picker-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(show => !show)}>
      <span>{current?.display_name || '未选择'}</span>
      <small>⌄</small>
    </button>
    {open && <div className="preset-picker-panel">
      <div className="preset-picker-categories">
        {categories.map(cat => <button type="button" key={cat} className={cat === currentCategory ? 'active' : ''} onClick={() => setCategory(cat)}>{cat}</button>)}
      </div>
      <div className="preset-picker-presets">
        <button type="button" className={!value ? 'active' : ''} onClick={() => { onChange(''); setOpen(false); }}>未选择</button>
        {categoryPresets.length === 0 && <div className="empty-state">没有可用预设</div>}
        {categoryPresets.map(preset => <button type="button" key={preset.name} className={preset.name === value ? 'active' : ''} onClick={() => { onChange(preset.name); setOpen(false); }}>
          <strong>{preset.display_name || '未命名预设'}</strong>
          {preset.description && <span>{preset.description}</span>}
          <small>{synthEngineLabel(preset.synth_engine)}</small>
        </button>)}
      </div>
    </div>}
  </div>;
}
