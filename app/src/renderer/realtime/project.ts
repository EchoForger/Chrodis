import { type Note, type Project, type Track } from '../api';

export type PresetData = {
  name: string;
  display_name?: string;
  description?: string;
  [key: string]: unknown;
};
export type PresetLibraryData = { version?: number; presets: PresetData[] };

export type RealtimeTrack = {
  index: number;
  kind: string;
  preset: string;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  effects?: Array<{ type: string; enabled: boolean; params: Record<string, unknown> }>;
  synthParams?: Record<string, unknown>;
};

export type RealtimeEvent = {
  trackIndex: number;
  startBeat: number;
  durationBeats: number;
  pitch: number;
  velocity: number;
};

export type RealtimeAudioEvent = {
  trackIndex: number;
  startBeat: number;
  durationBeats: number;
  assetPath: string;
  gain: number;
};

export type RealtimeProject = {
  bpm: number;
  lengthBeats: number;
  tracks: RealtimeTrack[];
  events: RealtimeEvent[];
  audioEvents: RealtimeAudioEvent[];
  presets: Record<string, PresetData>;
  masterEffects: Array<{ type: string; enabled: boolean; params: Record<string, unknown> }>;
};

const LEGACY_SYSTEM_PRESET_REFS: Record<string, string> = {
  'SYSTEM/Serumis/init': 'SYSTEM/初始化/serumis-init',
  'SYSTEM/Serumis/metal-lead': 'SYSTEM/合成器/serumis-metal-lead',
  'SYSTEM/Serumis/glass-pad': 'SYSTEM/音垫/serumis-glass-pad',
  'SYSTEM/Flexis/init': 'SYSTEM/初始化/flexis-init',
  'SYSTEM/Flexis/pop-keys': 'SYSTEM/键盘乐器/flexis-pop-keys',
  'SYSTEM/Flexis/modern-bass': 'SYSTEM/贝司/flexis-modern-bass',
  'SYSTEM/Sytrix/init': 'SYSTEM/初始化/sytrix-init',
  'SYSTEM/Sytrix/fm-bell': 'SYSTEM/键盘乐器/sytrix-fm-bell',
  'SYSTEM/Sytrix/digital-bass': 'SYSTEM/贝司/sytrix-digital-bass',
  'SYSTEM/Harmonis/init': 'SYSTEM/初始化/harmonis-init',
  'SYSTEM/Harmonis/bright-pluck': 'SYSTEM/合成器/harmonis-bright-pluck',
  'SYSTEM/Harmonis/spectral-lead': 'SYSTEM/合成器/harmonis-spectral-lead',
  'SYSTEM/Padis/init': 'SYSTEM/初始化/padis-init',
  'SYSTEM/Padis/cinema-drone': 'SYSTEM/音垫/padis-cinema-drone',
  'SYSTEM/Padis/glimmer-pad': 'SYSTEM/音垫/padis-glimmer-pad',
  'SYSTEM/Drumis/init': 'SYSTEM/打击乐器/drumis-init',
  'SYSTEM/Drumis/punch-kick': 'SYSTEM/打击乐器/drumis-punch-kick',
  'SYSTEM/Drumis/snap-snare': 'SYSTEM/打击乐器/drumis-snap-snare'
};

export function buildRealtimeProject(project: Project, library: PresetLibraryData): RealtimeProject {
  const presets = Object.fromEntries(library.presets.map(preset => [preset.name, preset]));
  for (const [legacyName, currentName] of Object.entries(LEGACY_SYSTEM_PRESET_REFS)) {
    if (!presets[legacyName] && presets[currentName]) presets[legacyName] = { ...presets[currentName], name: legacyName };
  }
  const tracks = project.tracks.map((track, index) => ({
    index,
    kind: track.kind,
    preset: track.preset || fallbackPreset(track),
    volume: track.volume,
    pan: track.pan,
    muted: track.muted,
    solo: track.solo,
    effects: track.effects || [],
    synthParams: track.synth_params ?? undefined
  }));
  const lengthBeats = project.length_bars * 4;
  const events = project.tracks
    .flatMap((track, trackIndex) => flattenTrackEvents(track, trackIndex))
    .filter(event => event.startBeat < lengthBeats);
  const audioEvents = project.tracks
    .flatMap((track, trackIndex) => flattenAudioEvents(track, trackIndex))
    .filter(event => event.startBeat < lengthBeats);
  events.sort((left, right) => left.startBeat - right.startBeat || left.pitch - right.pitch);
  audioEvents.sort((left, right) => left.startBeat - right.startBeat);
  return {
    bpm: project.bpm,
    lengthBeats,
    tracks,
    events,
    audioEvents,
    presets,
    masterEffects: project.master_effects || []
  };
}

export function flattenTrackEvents(track: Track, trackIndex: number): RealtimeEvent[] {
  const events = track.notes.map(note => noteToEvent(note, trackIndex, 0));
  for (const clip of track.clips || []) {
    const loops = Math.max(1, clip.loop_count || 1);
    for (let loop = 0; loop < loops; loop += 1) {
      const clipStart = (clip.bar - 1) * 4 + loop * clip.beats;
      for (const note of clip.notes || []) {
        events.push(noteToEvent(note, trackIndex, clipStart));
      }
    }
  }
  return events;
}

export function flattenAudioEvents(track: Track, trackIndex: number): RealtimeAudioEvent[] {
  return (track.audio_clips || []).map(clip => ({
    trackIndex,
    startBeat: (clip.bar - 1) * 4,
    durationBeats: clip.beats,
    assetPath: clip.asset_path,
    gain: clip.gain ?? 1
  }));
}

export function noteToEvent(note: Note, trackIndex: number, baseBeat: number): RealtimeEvent {
  return {
    trackIndex,
    startBeat: baseBeat + (note.bar - 1) * 4 + (note.beat - 1),
    durationBeats: Math.max(0.25, note.duration),
    pitch: note.pitch,
    velocity: note.velocity
  };
}

export function eventEndBeat(event: RealtimeEvent, bpm: number, tailSeconds = 0): number {
  return event.startBeat + event.durationBeats + tailSeconds * bpm / 60;
}

export function shouldRenderTrack(track: RealtimeTrack, tracks: RealtimeTrack[]): boolean {
  const hasSolo = tracks.some(item => item.solo && !item.muted);
  return hasSolo ? track.solo && !track.muted : !track.muted;
}

export function beatToSeconds(beat: number, bpm: number): number {
  return beat * 60 / bpm;
}

export function secondsToBeat(seconds: number, bpm: number): number {
  return seconds * bpm / 60;
}

function fallbackPreset(track: Track): string {
  const program = 'program' in track ? (track as Track & { program?: number }).program : undefined;
  if (program === undefined || program === null) return 'SYSTEM/键盘乐器/keys';
  if (program >= 32 && program <= 39) return 'SYSTEM/贝司/o3-bass';
  if (program >= 80 && program <= 87) return 'SYSTEM/合成器/o3-lead';
  if (program >= 88 && program <= 95) return 'SYSTEM/音垫/o3-pad';
  return 'SYSTEM/键盘乐器/keys';
}
