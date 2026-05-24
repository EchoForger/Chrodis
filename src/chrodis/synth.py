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
LEGACY_SYSTEM_PRESET_REFS = {
    "Serumis/init": "初始化/serumis-init",
    "Serumis/metal-lead": "合成器/serumis-metal-lead",
    "Serumis/glass-pad": "音垫/serumis-glass-pad",
    "Flexis/init": "初始化/flexis-init",
    "Flexis/pop-keys": "键盘乐器/flexis-pop-keys",
    "Flexis/modern-bass": "贝司/flexis-modern-bass",
    "Sytrix/init": "初始化/sytrix-init",
    "Sytrix/fm-bell": "键盘乐器/sytrix-fm-bell",
    "Sytrix/digital-bass": "贝司/sytrix-digital-bass",
    "Harmonis/init": "初始化/harmonis-init",
    "Harmonis/bright-pluck": "合成器/harmonis-bright-pluck",
    "Harmonis/spectral-lead": "合成器/harmonis-spectral-lead",
    "Padis/init": "初始化/padis-init",
    "Padis/cinema-drone": "音垫/padis-cinema-drone",
    "Padis/glimmer-pad": "音垫/padis-glimmer-pad",
    "Drumis/init": "打击乐器/drumis-init",
    "Drumis/punch-kick": "打击乐器/drumis-punch-kick",
    "Drumis/snap-snare": "打击乐器/drumis-snap-snare",
}


@dataclass(frozen=True)
class SynthPreset:
    name: str
    data: dict[str, Any]


def normalize_synth_engine(value: Any) -> str:
    engine = str(value or "o3").lower()
    return engine if engine in {"o3", "serumis", "flexis", "sytrix", "harmonis", "padis", "drumis"} else "o3"


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
        rel = ref[len("SYSTEM/"):]
        path = system_dir / (rel + ".json")
        if not path.exists() and rel in LEGACY_SYSTEM_PRESET_REFS:
            return system_dir / (LEGACY_SYSTEM_PRESET_REFS[rel] + ".json")
        return path
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
    engine = preset.data.get("synth_engine")
    if engine == "serumis":
        value = serumis_sum_array(preset, frequency, t)
        value = apply_serumis_filter(preset, value, frequency, t)
    elif engine == "flexis":
        value = flexis_sum_array(preset, frequency, t)
    elif engine == "sytrix":
        value = sytrix_sum_array(preset, frequency, t)
    elif engine == "harmonis":
        value = harmonis_sum_array(preset, frequency, t)
    elif engine == "padis":
        value = padis_sum_array(preset, frequency, t)
    elif engine == "drumis":
        value = drumis_sum_array(preset, note.pitch, frequency, t)
    else:
        value = oscillator_sum_array(preset, frequency, note.pitch, t)
    return value * env * velocity_amp * output_gain


def flexis_sum_array(preset: SynthPreset, frequency: float, t: np.ndarray) -> np.ndarray:
    macros = preset.data.get("macros", {})
    tone = max(0.0, min(1.0, float(macros.get("tone", 0.55))))
    shape = max(0.0, min(1.0, float(macros.get("shape", 0.35))))
    motion = max(0.0, min(1.0, float(macros.get("motion", 0.2))))
    drive = max(0.0, min(1.0, float(macros.get("drive", 0.08))))
    mix = max(0.0, min(1.0, float(macros.get("mix", 0.72))))
    lfo = 1.0 + motion * 0.035 * np.sin(TAU * (0.25 + motion * 5.0) * t)
    tonal = waveform_array("sine", frequency * lfo, t) * (0.75 - 0.25 * shape)
    wave = wavetable_array("digital" if shape > 0.55 else "basic", frequency * (1.0 + tone * 0.01), t, shape) * (0.25 + 0.5 * shape)
    sub = waveform_array("sine", frequency * 0.5, t) * (0.18 + 0.22 * (1.0 - tone))
    value = tonal * mix + wave * (1.0 - mix + 0.25) + sub
    return np.tanh(value * (1.0 + drive * 3.0))


