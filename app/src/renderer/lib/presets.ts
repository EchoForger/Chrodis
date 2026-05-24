import { type PresetData, type PresetLibraryData } from '../realtime/project';

export type SynthEngine = 'o3';

export function normalizeSynthEngine(value: unknown): SynthEngine {
  return String(value || 'o3').toLowerCase() === 'o3' ? 'o3' : 'o3';
}

export function synthEngineLabel(value: unknown): string {
  const engine = normalizeSynthEngine(value);
  if (engine === 'o3') return 'O3';
  return 'O3';
}

export function presetEngine(preset: PresetData | Record<string, unknown>): SynthEngine {
  return normalizeSynthEngine(preset.synth_engine);
}

export function presetCategory(preset: PresetData): string | undefined {
  if (preset.name.startsWith('SYSTEM/')) {
    const rest = preset.name.slice('SYSTEM/'.length);
    const slash = rest.indexOf('/');
    return slash > 0 ? rest.slice(0, slash) : undefined;
  }
  return undefined;
}

export function presetCategories(presets: PresetData[]): string[] {
  const cats = presets.map(presetCategory).filter((c): c is string => c !== undefined);
  return [...new Set(cats)];
}

/** Walk the _inherits chain and return the first SYSTEM/ ancestor name, or the original name if none found. */
export function resolveBaseSystemPreset(name: string, library: PresetLibraryData): string {
  const visited = new Set<string>();
  let current = name;
  while (!current.startsWith('SYSTEM/') && !visited.has(current)) {
    visited.add(current);
    const preset = library.presets.find(p => p.name === current);
    const parent = preset?._inherits as string | undefined;
    if (!parent) break;
    current = parent;
  }
  return current;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function deepMergePreset(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value)
      ? deepMergePreset(current, value)
      : value;
  }
  return merged;
}
