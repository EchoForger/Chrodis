from __future__ import annotations

from .model import Clip, Effect, Marker, Note, Project, Track


SECTION_MARKERS = [
    (1, "Intro"),
    (9, "Verse A"),
    (25, "Pre-Chorus"),
    (33, "Chorus"),
    (49, "Bridge"),
    (57, "Final Chorus"),
]


def compose_mandopop(title: str = "晚风里的光", minutes: float = 3.0) -> Project:
    bpm = 96
    length_bars = max(64, round(minutes * bpm / 4))
    length_bars = 72 if 68 <= length_bars <= 76 else length_bars
    project = Project(title=title, bpm=bpm, key="C", time_signature="4/4", length_bars=length_bars)
    project.markers = [Marker(bar=bar, name=name) for bar, name in SECTION_MARKERS]
    project.master_effects = [
        Effect(type="compressor", params={"threshold_db": -10, "ratio": 1.8, "attack": 0.02, "release": 0.12, "makeup_db": 1.5}),
        Effect(type="limiter", params={"ceiling_db": -0.8}),
    ]
    project.tracks = [
        Track(name="Piano", kind="instrument", channel=0, program=0, preset="piano", volume=90, effects=[Effect(type="eq", params={"bands": [{"type": "peaking", "frequency": 350, "gain_db": -2, "q": 1.0}]})]),
        Track(name="Bass", kind="instrument", channel=1, program=38, preset="bass", volume=86, effects=[Effect(type="compressor", params={"threshold_db": -16, "ratio": 3, "makeup_db": 1})]),
        Track(name="Pad", kind="instrument", channel=2, program=89, preset="pad", volume=74, effects=[Effect(type="reverb", params={"mix": 0.16, "decay": 0.35})]),
        Track(name="Lead Melody", kind="instrument", channel=3, program=81, preset="lead", volume=88, effects=[Effect(type="delay", params={"time": 0.24, "feedback": 0.18, "mix": 0.16})]),
        Track(name="Counter Melody", kind="instrument", channel=4, program=0, preset="keys", volume=76),
        Track(name="Drums", kind="drum", channel=9, volume=92),
    ]

    add_section(project, 1, 8, "Intro", piano=True, pad=True)
    add_section(project, 9, 16, "Verse A", piano=True, bass=True, drums="light", lead="verse")
    add_section(project, 25, 8, "Pre-Chorus", piano=True, bass=True, pad=True, drums="build", lead="pre")
    add_section(project, 33, 16, "Chorus", piano=True, bass=True, pad=True, drums="full", lead="chorus", counter=True)
    add_section(project, 49, 8, "Bridge", piano=True, pad=True, lead="bridge")
    add_section(project, 57, 16, "Final Chorus", piano=True, bass=True, pad=True, drums="final", lead="chorus", counter=True)
    return project


def add_section(
    project: Project,
    start_bar: int,
    bars: int,
    name: str,
    piano: bool = False,
    bass: bool = False,
    pad: bool = False,
    drums: str | None = None,
    lead: str | None = None,
    counter: bool = False,
) -> None:
    if piano:
        project.find_track("Piano").clips.append(make_clip(f"{name} Piano", start_bar, bars, piano_notes(bars)))
    if bass:
        project.find_track("Bass").clips.append(make_clip(f"{name} Bass", start_bar, bars, bass_notes(bars), "#2777d8"))
    if pad:
        project.find_track("Pad").clips.append(make_clip(f"{name} Pad", start_bar, bars, pad_notes(bars), "#38a856"))
    if drums:
        project.find_track("Drums").clips.append(make_clip(f"{name} Drums", start_bar, bars, drum_notes(bars, drums), "#2f73c8"))
    if lead:
        project.find_track("Lead Melody").clips.append(make_clip(f"{name} Lead", start_bar, bars, melody_notes(bars, lead), "#1fc04b"))
    if counter:
        project.find_track("Counter Melody").clips.append(make_clip(f"{name} Counter", start_bar, bars, counter_notes(bars), "#77cf6d"))


