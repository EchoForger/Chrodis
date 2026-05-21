import React, { useEffect, useRef } from 'react';
import { type Clip } from '../api';
import { SHEET_LAYOUT, pitchToStaffStep, sheetCursorLabel, sheetCursorX } from '../lib/sheetMusic';

const IS_SHARP = [false, true, false, true, false, false, true, false, true, false, true, false];

export function SheetMusicView({ clip, cursorBeat }: { clip: Clip; cursorBeat: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const BEAT_W = SHEET_LAYOUT.beatWidth;
  const HEADER = SHEET_LAYOUT.headerWidth;
  const LINE_GAP = SHEET_LAYOUT.lineGap;
  const RULER_H = SHEET_LAYOUT.rulerHeight;
  const STAFF_Y = SHEET_LAYOUT.staffY;
  const NOTE_RX = SHEET_LAYOUT.noteRx;
  const NOTE_RY = SHEET_LAYOUT.noteRy;
  const BASS_OFFSET = LINE_GAP * 10;
  const safeCursorBeat = Math.max(0, Math.min(clip.beats, cursorBeat));
  const cursorX = sheetCursorX(cursorBeat, clip.beats);
  const totalWidth = HEADER + Math.max(clip.beats, 4) * BEAT_W + 80;
  const totalHeight = STAFF_Y + LINE_GAP * 4 + BASS_OFFSET + LINE_GAP * 4 + 60;

  function stepToY(step: number, treble: boolean): number {
    const baseStep = treble ? 2 : -14;
    const baseY = treble ? STAFF_Y + LINE_GAP * 4 : STAFF_Y + LINE_GAP * 4 + BASS_OFFSET;
    return baseY - (step - baseStep) * LINE_GAP / 2;
  }

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const target = Math.max(0, cursorX - wrap.clientWidth * 0.45);
    wrap.scrollTo({ left: target });
  }, [cursorX]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = totalWidth;
    canvas.height = totalHeight;
    ctx.clearRect(0, 0, totalWidth, totalHeight);
    ctx.fillStyle = '#f2f0e7';
    ctx.fillRect(0, 0, totalWidth, totalHeight);
    ctx.fillStyle = '#3b4048';
    ctx.fillRect(0, 0, totalWidth, RULER_H);
    ctx.strokeStyle = '#171a20';
    ctx.beginPath(); ctx.moveTo(0, RULER_H); ctx.lineTo(totalWidth, RULER_H); ctx.stroke();

    ctx.font = '12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
    for (let beat = 0; beat <= clip.beats; beat += 1) {
      const x = HEADER + beat * BEAT_W;
      const isBar = beat % 4 === 0;
      ctx.strokeStyle = isBar ? '#838782' : '#b6b8ae';
      ctx.lineWidth = isBar ? 1.2 : 0.8;
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, totalHeight - 26); ctx.stroke();
      if (isBar) {
        ctx.fillStyle = '#e8edf4';
        ctx.fillText(String(Math.floor(beat / 4) + 1), x + 6, 18);
      }
    }

    const drawStaff = (baseY: number) => {
      ctx.strokeStyle = '#1d1f21';
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        const y = baseY - i * LINE_GAP;
        ctx.beginPath(); ctx.moveTo(HEADER - 10, y); ctx.lineTo(totalWidth - 20, y); ctx.stroke();
      }
    };
    drawStaff(STAFF_Y + LINE_GAP * 4);
    drawStaff(STAFF_Y + LINE_GAP * 4 + BASS_OFFSET);

    ctx.fillStyle = '#151719';
    ctx.font = `${LINE_GAP * 7}px serif`;
    ctx.fillText('𝄞', 14, STAFF_Y + LINE_GAP * 5.5);
    ctx.font = `${LINE_GAP * 3.2}px serif`;
    ctx.fillText('4', 72, STAFF_Y + LINE_GAP * 2.2);
    ctx.fillText('4', 72, STAFF_Y + LINE_GAP * 4.2);
    ctx.font = `${LINE_GAP * 4}px serif`;
    ctx.fillText('𝄢', 18, STAFF_Y + LINE_GAP * 4 + BASS_OFFSET - LINE_GAP * 0.5);
    ctx.font = `${LINE_GAP * 2.2}px serif`;
    ctx.fillText('4', 74, STAFF_Y + LINE_GAP * 2.2 + BASS_OFFSET);
    ctx.fillText('4', 74, STAFF_Y + LINE_GAP * 4.2 + BASS_OFFSET);

    for (const note of clip.notes) {
      const beat = (note.bar - 1) * 4 + (note.beat - 1);
      const x = HEADER + beat * BEAT_W;
      const step = pitchToStaffStep(note.pitch);
      const isTreble = note.pitch >= 48;
      const y = stepToY(step, isTreble);
      const sharp = IS_SHARP[((note.pitch % 12) + 12) % 12];

      ctx.strokeStyle = '#1d1f21';
      ctx.lineWidth = 1;
      const bottomStep = isTreble ? 2 : -14;
      const topStep = isTreble ? 10 : -6;
      if (step < bottomStep) {
        for (let s = bottomStep - 2; s >= step; s -= 2) {
          const ly = stepToY(s, isTreble);
          ctx.beginPath(); ctx.moveTo(x - NOTE_RX - 3, ly); ctx.lineTo(x + NOTE_RX + 3, ly); ctx.stroke();
        }
      }
      if (step > topStep) {
        for (let s = topStep + 2; s <= step; s += 2) {
          const ly = stepToY(s, isTreble);
          ctx.beginPath(); ctx.moveTo(x - NOTE_RX - 3, ly); ctx.lineTo(x + NOTE_RX + 3, ly); ctx.stroke();
        }
      }

      if (sharp) { ctx.fillStyle = '#151719'; ctx.font = `${LINE_GAP * 1.4}px serif`; ctx.fillText('#', x - NOTE_RX - 10, y + 4); }

      ctx.fillStyle = '#050505';
      ctx.beginPath();
      ctx.ellipse(x, y, NOTE_RX, NOTE_RY, -0.25, 0, Math.PI * 2);
      ctx.fill();

      const stemUp = step < 6;
      ctx.strokeStyle = '#050505';
      ctx.lineWidth = 1.5;
      if (stemUp) {
        ctx.beginPath(); ctx.moveTo(x + NOTE_RX - 1, y); ctx.lineTo(x + NOTE_RX - 1, y - LINE_GAP * 3); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.moveTo(x - NOTE_RX + 1, y); ctx.lineTo(x - NOTE_RX + 1, y + LINE_GAP * 3); ctx.stroke();
      }
    }

    if (cursorBeat >= 0) {
      ctx.strokeStyle = 'rgba(47,115,200,0.92)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cursorX, RULER_H); ctx.lineTo(cursorX, totalHeight - 20); ctx.stroke();
      ctx.fillStyle = '#2f73c8';
      ctx.beginPath();
      ctx.moveTo(cursorX - 7, RULER_H);
      ctx.lineTo(cursorX + 7, RULER_H);
      ctx.lineTo(cursorX, RULER_H + 10);
      ctx.closePath();
      ctx.fill();
    }
  }, [clip, cursorBeat, cursorX, totalWidth, totalHeight]);

  return <div className="sheet-music-wrap" ref={wrapRef}>
    <div className="sheet-music-status">{sheetCursorLabel(safeCursorBeat, clip.beats)}</div>
    <canvas ref={canvasRef} />
  </div>;
}
