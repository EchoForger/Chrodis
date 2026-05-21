from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .model import Clip, Note, Project, Track


@dataclass
class MidiEvent:
    tick: int
    status: int
    data: bytes


def import_midi(path: Path, title: str | None = None) -> Project:
    data = path.read_bytes()
    if data[:4] != b"MThd":
        raise ValueError("not a standard MIDI file")
    header_len = int.from_bytes(data[4:8], "big")
    fmt = int.from_bytes(data[8:10], "big")
    track_count = int.from_bytes(data[10:12], "big")
    ppq = int.from_bytes(data[12:14], "big")
    offset = 8 + header_len
    project = Project(title=title or path.stem, bpm=120, length_bars=32)
    tracks: list[Track] = []
    for track_index in range(track_count):
        if data[offset:offset + 4] != b"MTrk":
            raise ValueError("invalid MIDI track chunk")
        length = int.from_bytes(data[offset + 4:offset + 8], "big")
        chunk = data[offset + 8:offset + 8 + length]
        offset += 8 + length
        track = parse_track(chunk, ppq, track_index, fmt)
        if track.clips or track.program is not None:
            tracks.append(track)
    project.tracks = tracks
    max_bar = 32
    for track in tracks:
        for clip in track.clips:
            max_bar = max(max_bar, int(clip.bar + clip.beats / 4 + 1))
    project.length_bars = max_bar
    return project


def parse_track(chunk: bytes, ppq: int, track_index: int, fmt: int) -> Track:
    tick = 0
    pos = 0
    running_status: int | None = None
    name = f"MIDI Track {track_index + 1}"
    program: int | None = None
    notes: list[Note] = []
    active: dict[tuple[int, int], tuple[int, int]] = {}
    channel = 9 if track_index == 9 else min(track_index, 15)
    while pos < len(chunk):
        delta, pos = read_vlq(chunk, pos)
        tick += delta
        status = chunk[pos]
        if status < 0x80:
            if running_status is None:
                raise ValueError("running status used before status byte")
            status = running_status
        else:
            pos += 1
            running_status = status
        if status == 0xFF:
            meta_type = chunk[pos]
            pos += 1
            length, pos = read_vlq(chunk, pos)
            payload = chunk[pos:pos + length]
            pos += length
            if meta_type == 0x03 and payload:
                name = payload.decode("utf-8", errors="replace")
            continue
        if status in (0xF0, 0xF7):
            length, pos = read_vlq(chunk, pos)
            pos += length
            continue
        event_type = status & 0xF0
        event_channel = status & 0x0F
        channel = event_channel
        if event_type in (0xC0, 0xD0):
            payload = chunk[pos:pos + 1]
            pos += 1
            if event_type == 0xC0:
                program = payload[0]
            continue
        payload = chunk[pos:pos + 2]
        pos += 2
        if event_type == 0x90 and payload[1] > 0:
            active[(event_channel, payload[0])] = (tick, payload[1])
        elif event_type in (0x80, 0x90):
            key = (event_channel, payload[0])
            if key in active:
                start_tick, velocity = active.pop(key)
                notes.append(note_from_ticks(start_tick, max(1, tick - start_tick), payload[0], velocity, ppq))
    kind = "drum" if channel == 9 else "instrument"
    clip_beats = max(4, max(((note.bar - 1) * 4 + note.beat - 1 + note.duration for note in notes), default=4))
    clip = Clip(id="imported", name=name, bar=1, beats=clip_beats, notes=notes)
    return Track(name=name, kind=kind, channel=channel, program=program, clips=[clip] if notes else [])


def note_from_ticks(start_tick: int, duration_ticks: int, pitch: int, velocity: int, ppq: int) -> Note:
    start_beats = start_tick / ppq
    bar = int(start_beats // 4) + 1
    beat = (start_beats % 4) + 1
    return Note(bar=bar, beat=beat, pitch=pitch, duration=duration_ticks / ppq, velocity=velocity)


def read_vlq(data: bytes, pos: int) -> tuple[int, int]:
    value = 0
    while True:
        byte = data[pos]
        pos += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, pos