def make_clip(name: str, start_bar: int, bars: int, notes: list[Note], color: str = "#18a83a") -> Clip:
    return Clip(
        id=name.lower().replace(" ", "-"),
        name=name,
        bar=start_bar,
        beats=bars * 4,
        color=color,
        notes=notes,
    )


def progression_for_bar(bar: int) -> tuple[int, str]:
    progression = [(57, "min"), (53, "maj"), (48, "maj"), (55, "maj")]
    return progression[(bar - 1) % len(progression)]


def chord(root: int, quality: str) -> list[int]:
    return [root, root + (3 if quality == "min" else 4), root + 7]


def piano_notes(bars: int) -> list[Note]:
    notes: list[Note] = []
    pattern = [0, 2, 1, 2, 3, 2, 1, 2]
    for bar in range(1, bars + 1):
        root, quality = progression_for_bar(bar)
        tones = chord(root + 12, quality) + [root + 24]
        for step, pick in enumerate(pattern):
            notes.append(Note(bar=bar, beat=1 + step * 0.5, pitch=tones[pick], duration=0.45, velocity=66 + (bar % 4) * 3))
    return notes


def bass_notes(bars: int) -> list[Note]:
    notes: list[Note] = []
    roots = [45, 41, 36, 43]
    for bar in range(1, bars + 1):
        root = roots[(bar - 1) % len(roots)]
        for beat in range(1, 5):
            notes.append(Note(bar=bar, beat=beat, pitch=root, duration=0.9, velocity=88))
            if bar > bars // 2:
                notes.append(Note(bar=bar, beat=beat + 0.5, pitch=root + 12, duration=0.22, velocity=52))
    return notes


def pad_notes(bars: int) -> list[Note]:
    notes: list[Note] = []
    for bar in range(1, bars + 1):
        root, quality = progression_for_bar(bar)
        for pitch in chord(root + 12, quality):
            notes.append(Note(bar=bar, beat=1, pitch=pitch, duration=3.85, velocity=48))
    return notes


def melody_notes(bars: int, variant: str) -> list[Note]:
    motifs = {
        "verse": [69, 72, 74, 72, 69, 67, 69, 72],
        "pre": [72, 74, 76, 79, 76, 74, 72, 74],
        "chorus": [76, 79, 81, 79, 76, 74, 76, 79],
        "bridge": [67, 69, 72, 74, 72, 69, 67, 64],
    }
    line = motifs[variant]
    notes: list[Note] = []
    for bar in range(1, bars + 1):
        for step, pitch in enumerate(line):
            beat = 1 + step * 0.5
            dur = 0.42 if step not in (3, 7) else 0.75
            notes.append(Note(bar=bar, beat=beat, pitch=pitch + (12 if variant == "chorus" and bar > bars // 2 else 0), duration=dur, velocity=82))
    return notes


def counter_notes(bars: int) -> list[Note]:
    notes: list[Note] = []
    line = [84, 83, 81, 79]
    for bar in range(1, bars + 1):
        for index, pitch in enumerate(line):
            notes.append(Note(bar=bar, beat=1 + index, pitch=pitch, duration=0.65, velocity=54))
    return notes


def drum_notes(bars: int, mode: str) -> list[Note]:
    notes: list[Note] = []
    for bar in range(1, bars + 1):
        for beat in range(1, 5):
            notes.append(Note(bar=bar, beat=beat, pitch=36, duration=0.1, velocity=92 if mode == "light" else 108))
            hat_step = 1.0 if mode == "light" else 0.5
            if hat_step == 1.0:
                notes.append(Note(bar=bar, beat=beat + 0.5, pitch=42, duration=0.1, velocity=48))
        if mode != "light":
            for beat in (2, 4):
                notes.append(Note(bar=bar, beat=beat, pitch=38, duration=0.1, velocity=96))
        if mode in {"build", "final"} and bar % 4 == 0:
            for step in range(6):
                notes.append(Note(bar=bar, beat=3.0 + step * 0.16, pitch=38, duration=0.08, velocity=62 + step * 7))
    return notes
