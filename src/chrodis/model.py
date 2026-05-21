from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
import json


TrackKind = Literal["instrument", "drum", "audio"]


@dataclass
class Note:
    bar: float
    beat: float
    pitch: int
    duration: float
    velocity: int = 80

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Note":
        return cls(
            bar=float(data["bar"]),
            beat=float(data["beat"]),
            pitch=int(data["pitch"]),
            duration=float(data["duration"]),
            velocity=int(data.get("velocity", 80)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "bar": self.bar,
            "beat": self.beat,
            "pitch": self.pitch,
            "duration": self.duration,
            "velocity": self.velocity,
        }


@dataclass
class Clip:
    id: str
    name: str
    bar: float
    beats: float
    color: str = "#18a83a"
    loop_count: int = 1
    notes: list[Note] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Clip":
        return cls(
            id=str(data["id"]),
            name=str(data["name"]),
            bar=float(data["bar"]),
            beats=float(data["beats"]),
            color=str(data.get("color", "#18a83a")),
            loop_count=int(data.get("loop_count", 1)),
            notes=[Note.from_dict(item) for item in data.get("notes", [])],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "bar": self.bar,
            "beats": self.beats,
            "color": self.color,
            "loop_count": self.loop_count,
            "notes": [note.to_dict() for note in self.notes],
        }


@dataclass
class AudioClip:
    id: str
    name: str
    bar: float
    beats: float
    asset_path: str
    duration_seconds: float
    sample_rate: int
    channels: int
    color: str = "#2e7ccf"
    gain: float = 1.0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AudioClip":
        return cls(
            id=str(data["id"]),
            name=str(data["name"]),
            bar=float(data["bar"]),
            beats=float(data["beats"]),
            asset_path=str(data["asset_path"]),
            duration_seconds=float(data.get("duration_seconds", 0.0)),
            sample_rate=int(data.get("sample_rate", 44_100)),
            channels=int(data.get("channels", 1)),
            color=str(data.get("color", "#2e7ccf")),
            gain=float(data.get("gain", 1.0)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "bar": self.bar,
            "beats": self.beats,
            "asset_path": self.asset_path,
            "duration_seconds": self.duration_seconds,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "color": self.color,
            "gain": self.gain,
        }


@dataclass
class Marker:
    bar: float
    name: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Marker":
        return cls(bar=float(data["bar"]), name=str(data["name"]))

    def to_dict(self) -> dict[str, Any]:
        return {"bar": self.bar, "name": self.name}


@dataclass
class Effect:
    type: str
    enabled: bool = True
    params: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Effect":
        return cls(type=str(data["type"]), enabled=bool(data.get("enabled", True)), params=dict(data.get("params", {})))

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, "enabled": self.enabled, "params": self.params}


@dataclass
class Track:
    name: str
    kind: TrackKind
    channel: int
    program: int | None = None
    preset: str | None = None
    volume: int = 96
    pan: int = 64
    muted: bool = False
    solo: bool = False
    record_armed: bool = False
    effects: list[Effect] = field(default_factory=list)
    notes: list[Note] = field(default_factory=list)
    clips: list[Clip] = field(default_factory=list)
    audio_clips: list[AudioClip] = field(default_factory=list)
    synth_params: dict[str, Any] | None = None
    id: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Track":
        return cls(
            name=str(data["name"]),
            kind=data["kind"],
            channel=int(data["channel"]),
            program=None if data.get("program") is None else int(data["program"]),
            preset=None if data.get("preset") is None else str(data["preset"]),
            volume=int(data.get("volume", 96)),
            pan=int(data.get("pan", 64)),
            muted=bool(data.get("muted", False)),
            solo=bool(data.get("solo", False)),
            record_armed=bool(data.get("record_armed", False)),
            effects=[Effect.from_dict(item) for item in data.get("effects", [])],
            notes=[Note.from_dict(item) for item in data.get("notes", [])],
            clips=[Clip.from_dict(item) for item in data.get("clips", [])],
            audio_clips=[AudioClip.from_dict(item) for item in data.get("audio_clips", [])],
            synth_params=data.get("synth_params"),
            id=str(data.get("id", "")),
        )

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "name": self.name,
            "kind": self.kind,
            "channel": self.channel,
            "volume": self.volume,
            "pan": self.pan,
            "muted": self.muted,
            "solo": self.solo,
            "record_armed": self.record_armed,
            "effects": [effect.to_dict() for effect in self.effects],
            "notes": [note.to_dict() for note in self.notes],
            "clips": [clip.to_dict() for clip in self.clips],
            "audio_clips": [clip.to_dict() for clip in self.audio_clips],
        }
        if self.id:
            data["id"] = self.id
        if self.program is not None:
            data["program"] = self.program
        if self.preset is not None:
            data["preset"] = self.preset
        if self.synth_params is not None:
            data["synth_params"] = self.synth_params
        return data


