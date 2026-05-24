from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any
import json
import math
import numpy as np

from .model import Note, Track


TAU = math.tau
DEFAULT_PRESET_LIBRARY = Path("presets")
RESERVED_PRESET_KEYS = frozenset({"inherits"})


@dataclass(frozen=True)
class SynthPreset:
    name: str
    data: dict[str, Any]


def normalize_synth_engine(value: Any) -> str:
    return "o3"


def is_plain_dict(value: Any) -> bool:
    return isinstance(value, dict)


def fallback_preset_name(program: int | None) -> str:
    if program is None:
        return "SYSTEM/键盘乐器/keys"
    if 32 <= program <= 39:
        return "SYSTEM/贝司/o3-bass"
    if 80 <= program <= 87:
        return "SYSTEM/合成器/o3-lead"
    if 88 <= program <= 95:
        return "SYSTEM/音垫/o3-pad"
    return "SYSTEM/键盘乐器/keys"


def resolve_preset_file_path(ref: str, system_dir: Path, user_dir: Path | None, project_dir: Path | None) -> Path:
    if ref.startswith("SYSTEM/"):
        return system_dir / (ref[len("SYSTEM/"):] + ".json")
    if ref.startswith("USER/"):
        if user_dir is None:
            raise FileNotFoundError(f"USER preset directory not configured: {ref!r}")
        return user_dir / (ref[len("USER/"):] + ".json")
    if ref.startswith("PROJECT/"):
        if project_dir is None:
            raise FileNotFoundError(f"PROJECT preset directory not configured: {ref!r}")
        return project_dir / (ref[len("PROJECT/"):] + ".json")
    raise ValueError(f"Preset reference must start with SYSTEM/, USER/, or PROJECT/: {ref!r}")


