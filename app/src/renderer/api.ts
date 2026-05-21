export type Note = { bar: number; beat: number; pitch: number; duration: number; velocity: number };
export type Clip = { id: string; name: string; bar: number; beats: number; color: string; loop_count?: number; notes: Note[] };
export type AudioClip = {
  id: string;
  name: string;
  bar: number;
  beats: number;
  color: string;
  asset_path: string;
  duration_seconds: number;
  sample_rate: number;
  channels: number;
  gain: number;
};
export type Effect = { type: string; enabled: boolean; params: Record<string, unknown> };
export type Track = {
  name: string;
  kind: 'instrument' | 'drum' | 'audio' | string;
  preset?: string;
  program?: number;
  channel?: number;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  record_armed?: boolean;
  notes: Note[];
  clips: Clip[];
  audio_clips: AudioClip[];
  effects: Effect[];
};
export type Project = {
  title: string;
  bpm: number;
  key: string;
  time_signature: string;
  length_bars: number;
  tracks: Track[];
  master_effects: Effect[];
};

export type ClipKey = { track: number; id: string; kind: 'midi' | 'audio' };
export type NoteKey = { track: number; clip: string; index: number };

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export function clipLeft(bar: number, pxPerBar: number): number {
  return (bar - 1) * pxPerBar;
}

export function clipWidth(beats: number, pxPerBar: number): number {
  return (beats / 4) * pxPerBar;
}

export function snapBeats(deltaPx: number, pxPerBeat: number): number {
  return Math.round(deltaPx / pxPerBeat);
}

export function barFromBeatIndex(beatIndex: number): number {
  return 1 + beatIndex / 4;
}

export function beatIndexFromBar(bar: number): number {
  return Math.round((bar - 1) * 4);
}

export function noteStartBeats(note: Note): number {
  return (note.bar - 1) * 4 + (note.beat - 1);
}

export function noteFromStartBeats(startBeats: number, pitch: number, duration: number, velocity: number): Note {
  const safeStart = Math.max(0, startBeats);
  return {
    bar: Math.floor(safeStart / 4) + 1,
    beat: (safeStart % 4) + 1,
    pitch,
    duration: Math.max(0.25, duration),
    velocity
  };
}

export function pitchToY(pitch: number, maxPitch: number, rowHeight: number): number {
  return (maxPitch - pitch) * rowHeight;
}

export function yToPitch(y: number, maxPitch: number, minPitch: number, rowHeight: number): number {
  const pitch = maxPitch - Math.floor(y / rowHeight);
  return Math.max(minPitch, Math.min(maxPitch, pitch));
}

export function keyForClip(key: ClipKey): string {
  return `${key.track}:${key.kind}:${key.id}`;
}

export function keyForNote(key: NoteKey): string {
  return `${key.track}:${key.clip}:${key.index}`;
}
