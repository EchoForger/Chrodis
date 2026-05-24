from __future__ import annotations

import math
import numpy as np

from .model import Effect


def apply_effects(buffer: np.ndarray, effects: list[Effect], sample_rate: int) -> np.ndarray:
    output = buffer
    for effect in effects:
        if not effect.enabled:
            continue
        params = effect.params
        if effect.type == "eq":
            output = apply_eq(output, sample_rate, params)
        elif effect.type == "gate":
            output = apply_gate(output, sample_rate, params)
        elif effect.type == "compressor":
            output = apply_compressor(output, sample_rate, params)
        elif effect.type == "limiter":
            output = apply_limiter(output, params)
        elif effect.type == "pitch_shifter":
            output = apply_pitch_shifter(output, params)
        elif effect.type == "reverb":
            output = apply_reverb(output, sample_rate, params)
        elif effect.type == "delay":
            output = apply_delay(output, sample_rate, params)
    return output


def apply_eq(buffer: np.ndarray, sample_rate: int, params: dict) -> np.ndarray:
    output = buffer
    for band in params.get("bands", []):
        kind = band.get("type", "peaking")
        freq = clamp(float(band.get("frequency", 1_000)), 20.0, sample_rate * 0.45)
        gain_db = clamp(float(band.get("gain_db", 0)), -24.0, 24.0)
        q = clamp(float(band.get("q", 0.707)), 0.1, 12.0)
        coeffs = biquad_coefficients(kind, freq, gain_db, q, sample_rate)
        output = biquad_filter(output, coeffs)
    return output


def biquad_coefficients(kind: str, freq: float, gain_db: float, q: float, sample_rate: int) -> tuple[float, ...]:
    a = 10 ** (gain_db / 40)
    omega = 2 * math.pi * freq / sample_rate
    sn = math.sin(omega)
    cs = math.cos(omega)
    alpha = sn / (2 * q)
    if kind == "low_shelf":
        beta = math.sqrt(a) / q
        b0 = a * ((a + 1) - (a - 1) * cs + beta * sn)
        b1 = 2 * a * ((a - 1) - (a + 1) * cs)
        b2 = a * ((a + 1) - (a - 1) * cs - beta * sn)
        a0 = (a + 1) + (a - 1) * cs + beta * sn
        a1 = -2 * ((a - 1) + (a + 1) * cs)
        a2 = (a + 1) + (a - 1) * cs - beta * sn
    elif kind == "high_shelf":
        beta = math.sqrt(a) / q
        b0 = a * ((a + 1) + (a - 1) * cs + beta * sn)
        b1 = -2 * a * ((a - 1) + (a + 1) * cs)
        b2 = a * ((a + 1) + (a - 1) * cs - beta * sn)
        a0 = (a + 1) - (a - 1) * cs + beta * sn
        a1 = 2 * ((a - 1) - (a + 1) * cs)
        a2 = (a + 1) - (a - 1) * cs - beta * sn
    else:
        b0 = 1 + alpha * a
        b1 = -2 * cs
        b2 = 1 - alpha * a
        a0 = 1 + alpha / a
        a1 = -2 * cs
        a2 = 1 - alpha / a
    return b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0


def biquad_filter(buffer: np.ndarray, coeffs: tuple[float, ...]) -> np.ndarray:
    b0, b1, b2, a1, a2 = coeffs
    output = np.zeros_like(buffer)
    for channel in range(buffer.shape[1]):
        x1 = x2 = y1 = y2 = 0.0
        for index, x0 in enumerate(buffer[:, channel]):
            y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            output[index, channel] = y0
            x2, x1 = x1, x0
            y2, y1 = y1, y0
    return output


