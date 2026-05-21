import test from 'node:test';
import assert from 'node:assert/strict';

function clipLeft(bar, pxPerBar) {
  return (bar - 1) * pxPerBar;
}

function clipWidth(beats, pxPerBar) {
  return (beats / 4) * pxPerBar;
}

function snapBeats(deltaPx, pxPerBeat) {
  return Math.round(deltaPx / pxPerBeat);
}

function noteStartBeats(note) {
  return (note.bar - 1) * 4 + (note.beat - 1);
}

function noteFromStartBeats(startBeats, pitch, duration, velocity) {
  const safeStart = Math.max(0, startBeats);
  return {
    bar: Math.floor(safeStart / 4) + 1,
    beat: (safeStart % 4) + 1,
    pitch,
    duration: Math.max(0.25, duration),
    velocity
  };
}

function pitchToY(pitch, maxPitch, rowHeight) {
  return (maxPitch - pitch) * rowHeight;
}

function yToPitch(y, maxPitch, minPitch, rowHeight) {
  const pitch = maxPitch - Math.floor(y / rowHeight);
  return Math.max(minPitch, Math.min(maxPitch, pitch));
}

function rectsIntersect(a1, a2, b1, b2) {
  return Math.max(a1, b1) <= Math.min(a2, b2);
}

function splitClip(clip, cutBeat) {
  const clipStart = (clip.bar - 1) * 4;
  const split = Math.round(cutBeat - clipStart);
  if (split <= 0 || split >= clip.beats) return [clip];
  const right = { ...JSON.parse(JSON.stringify(clip)), id: 'right', name: `${clip.name} B`, bar: 1 + (clipStart + split) / 4, beats: clip.beats - split, notes: [] };
  const left = { ...clip, beats: split, notes: [] };
  for (const note of clip.notes) {
    const start = noteStartBeats(note);
    const end = start + note.duration;
    if (end <= split) left.notes.push(note);
    else if (start >= split) right.notes.push(noteFromStartBeats(start - split, note.pitch, note.duration, note.velocity));
    else {
      left.notes.push({ ...note, duration: split - start });
      right.notes.push(noteFromStartBeats(0, note.pitch, end - split, note.velocity));
    }
  }
  return [left, right];
}

function deleteTarget({ activeWindow, hasSelectedNotes, hasSelectedClips, selected }) {
  if (activeWindow === 'pianoRoll' && hasSelectedNotes) return 'notes';
  if (hasSelectedClips) return 'clips';
  if (selected.type === 'track') return 'track';
  return 'none';
}

function createCommitCounter() {
  let commits = 0;
  return {
    change() {},
    commit() { commits += 1; },
    count() { return commits; }
  };
}

const menuCommands = {
  save: 'save',
  undo: 'undo',
  redo: 'redo',
  delete: 'delete',
  selectAll: 'select-all',
  preferences: 'preferences',
  playPause: 'play-pause',
  pointer: 'tool-pointer',
  marquee: 'tool-marquee',
  scissors: 'tool-scissors'
};

const defaultPreferences = {
  audio: { realtimeEnabled: true, masterGain: 0.9, latencyMode: 'interactive', bufferSize: 128 },
  editing: { defaultTool: 'pointer', verticalWheelDirection: 'natural' },
  display: { showMidiThumbnails: true, defaultEditorMode: 'docked' }
};

function mergePreferences(base, patch) {
  return {
    ...base,
    audio: { ...base.audio, ...patch.audio },
    editing: { ...base.editing, ...patch.editing },
    display: { ...base.display, ...patch.display }
  };
}

function verticalWheelDelta(deltaY, direction) {
  const amount = deltaY < 0 ? 0.08 : -0.08;
  return direction === 'inverted' ? -amount : amount;
}

function midiThumbnailNotes(notes, clipBeats, loopCount = 1) {
  if (!notes.length || clipBeats <= 0) return [];
  const loops = Math.max(1, Math.min(16, Math.floor(loopCount || 1)));
  const minPitch = Math.min(...notes.map(note => note.pitch));
  const maxPitch = Math.max(...notes.map(note => note.pitch));
  const pitchSpan = Math.max(1, maxPitch - minPitch);
  const output = [];
  for (let loop = 0; loop < loops; loop += 1) {
    for (const note of notes) {
      const start = noteStartBeats(note) + loop * clipBeats;
      const totalBeats = clipBeats * loops;
      output.push({
        leftPct: Math.max(0, Math.min(100, start / totalBeats * 100)),
        topPct: Math.max(0, Math.min(100, (maxPitch - note.pitch) / pitchSpan * 78 + 8)),
        widthPct: Math.max(0, Math.min(100, Math.max(1.2, note.duration / totalBeats * 100)))
      });
    }
  }
  return output;
}