def sytrix_sum_array(preset: SynthPreset, frequency: float, t: np.ndarray) -> np.ndarray:
    operators = synth_list(preset.data.get("operators"), [
        {"ratio": 1.0, "level": 0.85, "role": "carrier", "feedback": 0.0},
        {"ratio": 2.0, "level": 0.35, "role": "modulator", "feedback": 0.0},
        {"ratio": 3.0, "level": 0.18, "role": "modulator", "feedback": 0.0},
        {"ratio": 0.5, "level": 0.25, "role": "carrier", "feedback": 0.0},
    ], 4)
    matrix = preset.data.get("matrix", [[0.0, 0.42, 0.12, 0.0], [0.0, 0.0, 0.08, 0.0], [0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0]])
    op_values: list[np.ndarray] = []
    for index, op in enumerate(operators):
        ratio = float(op.get("ratio", 1.0))
        level = float(op.get("level", 0.5))
        feedback = float(op.get("feedback", 0.0))
        phase_mod = np.zeros_like(t)
        row = matrix[index] if isinstance(matrix, list) and index < len(matrix) and isinstance(matrix[index], list) else []
        for mod_index, mod_value in enumerate(op_values):
            amount = float(row[mod_index]) if mod_index < len(row) else 0.0
            phase_mod += mod_value * amount * 5.0
        phase_mod += feedback * np.sin(TAU * frequency * ratio * t) * 2.0
        op_values.append(np.sin(TAU * frequency * ratio * t + phase_mod) * level)
    carriers = [value for value, op in zip(op_values, operators) if str(op.get("role", "carrier")) == "carrier"]
    return sum(carriers, np.zeros_like(t)) / max(1, len(carriers))


def harmonis_sum_array(preset: SynthPreset, frequency: float, t: np.ndarray) -> np.ndarray:
    data = preset.data.get("harmonics", {})
    count = max(4, min(32, int(data.get("count", 16))))
    brightness = max(0.0, min(1.0, float(data.get("brightness", 0.58))))
    odd_even = max(-1.0, min(1.0, float(data.get("odd_even", 0.1))))
    tilt = max(0.05, float(data.get("tilt", 1.1)))
    pluck = max(0.0, min(1.0, float(data.get("pluck", 0.2))))
    unison = max(1, min(5, int(data.get("unison", 1))))
    value = np.zeros_like(t)
    for voice in range(unison):
        detune = 1.0 + (voice - (unison - 1) / 2.0) * 0.0025
        for harmonic in range(1, count + 1):
            parity = 1.0 + odd_even * (0.35 if harmonic % 2 else -0.35)
            amp = parity * (brightness ** (harmonic / 5.0)) / (harmonic ** tilt)
            if pluck > 0:
                amp *= np.exp(-t * pluck * harmonic * 1.8)
            value += np.sin(TAU * frequency * harmonic * detune * t) * amp
    return value / max(1, unison)


