import { type Note } from './api';

export type ThumbnailNote = {
  leftPct: number;
  topPct: number;
  widthPct: number;
  opacity: number;
};

export function midiThumbnailNotes(notes: Note[], clipBeats: number, loopCount = 1): ThumbnailNote[] {
  if (!notes.length || clipBeats <= 0) return [];
  const loops = Math.max(1, Math.min(16, Math.floor(loopCount || 1)));
  const pitchValues = notes.map(note => note.pitch);
  const minPitch = Math.min(...pitchValues);
  const maxPitch = Math.max(...pitchValues);
  const pitchSpan = Math.max(1, maxPitch - minPitch);
  const result: ThumbnailNote[] = [];
  for (let loop = 0; loop < loops; loop += 1) {
    for (const note of notes) {
      const start = noteStart(note) + loop * clipBeats;
      const totalBeats = clipBeats * loops;
      if (start >= totalBeats) continue;
      result.push({
        leftPct: clampPct(start / totalBeats * 100),
        topPct: clampPct((maxPitch - note.pitch) / pitchSpan * 78 + 8),
        widthPct: clampPct(Math.max(1.2, note.duration / totalBeats * 100)),
        opacity: loop === 0 ? 0.92 : 0.62
      });
    }
  }
  return result;
}

function noteStart(note: Note): number {
  return (note.bar - 1) * 4 + (note.beat - 1);
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}