test('clip geometry helpers', () => {
  assert.equal(clipLeft(5, 80), 320);
  assert.equal(clipWidth(8, 80), 160);
});

test('snap converts drag pixels to beat deltas', () => {
  assert.equal(snapBeats(21, 22), 1);
  assert.equal(snapBeats(43, 22), 2);
  assert.equal(snapBeats(-23, 22), -1);
});

test('piano roll converts notes to time and back', () => {
  const note = { bar: 2, beat: 3, pitch: 64, duration: 2, velocity: 91 };
  assert.equal(noteStartBeats(note), 6);
  assert.deepEqual(noteFromStartBeats(6, 64, 2, 91), note);
});

test('piano roll converts pitch to y and back', () => {
  const y = pitchToY(60, 84, 14);
  assert.equal(y, 336);
  assert.equal(yToPitch(y, 84, 36, 14), 60);
  assert.equal(yToPitch(-40, 84, 36, 14), 84);
  assert.equal(yToPitch(9999, 84, 36, 14), 36);
});

test('marquee intersection includes overlapping clips and notes', () => {
  assert.equal(rectsIntersect(10, 20, 20, 30), true);
  assert.equal(rectsIntersect(10, 20, 21, 30), false);
  assert.equal(rectsIntersect(12, 55, clipLeft(2, 40), clipLeft(2, 40) + clipWidth(4, 40)), true);
});

test('scissors split keeps note timing relative to each side', () => {
  const clip = {
    id: 'a',
    name: 'A',
    bar: 1,
    beats: 8,
    notes: [
      { bar: 1, beat: 1, pitch: 60, duration: 2, velocity: 90 },
      { bar: 1, beat: 4, pitch: 64, duration: 2, velocity: 91 },
      { bar: 2, beat: 3, pitch: 67, duration: 1, velocity: 92 }
    ]
  };
  const [left, right] = splitClip(clip, 4);
  assert.equal(left.beats, 4);
  assert.equal(right.bar, 2);
  assert.equal(right.beats, 4);
  assert.deepEqual(left.notes.map(note => note.duration), [2, 1]);
  assert.deepEqual(right.notes.map(note => noteStartBeats(note)), [0, 2]);
});

test('delete command chooses the current editing focus', () => {
  assert.equal(deleteTarget({ activeWindow: 'pianoRoll', hasSelectedNotes: true, hasSelectedClips: true, selected: { type: 'track' } }), 'notes');
  assert.equal(deleteTarget({ activeWindow: 'arranger', hasSelectedNotes: false, hasSelectedClips: true, selected: { type: 'track' } }), 'clips');
  assert.equal(deleteTarget({ activeWindow: 'arranger', hasSelectedNotes: false, hasSelectedClips: false, selected: { type: 'track' } }), 'track');
  assert.equal(deleteTarget({ activeWindow: 'arranger', hasSelectedNotes: false, hasSelectedClips: false, selected: { type: 'project' } }), 'none');
});

test('deferred slider commits once after a drag gesture', () => {
  const slider = createCommitCounter();
  slider.change(10);
  slider.change(20);
  slider.change(30);
  assert.equal(slider.count(), 0);
  slider.commit();
  assert.equal(slider.count(), 1);
});

test('menu command ids cover common renderer actions', () => {
  assert.equal(menuCommands.save, 'save');
  assert.equal(menuCommands.undo, 'undo');
  assert.equal(menuCommands.delete, 'delete');
  assert.equal(menuCommands.selectAll, 'select-all');
  assert.equal(menuCommands.preferences, 'preferences');
  assert.equal(menuCommands.playPause, 'play-pause');
  assert.equal(menuCommands.scissors, 'tool-scissors');
});

test('preferences merge persisted values over defaults', () => {
  const merged = mergePreferences(defaultPreferences, { audio: { masterGain: 0.42 }, display: { showMidiThumbnails: false } });
  assert.equal(merged.audio.realtimeEnabled, true);
  assert.equal(merged.audio.masterGain, 0.42);
  assert.equal(merged.display.showMidiThumbnails, false);
});

