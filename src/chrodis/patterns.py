from __future__ import annotations

from .model import Note, Project


PROGRESSION = [(57, "min"), (53, "maj"), (48, "maj"), (55, "maj")]


def add_pattern(project: Project, track_name: str, pattern: str, start_bar: int, bars: int) -> None:
    track = project.find_track(track_name)
    if pattern == "piano-pulse":
        notes = piano_pulse(start_bar, bars)
    elif pattern == "sub-bass":
        notes = sub_bass(start_bar, bars)
    elif pattern == "four-on-floor":
        notes = four_on_floor(start_bar, bars)
    elif pattern == "pad":
        notes = pad(start_bar, bars)
    elif pattern == "lead-hook":
        notes = lead_hook(start_bar, bars)
    else:
        raise ValueError(f"unknown pattern: {pattern}")
    track.notes.extend(notes)


def chord(root: int, quality: str) -> list[int]:
    third = 3 if quality == "min" else 4
    return [root, root + third, root + 7]


def piano_pulse(start_bar: int, bars: int) -> list[Note]:
    notes: list[Note] = []
    picks = [0, 2, 1, 2, 3, 2, 1, 2]
    for bar in range(start_bar, start_bar + bars):
        root, quality = PROGRESSION[(bar - 1) % len(PROGRESSION)]
        tones = chord(root + 12, quality) + [root + 24]
        for step, pick in enumerate(picks):
            notes.append(Note(bar=bar, beat=1 + step * 0.5, pitch=tones[pick], duration=0.35, velocity=72))
    return notes


def sub_bass(start_bar: int, bars: int) -> list[Note]:
    notes: list[Note] = []
    roots = [45, 41, 36, 43]
    for bar in range(start_bar, start_bar + bars):
        root = roots[(bar - 1) % len(roots)]
        for beat in range(1, 5):
            notes.append(Note(bar=bar, beat=beat, pitch=root, duration=0.85, velocity=92))
    return notes


def four_on_floor(start_bar: int, bars: int) -> list[Note]:
    notes: list[Note] = []
    for bar in range(start_bar, start_bar + bars):
        for beat in range(1, 5):
            notes.append(Note(bar=bar, beat=beat, pitch=36, duration=0.1, velocity=105))
            notes.append(Note(bar=bar, beat=beat + 0.5, pitch=42, duration=0.1, velocity=62))
        for beat in (2, 4):
            notes.append(Note(bar=bar, beat=beat, pitch=38, duration=0.1, velocity=96))
    return notes


def pad(start_bar: int, bars: int) -> list[Note]:
    notes: list[Note] = []
    for bar in range(start_bar, start_bar + bars):
        root, quality = PROGRESSION[(bar - 1) % len(PROGRESSION)]
        for pitch in chord(root + 12, quality):
            notes.append(Note(bar=bar, beat=1, pitch=pitch, duration=3.85, velocity=54))
    return notes


def lead_hook(start_bar: int, bars: int) -> list[Note]:
    notes: list[Note] = []
    motif = [72, 72, 74, 76, 74, 72, 79, 76]
    answer = [71, 72, 74, 79, 76, 74, 72, 69]
    for bar in range(start_bar, start_bar + bars):
        line = motif if bar % 2 else answer
        for step, pitch in enumerate(line):
            notes.append(Note(bar=bar, beat=1 + step * 0.5, pitch=pitch, duration=0.35, velocity=86))
    return notes

