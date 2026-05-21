from __future__ import annotations

from pathlib import Path
import math
import numpy as np
import wave

from .effects import apply_effects
from .model import AudioClip, Note, Project, Track, iter_track_notes, renderable_tracks
from .synth import DEFAULT_PRESET_LIBRARY, PresetResolver, render_note


DEFAULT_SAMPLE_RATE = 44_100
TAU = math.tau


def export_wav(
    project: Project,
    path: Path,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    preset_library_path: Path = DEFAULT_PRESET_LIBRARY,
) -> None:
    """Render a project to a stereo 16-bit PCM WAV using JSON-backed synth presets."""
    resolver = PresetResolver.for_project(project, system_dir=preset_library_path)
    total_seconds = project_duration_seconds(project, resolver)
    total_frames = max(1, math.ceil(total_seconds * sample_rate))
    mix = np.zeros((total_frames, 2), dtype=np.float64)

    for track in renderable_tracks(project):
        mix += render_track(project, track, total_frames, sample_rate, resolver)

    mix = apply_effects(mix, project.master_effects, sample_rate)
    mix = normalize(mix)
    write_wav(path, mix, sample_rate)


def render_track(
    project: Project,
    track: Track,
    total_frames: int,
    sample_rate: int,
    preset_library: PresetResolver,
) -> np.ndarray:
    buffer = np.zeros((total_frames, 2), dtype=np.float64)
    gain = (track.volume / 127.0) ** 1.5
    pan = max(0.0, min(1.0, track.pan / 127.0))
    left_gain = math.cos(pan * math.pi / 2.0) * gain
    right_gain = math.sin(pan * math.pi / 2.0) * gain

    for note in iter_track_notes(track):
        start = seconds_at(project, note.bar, note.beat)
        duration = beats_to_seconds(project, note.duration)
        if track.kind == "drum":
            render_drum(note, start, duration, buffer, sample_rate, left_gain, right_gain)
        elif track.kind != "audio":
            render_instrument(track, note, start, duration, buffer, sample_rate, left_gain, right_gain, preset_library)
    for clip in track.audio_clips:
        render_audio_clip(project, track, clip, buffer, sample_rate, left_gain, right_gain)
    return apply_effects(buffer, track.effects, sample_rate)


def render_audio_clip(
    project: Project,
    track: Track,
    clip: AudioClip,
    buffer: np.ndarray,
    sample_rate: int,
    left_gain: float,
    right_gain: float,
) -> None:
    audio_path = resolve_asset_path(project, clip.asset_path)
    if not audio_path.exists():
        return
    samples, source_rate = read_wav_float(audio_path)
    if source_rate != sample_rate:
        samples = resample_audio(samples, source_rate, sample_rate)
    start_frame = max(0, round(seconds_at(project, clip.bar, 1) * sample_rate))
    max_frames = max(1, round(beats_to_seconds(project, clip.beats) * sample_rate))
    count = min(max_frames, samples.shape[0], max(0, buffer.shape[0] - start_frame))
    if count <= 0:
        return
    mono_or_stereo = samples[:count]
    gain = float(clip.gain)
    if mono_or_stereo.shape[1] == 1:
        buffer[start_frame : start_frame + count, 0] += mono_or_stereo[:, 0] * left_gain * gain
        buffer[start_frame : start_frame + count, 1] += mono_or_stereo[:, 0] * right_gain * gain
    else:
        buffer[start_frame : start_frame + count, 0] += mono_or_stereo[:, 0] * left_gain * gain
        buffer[start_frame : start_frame + count, 1] += mono_or_stereo[:, 1] * right_gain * gain


def render_instrument(
    track: Track,
    note: Note,
    start: float,
    duration: float,
    buffer: np.ndarray,
    sample_rate: int,
    left_gain: float,
    right_gain: float,
    preset_library: PresetResolver,
) -> None:
    start_frame = max(0, round(start * sample_rate))
    samples = render_note(preset_library.preset_for_track(track), note, duration, sample_rate)
    end_frame = min(buffer.shape[0], start_frame + len(samples))
    count = max(0, end_frame - start_frame)
    if count:
        buffer[start_frame:end_frame, 0] += samples[:count] * left_gain
        buffer[start_frame:end_frame, 1] += samples[:count] * right_gain