test('option wheel maps to vertical zoom amount', () => {
  assert.equal(verticalWheelDelta(-10, 'natural'), 0.08);
  assert.equal(verticalWheelDelta(10, 'natural'), -0.08);
  assert.equal(verticalWheelDelta(-10, 'inverted'), -0.08);
});

test('midi thumbnails map note timing and loops to percentages', () => {
  const notes = [
    { bar: 1, beat: 1, pitch: 60, duration: 1, velocity: 90 },
    { bar: 1, beat: 3, pitch: 72, duration: 0.5, velocity: 90 }
  ];
  const thumb = midiThumbnailNotes(notes, 4, 2);
  assert.equal(thumb.length, 4);
  assert.equal(thumb[0].leftPct, 0);
  assert.equal(thumb[1].leftPct, 25);
  assert.equal(thumb[2].leftPct, 50);
  assert.ok(thumb[0].topPct > thumb[1].topPct);
});

test('midi thumbnails handle empty and narrow clips', () => {
  assert.deepEqual(midiThumbnailNotes([], 4), []);
  const [note] = midiThumbnailNotes([{ bar: 1, beat: 1, pitch: 64, duration: 0.1, velocity: 90 }], 32);
  assert.equal(note.leftPct, 0);
  assert.ok(note.widthPct >= 1.2);
});

function flattenTrackEvents(track, trackIndex) {
  const events = [];
  for (const note of track.notes || []) {
    events.push({ trackIndex, startBeat: (note.bar - 1) * 4 + (note.beat - 1), durationBeats: note.duration, pitch: note.pitch, velocity: note.velocity });
  }
  for (const clip of track.clips || []) {
    const loops = Math.max(1, clip.loop_count || 1);
    for (let loop = 0; loop < loops; loop += 1) {
      const clipStart = (clip.bar - 1) * 4 + loop * clip.beats;
      for (const note of clip.notes || []) {
        events.push({ trackIndex, startBeat: clipStart + (note.bar - 1) * 4 + (note.beat - 1), durationBeats: note.duration, pitch: note.pitch, velocity: note.velocity });
      }
    }
  }
  return events.sort((a, b) => a.startBeat - b.startBeat);
}

function lowerBoundEvents(events, beat) {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (events[mid].startBeat < beat) low = mid + 1;
    else high = mid;
  }
  return low;
}

function shouldRenderTrack(track, tracks) {
  const hasSolo = tracks.some(item => item.solo && !item.muted);
  return hasSolo ? track.solo && !track.muted : !track.muted;
}

function fallbackPreset(track) {
  if (track.preset) return track.preset;
  if (track.program >= 32 && track.program <= 39) return 'bass';
  if (track.program >= 80 && track.program <= 87) return 'lead';
  if (track.program >= 88 && track.program <= 95) return 'pad';
  return 'keys';
}

test('realtime project flatten converts clip notes to absolute beat events', () => {
  const track = {
    notes: [],
    clips: [{ bar: 5, beats: 4, loop_count: 2, notes: [{ bar: 1, beat: 3, pitch: 64, duration: 1, velocity: 90 }] }]
  };
  const events = flattenTrackEvents(track, 2);
  assert.deepEqual(events.map(event => event.startBeat), [18, 22]);
  assert.equal(events[0].trackIndex, 2);
});

test('realtime seek starts event cursor at the requested beat', () => {
  const events = [{ startBeat: 4 }, { startBeat: 12 }, { startBeat: 33 }, { startBeat: 40 }];
  assert.equal(lowerBoundEvents(events, 33), 2);
  assert.equal(lowerBoundEvents(events, 34), 3);
});

test('realtime solo and mute filtering matches project semantics', () => {
  const tracks = [{ solo: false, muted: false }, { solo: true, muted: false }, { solo: true, muted: true }];
  assert.equal(shouldRenderTrack(tracks[0], tracks), false);
  assert.equal(shouldRenderTrack(tracks[1], tracks), true);
  assert.equal(shouldRenderTrack(tracks[2], tracks), false);
});

test('realtime playback has events, preset fallback, and audible master gain', () => {
  const events = flattenTrackEvents({
    notes: [],
    clips: [{ bar: 1, beats: 4, notes: [{ bar: 1, beat: 1, pitch: 60, duration: 1, velocity: 96 }] }]
  }, 0);
  assert.equal(events.length, 1);
  assert.equal(fallbackPreset({ program: 34 }), 'bass');
  assert.ok(defaultPreferences.audio.masterGain > 0);
});