def padis_sum_array(preset: SynthPreset, frequency: float, t: np.ndarray) -> np.ndarray:
    layers = synth_list(preset.data.get("layers"), [
        {"wave": "vowel", "ratio": 1.0, "gain": 0.5, "grain_size": 0.28, "density": 0.55, "motion": 0.18, "spread": 0.25},
        {"wave": "mirror", "ratio": 1.5, "gain": 0.34, "grain_size": 0.45, "density": 0.4, "motion": 0.28, "spread": 0.35},
    ], 2)
    value = np.zeros_like(t)
    texture = preset.data.get("texture", {})
    for layer in layers:
        wave = str(layer.get("wave", "vowel"))
        ratio = float(layer.get("ratio", 1.0))
        gain = float(layer.get("gain", 0.4))
        grain_size = max(0.02, float(layer.get("grain_size", 0.25)))
        density = max(0.0, min(1.0, float(layer.get("density", 0.5))))
        motion = float(layer.get("motion", 0.2))
        spread = float(layer.get("spread", 0.2))
        moving_freq = frequency * ratio * (1.0 + spread * 0.015 * np.sin(TAU * motion * t))
        grain_env = 0.55 + 0.45 * np.sin(TAU * (density * 8.0 + 0.2) * np.mod(t, grain_size) / grain_size) ** 2
        value += wavetable_array(wave, moving_freq, t + motion * 0.01 * np.sin(TAU * 0.13 * t), 0.35) * grain_env * gain
    if bool(texture.get("noise", True)):
        value += serumis_noise(t, int(texture.get("seed", 101))) * float(texture.get("gain", 0.035))
    return value


def drumis_sum_array(preset: SynthPreset, pitch: int, frequency: float, t: np.ndarray) -> np.ndarray:
    kit = str(preset.data.get("drum_type", "auto"))
    if kit == "auto":
        if pitch in {35, 36}:
            kit = "kick"
        elif pitch in {38, 40}:
            kit = "snare"
        elif pitch in {42, 44, 46}:
            kit = "hat"
        elif pitch in {39}:
            kit = "clap"
        else:
            kit = "perc"
    tone = preset.data.get("tone", {})
    body = float(tone.get("body", 0.8))
    snap = float(tone.get("snap", 0.35))
    decay = max(0.02, float(tone.get("decay", 0.28)))
    noise = serumis_noise(t, int(tone.get("seed", 911)))
    if kit == "kick":
        f = 42 + 110 * np.exp(-t * (18 + snap * 28))
        return np.sin(TAU * f * t) * np.exp(-t / decay) * body
    if kit == "snare":
        return (np.sin(TAU * 185 * t) * 0.32 + noise * 0.68) * np.exp(-t / decay) * body
    if kit == "hat":
        hp = noise - 0.55 * serumis_noise(t + 0.0004, int(tone.get("seed", 911)))
        return hp * np.exp(-t / max(0.025, decay * 0.32)) * body
    if kit == "clap":
        bursts = sum(np.exp(-((t - offset) ** 2) / 0.00018) for offset in (0.0, 0.018, 0.034))
        return noise * bursts * body + noise * np.exp(-t / decay) * 0.18
    return (np.sin(TAU * frequency * t) * 0.45 + noise * 0.25) * np.exp(-t / decay) * body


