const CHROMATIC_TO_DIATONIC = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];

export const SHEET_LAYOUT = {
  beatWidth: 56,
  headerWidth: 96,
  lineGap: 10,
  rulerHeight: 28,
  staffY: 92,
  noteRx: 6,
  noteRy: 4
} as const;

export function pitchToStaffStep(pitch: number): number {
  const rel = pitch - 60;
  const oct = Math.floor(rel / 12);
  const semi = ((rel % 12) + 12) % 12;
  return oct * 7 + CHROMATIC_TO_DIATONIC[semi];
}

export function sheetCursorX(cursorBeat: number, clipBeats: number): number {
  const safeBeat = Math.max(0, Math.min(clipBeats, cursorBeat));
  return SHEET_LAYOUT.headerWidth + safeBeat * SHEET_LAYOUT.beatWidth;
}

export function sheetCursorLabel(cursorBeat: number, clipBeats: number): string {
  const safeBeat = Math.max(0, Math.min(clipBeats, cursorBeat));
  const bar = Math.floor(safeBeat / 4) + 1;
  const beat = Math.floor(safeBeat % 4) + 1;
  return `${String(bar).padStart(3, '0')}:${beat}`;
}