def apply_dot_overrides(base: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    """Apply dot-notation override keys on top of base. Returns a new dict; does not mutate base."""
    result = dict(base)
    for key, value in overrides.items():
        parts = key.split(".")
        if len(parts) == 1:
            result[key] = value
        else:
            *parents, leaf = parts
            obj = result
            for part in parents:
                child = obj.get(part)
                obj[part] = dict(child) if isinstance(child, dict) else {}
                obj = obj[part]
            obj[leaf] = value
    return result


def load_and_resolve_preset(
    ref: str,
    system_dir: Path,
    user_dir: Path | None = None,
    project_dir: Path | None = None,
    _seen: frozenset[str] = frozenset(),
) -> dict[str, Any]:
    if ref in _seen:
        raise ValueError(f"Circular preset inheritance detected: {ref!r}")
    path = resolve_preset_file_path(ref, system_dir, user_dir, project_dir)
    if not path.exists():
        raise FileNotFoundError(f"Preset not found: {ref!r} (looked in {path})")
    raw = json.loads(path.read_text(encoding="utf-8"))
    inherits = raw.get("inherits")
    overrides = {k: v for k, v in raw.items() if k not in RESERVED_PRESET_KEYS}
    if inherits:
        base = load_and_resolve_preset(inherits, system_dir, user_dir, project_dir, _seen | {ref})
        data = apply_dot_overrides(base, overrides)
    else:
        data = apply_dot_overrides({}, overrides)
    data["name"] = ref
    data["synth_engine"] = normalize_synth_engine(data.get("synth_engine"))
    if inherits:
        data["_inherits"] = inherits
    return data


class PresetResolver:
    def __init__(
        self,
        system_dir: Path = DEFAULT_PRESET_LIBRARY,
        user_dir: Path | None = None,
        project_dir: Path | None = None,
    ):
        self.system_dir = system_dir
        self.user_dir = user_dir
        self.project_dir = project_dir

    @classmethod
    def for_project(cls, project: Any, system_dir: Path = DEFAULT_PRESET_LIBRARY) -> "PresetResolver":
        project_dir: Path | None = None
        if project.source_path is not None:
            root = project.source_path.parent
            project_dir = root / "presets"
        return cls(system_dir=system_dir, project_dir=project_dir)

    def resolve(self, ref: str) -> SynthPreset:
        data = load_and_resolve_preset(ref, self.system_dir, self.user_dir, self.project_dir)
        return SynthPreset(name=ref, data=data)

    def preset_for_track(self, track: Any) -> SynthPreset:
        ref = track.preset or fallback_preset_name(track.program)
        return self.resolve(ref)

    def all_presets_for_api(self) -> list[dict[str, Any]]:
        presets: list[dict[str, Any]] = []
        for level, base_dir in [("SYSTEM", self.system_dir), ("USER", self.user_dir), ("PROJECT", self.project_dir)]:
            if not base_dir or not base_dir.exists():
                continue
            for item_path in sorted(base_dir.rglob("*.json")):
                rel = str(item_path.relative_to(base_dir).with_suffix("")).replace("\\", "/")
                ref = f"{level}/{rel}"
                try:
                    data = load_and_resolve_preset(ref, self.system_dir, self.user_dir, self.project_dir)
                    presets.append(data)
                except Exception:
                    pass
        return presets


# Keep old name for audio.py compatibility
PresetLibrary = PresetResolver


def deep_merge_preset(base: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in overrides.items():
        current = merged.get(key)
        if is_plain_dict(current) and is_plain_dict(value):
            merged[key] = deep_merge_preset(current, value)
        else:
            merged[key] = value
    return merged


def load_preset_library_data(path: Path = DEFAULT_PRESET_LIBRARY) -> dict[str, Any]:
    """Load all SYSTEM presets from a directory. Used by the API endpoint."""
    resolver = PresetResolver(system_dir=path)
    return {"version": 3, "presets": resolver.all_presets_for_api()}


def render_note(preset: SynthPreset, note: Note, duration: float, sample_rate: int) -> np.ndarray:
    tail_seconds = float(preset.data.get("tail_seconds", 0.0))
    frames = max(1, round((duration + tail_seconds) * sample_rate))
    frequency = midi_to_hz(note.pitch)
    velocity = max(0.0, min(1.0, note.velocity / 127.0))
    velocity_amp = velocity ** 1.1
    output_gain = float(preset.data.get("output_gain", 0.3))
    t = np.arange(frames, dtype=np.float64) / sample_rate
    env = amp_envelope_array(preset, frames, sample_rate)
    value = oscillator_sum_array(preset, frequency, note.pitch, t)
    return value * env * velocity_amp * output_gain


def oscillator_sum_array(preset: SynthPreset, frequency: float, pitch: int, t: np.ndarray) -> np.ndarray:
    value = np.zeros_like(t)
    for osc in o3_oscillators(preset):
        wave = str(osc.get("wave", "sine"))
        ratio = float(osc.get("ratio", 1.0))
        gain = float(osc.get("gain", 1.0))
        detune = cents_to_ratio(float(osc.get("detune_cents", 0.0)))
        value += waveform_array(wave, frequency * ratio * detune, t) * gain
    return value


def o3_oscillators(preset: SynthPreset) -> list[dict[str, Any]]:
    oscillators = preset.data.get("oscillators", [])
    if not isinstance(oscillators, list):
        oscillators = []
    defaults: list[dict[str, Any]] = [
        {"wave": "sine", "ratio": 1.0, "gain": 1.0, "detune_cents": 0.0},
        {"wave": "sine", "ratio": 2.0, "gain": 0.0, "detune_cents": 0.0},
        {"wave": "sine", "ratio": 0.5, "gain": 0.0, "detune_cents": 0.0},
    ]
    return [dict(defaults[index], **dict(oscillators[index] if index < len(oscillators) and isinstance(oscillators[index], dict) else {})) for index in range(3)]


def waveform_array(wave: str, frequency: float, t: np.ndarray) -> np.ndarray:
    if wave == "saw":
        return 2.0 * np.mod(frequency * t, 1.0) - 1.0
    if wave == "square":
        return np.where(np.sin(TAU * frequency * t) >= 0, 1.0, -1.0)
    if wave == "triangle":
        return 2.0 * np.abs(2.0 * np.mod(frequency * t, 1.0) - 1.0) - 1.0
    return np.sin(TAU * frequency * t)


def amp_envelope_array(preset: SynthPreset, frames: int, sample_rate: int) -> np.ndarray:
    env = preset.data.get("amp_envelope", {})
    attack = max(1, round(float(env.get("attack", 0.006)) * sample_rate))
    decay_seconds = max(0.001, float(env.get("decay", 0.2)))
    sustain = max(0.0, min(1.0, float(env.get("sustain", 0.7))))
    release = max(1, round(float(env.get("release", 0.06)) * sample_rate))
    offsets = np.arange(frames, dtype=np.float64)
    levels = np.empty(frames, dtype=np.float64)
    attack_mask = offsets < attack
    levels[attack_mask] = offsets[attack_mask] / attack
    t = np.maximum(0.0, (offsets - attack) / sample_rate)
    progress = np.minimum(1.0, t[~attack_mask] / decay_seconds)
    levels[~attack_mask] = 1.0 + (sustain - 1.0) * progress
    release_start = max(0, frames - release)
    if release_start < frames:
        release_curve = np.linspace(1.0, 0.0, frames - release_start, endpoint=False)
        levels[release_start:] *= release_curve
    return levels


def oscillator_sum(preset: SynthPreset, frequency: float, pitch: int, t: float) -> float:
    value = 0.0
    for osc in o3_oscillators(preset):
        wave = str(osc.get("wave", "sine"))
        ratio = float(osc.get("ratio", 1.0))
        gain = float(osc.get("gain", 1.0))
        detune = cents_to_ratio(float(osc.get("detune_cents", 0.0)))
        value += waveform(wave, frequency * ratio * detune, t) * gain
    return value


def waveform(wave: str, frequency: float, t: float) -> float:
    if wave == "saw":
        return 2.0 * ((frequency * t) % 1.0) - 1.0
    if wave == "square":
        return 1.0 if math.sin(TAU * frequency * t) >= 0 else -1.0
    if wave == "triangle":
        return 2.0 * abs(2.0 * ((frequency * t) % 1.0) - 1.0) - 1.0
    return math.sin(TAU * frequency * t)


def amp_envelope(preset: SynthPreset, offset: int, frames: int, sample_rate: int) -> float:
    env = preset.data.get("amp_envelope", {})
    attack = max(1, round(float(env.get("attack", 0.006)) * sample_rate))
    decay_seconds = max(0.001, float(env.get("decay", 0.2)))
    sustain = max(0.0, min(1.0, float(env.get("sustain", 0.7))))
    release = max(1, round(float(env.get("release", 0.06)) * sample_rate))

    if offset < attack:
        level = offset / attack
    else:
        t = (offset - attack) / sample_rate
        decay = max(1, round(decay_seconds * sample_rate))
        progress = min(1.0, (offset - attack) / decay)
        level = 1.0 + (sustain - 1.0) * progress

    remaining = frames - offset
    if remaining < release:
        level *= max(0.0, remaining / release)
    return level


def midi_to_hz(pitch: int) -> float:
    return 440.0 * (2.0 ** ((pitch - 69) / 12.0))


def cents_to_ratio(cents: float) -> float:
    return 2.0 ** (cents / 1200.0)
