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
};

export function buildRealtimeProject(project: Project, library: PresetLibraryData): RealtimeProject {
  const presets = Object.fromEntries(library.presets.map(preset => [preset.name, preset]));
  const tracks = project.tracks.map((track, index) => ({
    index,
    kind: track.kind,
    preset: track.preset || fallbackPreset(track),
    volume: track.volume,
    pan: track.pan,
    muted: track.muted,
    solo: track.solo,
    synthParams: track.synth_params ?? undefined
  }));
  const events = project.tracks.flatMap((track, trackIndex) => flattenTrackEvents(track, trackIndex));
  const audioEvents = project.tracks.flatMap((track, trackIndex) => flattenAudioEvents(track, trackIndex));
  events.sort((left, right) => left.startBeat - right.startBeat || left.pitch - right.pitch);
  audioEvents.sort((left, right) => left.startBeat - right.startBeat);
  return {
    bpm: project.bpm,
    lengthBeats: project.length_bars * 4,
    tracks,
    events,
    audioEvents,
    presets
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