def apply_compressor(buffer: np.ndarray, sample_rate: int, params: dict) -> np.ndarray:
    threshold = db_to_linear(float(params.get("threshold_db", -18)))
    ratio = clamp(float(params.get("ratio", 3)), 1.0, 40.0)
    makeup = db_to_linear(float(params.get("makeup_db", 0)))
    attack = math.exp(-1 / (sample_rate * clamp(float(params.get("attack", 0.01)), 0.0001, 2.0)))
    release = math.exp(-1 / (sample_rate * clamp(float(params.get("release", 0.08)), 0.001, 5.0)))
    envelope = 0.0
    output = np.zeros_like(buffer)
    for index, frame in enumerate(buffer):
        level = float(np.max(np.abs(frame)))
        coeff = attack if level > envelope else release
        envelope = coeff * envelope + (1 - coeff) * level
        if envelope > threshold:
            over = envelope / threshold
            gain = over ** (1 / ratio - 1)
        else:
            gain = 1.0
        output[index] = frame * gain * makeup
    return output


def apply_gate(buffer: np.ndarray, sample_rate: int, params: dict) -> np.ndarray:
    threshold = db_to_linear(float(params.get("threshold_db", -42)))
    attack = math.exp(-1 / (sample_rate * clamp(float(params.get("attack", 0.004)), 0.0001, 1.0)))
    release = math.exp(-1 / (sample_rate * clamp(float(params.get("release", 0.08)), 0.001, 5.0)))
    range_gain = db_to_linear(clamp(float(params.get("range_db", -48)), -80.0, 0.0))
    envelope = 0.0
    gate = 0.0
    output = np.zeros_like(buffer)
    for index, frame in enumerate(buffer):
        level = float(np.max(np.abs(frame)))
        envelope = max(level, envelope * release)
        target = 1.0 if envelope >= threshold else range_gain
        coeff = attack if target > gate else release
        gate = coeff * gate + (1 - coeff) * target
        output[index] = frame * gate
    return output


def apply_limiter(buffer: np.ndarray, params: dict) -> np.ndarray:
    ceiling = db_to_linear(float(params.get("ceiling_db", -0.8)))
    peak = float(np.max(np.abs(buffer))) if buffer.size else 0.0
    if peak <= ceiling or peak == 0:
        return buffer
    return buffer * (ceiling / peak)


def apply_pitch_shifter(buffer: np.ndarray, params: dict) -> np.ndarray:
    semitones = clamp(float(params.get("semitones", 0)), -24.0, 24.0)
    mix = clamp(float(params.get("mix", 1.0)), 0.0, 1.0)
    if abs(semitones) < 1e-6 or mix <= 0:
        return buffer
    factor = 2.0 ** (semitones / 12.0)
    source_positions = np.arange(buffer.shape[0], dtype=np.float64)
    shifted_positions = np.arange(buffer.shape[0], dtype=np.float64) * factor
    shifted = np.zeros_like(buffer)
    for channel in range(buffer.shape[1]):
        shifted[:, channel] = np.interp(shifted_positions, source_positions, buffer[:, channel], left=0.0, right=0.0)
    return buffer * (1.0 - mix) + shifted * mix


def apply_delay(buffer: np.ndarray, sample_rate: int, params: dict) -> np.ndarray:
    delay_samples = max(1, int(clamp(float(params.get("time", 0.25)), 0.001, 4.0) * sample_rate))
    feedback = clamp(float(params.get("feedback", 0.25)), 0.0, 0.95)
    mix = clamp(float(params.get("mix", 0.2)), 0.0, 1.0)
    output = np.copy(buffer)
    for index in range(delay_samples, len(output)):
        output[index] += output[index - delay_samples] * feedback * mix
    return output


def apply_reverb(buffer: np.ndarray, sample_rate: int, params: dict) -> np.ndarray:
    mix = clamp(float(params.get("mix", 0.18)), 0.0, 1.0)
    decay = clamp(float(params.get("decay", 0.45)), 0.0, 0.95)
    output = np.copy(buffer)
    for delay in (0.0297, 0.0371, 0.0411, 0.053):
        samples = max(1, int(delay * sample_rate))
        for index in range(samples, len(output)):
            output[index] += output[index - samples] * decay * mix / 4
    return output


def db_to_linear(value: float) -> float:
    return 10 ** (value / 20)


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))