def render_drum(
    note: Note,
    start: float,
    duration: float,
    buffer: np.ndarray,
    sample_rate: int,
    left_gain: float,
    right_gain: float,
) -> None:
    start_frame = max(0, round(start * sample_rate))
    frames = max(1, round(max(duration, 0.08) * sample_rate))
    velocity_gain = (note.velocity / 127.0) ** 1.1
    end_frame = min(buffer.shape[0], start_frame + frames)
    count = max(0, end_frame - start_frame)
    if count:
        t = np.arange(count, dtype=np.float64) / sample_rate
        samples = drum_sample(note.pitch, t) * velocity_gain
        buffer[start_frame:end_frame, 0] += samples * left_gain
        buffer[start_frame:end_frame, 1] += samples * right_gain


def drum_sample(pitch: int, t):
    if pitch == 36:
        frequency = 55 + 95 * math.exp(-t * 35)
        return np.sin(TAU * frequency * t) * np.exp(-t * 18) * 0.9
    if pitch == 38:
        noise = pseudo_noise(t, 3_101)
        tone = math.sin(TAU * 190 * t) * math.exp(-t * 24)
        return (noise * np.exp(-t * 18) * 0.55) + tone * 0.25
    if pitch in (42, 46):
        decay = 55 if pitch == 42 else 18
        return highpass_noise(t, 11_003) * np.exp(-t * decay) * 0.35
    return np.sin(TAU * midi_to_hz(pitch) * t) * np.exp(-t * 16) * 0.25


def project_duration_seconds(project: Project, preset_library: PresetResolver | None = None) -> float:
    latest = 4.0
    for track in project.tracks:
        tail_seconds = 0.0
        if preset_library is not None and track.kind != "drum":
            tail_seconds = float(preset_library.preset_for_track(track).data.get("tail_seconds", 0.0))
        tail_beats = tail_seconds * project.bpm / 60.0
        for note in iter_track_notes(track):
            end_beats = (note.bar - 1) * 4 + (note.beat - 1) + note.duration + tail_beats
            latest = max(latest, end_beats)
        for clip in track.audio_clips:
            latest = max(latest, (clip.bar - 1) * 4 + clip.beats)
    return (latest * 60.0 / project.bpm) + 1.0


def seconds_at(project: Project, bar: float, beat: float) -> float:
    return ((bar - 1) * 4 + (beat - 1)) * 60.0 / project.bpm


def beats_to_seconds(project: Project, beats: float) -> float:
    return beats * 60.0 / project.bpm


def midi_to_hz(pitch: int) -> float:
    return 440.0 * (2.0 ** ((pitch - 69) / 12.0))


def pseudo_noise(t, seed: int):
    value = np.sin((t * 44_100 + seed) * 12.9898) * 43_758.5453
    return 2.0 * (value - np.floor(value)) - 1.0


def highpass_noise(t: float, seed: int) -> float:
    return pseudo_noise(t, seed) - 0.5 * pseudo_noise(t + 0.0007, seed)


def normalize(buffer: np.ndarray) -> np.ndarray:
    peak = max(float(np.max(np.abs(buffer))), 1e-9)
    if peak <= 0.95:
        return buffer
    return buffer * (0.95 / peak)


def write_wav(path: Path, buffer: np.ndarray, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(buffer, -1.0, 1.0)
    pcm = np.round(pcm * 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())


def resolve_asset_path(project: Project, asset_path: str) -> Path:
    path = Path(asset_path)
    if path.is_absolute():
        return path
    if project.source_path is not None:
        return project.source_path.parent / path
    return path


def read_wav_float(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        sample_rate = handle.getframerate()
        frames = handle.getnframes()
        raw = handle.readframes(frames)
    if sample_width == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    elif sample_width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif sample_width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    else:
        raise ValueError(f"unsupported WAV sample width: {sample_width}")
    return data.reshape((-1, channels)), sample_rate


def resample_audio(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if samples.size == 0 or source_rate == target_rate:
        return samples
    source_positions = np.arange(samples.shape[0], dtype=np.float64)
    target_length = max(1, round(samples.shape[0] * target_rate / source_rate))
    target_positions = np.linspace(0, samples.shape[0] - 1, target_length)
    channels = [np.interp(target_positions, source_positions, samples[:, channel]) for channel in range(samples.shape[1])]
    return np.stack(channels, axis=1)


def float_to_i16(value: float) -> int:
    value = max(-1.0, min(1.0, value))
    return int(round(value * 32767))
