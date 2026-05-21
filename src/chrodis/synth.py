from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any
import json
import math
import numpy as np

from .model import Note, Track


TAU = math.tau
DEFAULT_PRESET_LIBRARY = Path("presets/builtin.json")


@dataclass(frozen=True)
class SynthPreset:
    name: str
    data: dict[str, Any]


class PresetLibrary:
    def __init__(self, presets: dict[str, SynthPreset]):
        self.presets = presets

    @classmethod
    def load(cls, path: Path = DEFAULT_PRESET_LIBRARY) -> "PresetLibrary":
        if not path.exists():
            raise FileNotFoundError(f"preset library not found: {path}")
        data = json.loads(path.read_text(encoding="utf-8"))
        presets = {}
        for item in data.get("presets", []):
            name = str(item["name"])
            presets[name] = SynthPreset(name=name, data=item)
        return cls(presets)

    def get(self, name: str) -> SynthPreset:
        try:
            return self.presets[name]
        except KeyError as exc:
            available = ", ".join(sorted(self.presets))
            raise KeyError(f"preset not found: {name}; available presets: {available}") from exc

    def preset_for_track(self, track: Track) -> SynthPreset:
        return self.get(track.preset or fallback_preset_name(track.program))


def fallback_preset_name(program: int | None) -> str:
    if program is None:
        return "keys"
    if 32 <= program <= 39:
        return "bass"
    if 80 <= program <= 87:
        return "lead"
    if 88 <= program <= 95:
        return "pad"
    return "keys"


def render_note(preset: SynthPreset, note: Note, duration: float, sample_rate: int) -> np.ndarray:
    tail_seconds = float(preset.data.get("tail_seconds", 0.0))
    frames = max(1, round((duration + tail_seconds) * sample_rate))
    frequency = midi_to_hz(note.pitch)
    velocity = max(0.0, min(1.0, note.velocity / 127.0))
    velocity_settings = preset.data.get("velocity", {})
    velocity_amp = velocity ** float(velocity_settings.get("amplitude", 1.0))
    output_gain = float(preset.data.get("output_gain", 0.3))
    t = np.arange(frames, dtype=np.float64) / sample_rate
    env = amp_envelope_array(preset, frames, sample_rate)
    value = oscillator_sum_array(preset, frequency, note.pitch, t)
    value += noise_sample_array(preset, t)
    value = apply_filter(preset, value, frequency, velocity)
    return value * env * velocity_amp * output_gain


def oscillator_sum_array(preset: SynthPreset, frequency: float, pitch: int, t: np.ndarray) -> np.ndarray:
    value = np.zeros_like(t)
    for osc in preset.data.get("oscillators", []):
        wave = str(osc.get("wave", "sine"))
        ratio = float(osc.get("ratio", 1.0))
        gain = float(osc.get("gain", 1.0))
        detune = cents_to_ratio(float(osc.get("detune_cents", 0.0)))
        decay = float(osc.get("decay", 0.0))
        key_decay = float(osc.get("key_decay", 0.0))
        if decay > 0:
            pitch_factor = 2.0 ** ((60 - pitch) / 36.0)
            effective_decay = max(0.02, decay * (1.0 + key_decay * (pitch_factor - 1.0)))
            gain = gain * np.exp(-t / effective_decay)
        value += waveform_array(wave, frequency * ratio * detune, t) * gain
    return value


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
    if env.get("curve") == "exponential":
        levels[~attack_mask] = sustain + (1.0 - sustain) * np.exp(-t[~attack_mask] / decay_seconds)
    else:
        progress = np.minimum(1.0, t[~attack_mask] / decay_seconds)
        levels[~attack_mask] = 1.0 + (sustain - 1.0) * progress
    release_start = max(0, frames - release)
    if release_start < frames:
        release_curve = np.linspace(1.0, 0.0, frames - release_start, endpoint=False)
        levels[release_start:] *= release_curve
    return levels


def noise_sample_array(preset: SynthPreset, t: np.ndarray) -> np.ndarray:
    noise = preset.data.get("noise", {})
    if noise.get("type", "none") == "none":
        return np.zeros_like(t)
    gain = float(noise.get("gain", 0.0))
    decay = max(0.001, float(noise.get("decay", 0.02)))
    values = np.sin((t * 44_100 + 7_919) * 12.9898) * 43_758.5453
    return (2.0 * (values - np.floor(values)) - 1.0) * gain * np.exp(-t / decay)


def oscillator_sum(preset: SynthPreset, frequency: float, pitch: int, t: float) -> float:
    value = 0.0
    for osc in preset.data.get("oscillators", []):
        wave = str(osc.get("wave", "sine"))
        ratio = float(osc.get("ratio", 1.0))
        gain = float(osc.get("gain", 1.0))
        detune = cents_to_ratio(float(osc.get("detune_cents", 0.0)))
        decay = float(osc.get("decay", 0.0))
        key_decay = float(osc.get("key_decay", 0.0))
        if decay > 0:
            # Higher piano notes damp faster; lower notes ring longer.
            pitch_factor = 2.0 ** ((60 - pitch) / 36.0)
            effective_decay = max(0.02, decay * (1.0 + key_decay * (pitch_factor - 1.0)))
            gain *= math.exp(-t / effective_decay)
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
        if env.get("curve") == "exponential":
            level = sustain + (1.0 - sustain) * math.exp(-t / decay_seconds)
        else:
            decay = max(1, round(decay_seconds * sample_rate))
            progress = min(1.0, (offset - attack) / decay)
            level = 1.0 + (sustain - 1.0) * progress

    remaining = frames - offset
    if remaining < release:
        level *= max(0.0, remaining / release)
    return level


def noise_sample(preset: SynthPreset, t: float) -> float:
    noise = preset.data.get("noise", {})
    if noise.get("type", "none") == "none":
        return 0.0
    gain = float(noise.get("gain", 0.0))
    decay = max(0.001, float(noise.get("decay", 0.02)))
    return pseudo_noise(t, 7_919) * gain * math.exp(-t / decay)


def apply_filter(preset: SynthPreset, value, frequency: float, velocity: float):
    filter_data = preset.data.get("filter", {})
    if filter_data.get("type", "none") != "lowpass":
        return value
    cutoff = float(filter_data.get("cutoff_hz", 5_000))
    key_tracking = float(filter_data.get("key_tracking", 0.0))
    brightness = float(preset.data.get("velocity", {}).get("brightness", 0.0))
    effective_cutoff = cutoff + frequency * key_tracking + cutoff * brightness * velocity
    attenuation = min(1.0, max(0.08, effective_cutoff / max(effective_cutoff, frequency * 4.0)))
    return value * attenuation


def midi_to_hz(pitch: int) -> float:
    return 440.0 * (2.0 ** ((pitch - 69) / 12.0))


def cents_to_ratio(cents: float) -> float:
    return 2.0 ** (cents / 1200.0)


def pseudo_noise(t: float, seed: int) -> float:
    value = math.sin((t * 44_100 + seed) * 12.9898) * 43_758.5453
    return 2.0 * (value - math.floor(value)) - 1.0