@dataclass
class Project:
    title: str
    bpm: int = 120
    key: str = "C"
    time_signature: str = "4/4"
    length_bars: int = 32
    markers: list[Marker] = field(default_factory=list)
    tracks: list[Track] = field(default_factory=list)
    master_effects: list[Effect] = field(default_factory=list)
    source_path: Path | None = field(default=None, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Project":
        return cls(
            title=str(data["title"]),
            bpm=int(data.get("bpm", 120)),
            key=str(data.get("key", "C")),
            time_signature=str(data.get("time_signature", "4/4")),
            length_bars=int(data.get("length_bars", 32)),
            markers=[Marker.from_dict(item) for item in data.get("markers", [])],
            tracks=[Track.from_dict(item) for item in data.get("tracks", [])],
            master_effects=[Effect.from_dict(item) for item in data.get("master_effects", [])],
        )

    @classmethod
    def load(cls, path: Path) -> "Project":
        if path.suffix == ".chrodis" or path.is_dir():
            path = path / "project.json"
        project = cls.from_dict(json.loads(path.read_text(encoding="utf-8")))
        project.source_path = path
        return project

    def save(self, path: Path) -> None:
        original_path = path
        if path.suffix == ".chrodis" or path.is_dir():
            path.mkdir(parents=True, exist_ok=True)
            (path / "exports").mkdir(exist_ok=True)
            (path / "assets").mkdir(exist_ok=True)
            path = path / "project.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        self.source_path = path if not original_path.is_dir() else original_path / "project.json"

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "bpm": self.bpm,
            "key": self.key,
            "time_signature": self.time_signature,
            "length_bars": self.length_bars,
            "markers": [marker.to_dict() for marker in self.markers],
            "tracks": [track.to_dict() for track in self.tracks],
            "master_effects": [effect.to_dict() for effect in self.master_effects],
        }

    def find_track(self, name: str) -> Track:
        for track in self.tracks:
            if track.name == name:
                return track
        raise KeyError(f"track not found: {name}")

    def next_channel(self, kind: TrackKind) -> int:
        if kind == "drum":
            return 9
        used = {track.channel for track in self.tracks}
        for channel in range(16):
            if channel == 9:
                continue
            if channel not in used:
                return channel
        raise ValueError("no available MIDI channels")


def iter_track_notes(track: Track) -> list[Note]:
    notes = list(track.notes)
    for clip in track.clips:
        loops = max(1, clip.loop_count)
        for loop_index in range(loops):
            loop_offset = loop_index * clip.beats
            for note in clip.notes:
                absolute_beats = (clip.bar - 1) * 4 + loop_offset + (note.bar - 1) * 4 + (note.beat - 1)
                notes.append(
                    Note(
                        bar=int(absolute_beats // 4) + 1,
                        beat=(absolute_beats % 4) + 1,
                        pitch=note.pitch,
                        duration=note.duration,
                        velocity=note.velocity,
                    )
                )
    return notes


def renderable_tracks(project: Project) -> list[Track]:
    solo_tracks = [track for track in project.tracks if track.solo and not track.muted]
    if solo_tracks:
        return solo_tracks
    return [track for track in project.tracks if not track.muted]