def synth_list(source: Any, defaults: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    if not isinstance(source, list):
        source = []
    return [dict(defaults[index], **dict(source[index] if index < len(source) and isinstance(source[index], dict) else {})) for index in range(count)]


def serumis_sum_array(preset: SynthPreset, frequency: float, t: np.ndarray) -> np.ndarray:
    value = np.zeros_like(t)
    for osc in serumis_oscillators(preset):
        if not bool(osc.get("enabled", True)):
            continue
        ratio = float(osc.get("ratio", 1.0))
        detune = cents_to_ratio(float(osc.get("detune_cents", 0.0)))
        gain = float(osc.get("gain", 0.5))
        warp = float(osc.get("warp", 0.0))
        unison = max(1, min(7, int(osc.get("unison", 1))))
        blend = max(0.0, min(1.0, float(osc.get("blend", 0.0))))
        spread = float(osc.get("spread_cents", 8.0)) * blend
        osc_value = np.zeros_like(t)
        for voice in range(unison):
            offset = 0.0 if unison == 1 else (voice - (unison - 1) / 2.0) / max(1.0, (unison - 1) / 2.0)
            osc_value += wavetable_array(str(osc.get("wave", "basic")), frequency * ratio * detune * cents_to_ratio(offset * spread), t, warp)
        value += (osc_value / unison) * gain
    sub = preset.data.get("sub", {})
    if bool(sub.get("enabled", False)):
        value += waveform_array(str(sub.get("wave", "sine")), frequency * float(sub.get("ratio", 0.5)), t) * float(sub.get("gain", 0.2))
    noise = preset.data.get("noise", {})
    if bool(noise.get("enabled", False)):
        value += serumis_noise(t, int(noise.get("seed", 17))) * float(noise.get("gain", 0.05))
    return value


def serumis_oscillators(preset: SynthPreset) -> list[dict[str, Any]]:
    source = preset.data.get("serumis_oscillators", [])
    if not isinstance(source, list):
        source = []
    defaults: list[dict[str, Any]] = [
        {"enabled": True, "wave": "basic", "ratio": 1.0, "gain": 0.52, "detune_cents": 0.0, "unison": 1, "blend": 0.0, "warp": 0.0},
        {"enabled": True, "wave": "metal", "ratio": 1.0, "gain": 0.38, "detune_cents": 7.0, "unison": 3, "blend": 0.45, "warp": 0.35},
    ]
    return [dict(defaults[index], **dict(source[index] if index < len(source) and isinstance(source[index], dict) else {})) for index in range(2)]


def wavetable_array(wave: str, frequency: float, t: np.ndarray, warp: float) -> np.ndarray:
    phase = np.mod(frequency * t, 1.0)
    if wave == "metal":
        return np.tanh(np.sin(TAU * phase) * (1.0 + 5.0 * warp) + 0.45 * np.sin(TAU * phase * 7.0))
    if wave == "vowel":
        return 0.58 * np.sin(TAU * phase) + 0.28 * np.sin(TAU * phase * (2.0 + warp * 2.0)) + 0.18 * np.sin(TAU * phase * 5.0)
    if wave == "digital":
        steps = max(3, round(18 - 14 * max(0.0, min(1.0, warp))))
        return 2.0 * (np.floor(phase * steps) / max(1, steps - 1)) - 1.0
    if wave == "mirror":
        folded = np.abs(2.0 * phase - 1.0)
        return np.sin(TAU * (folded + warp * np.sin(TAU * phase) * 0.12))
    return (1.0 - warp) * np.sin(TAU * phase) + warp * (2.0 * phase - 1.0)


def serumis_noise(t: np.ndarray, seed: int) -> np.ndarray:
    values = np.sin((t * 44_100 + seed) * 12.9898) * 43_758.5453
    return 2.0 * (values - np.floor(values)) - 1.0


def apply_serumis_filter(preset: SynthPreset, value: np.ndarray, frequency: float, t: np.ndarray) -> np.ndarray:
    filter_data = preset.data.get("filter", {})
    if not bool(filter_data.get("enabled", True)):
        return value
    cutoff = max(40.0, float(filter_data.get("cutoff_hz", 6_000)))
    resonance = max(0.0, min(1.0, float(filter_data.get("resonance", 0.2))))
    lfo = preset.data.get("lfo", {})
    if bool(lfo.get("enabled", False)):
        amount = float(lfo.get("filter_amount", 0.0))
        rate = float(lfo.get("rate_hz", 2.0))
        cutoff *= 1.0 + amount * (0.5 + 0.5 * np.sin(TAU * rate * t))
    attenuation = np.minimum(1.0, np.maximum(0.05, cutoff / np.maximum(cutoff, frequency * (2.0 + resonance * 8.0))))
    if filter_data.get("type", "lowpass") == "highpass":
        attenuation = 1.0 - attenuation * 0.75
    if filter_data.get("type", "lowpass") == "bandpass":
        center = cutoff
        width = np.maximum(120.0, cutoff * (0.3 + resonance))
        attenuation = np.exp(-((frequency - center) ** 2) / (2.0 * width * width))
    drive = max(0.0, min(1.0, float(filter_data.get("drive", 0.0))))
    return np.tanh(value * (1.0 + drive * 3.0)) * attenuation


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
