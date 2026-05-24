const TAU = Math.PI * 2;

export function synthSampleFlexis(voice) {
  const preset = voice.preset || {};
  const t = voice.ageSamples / sampleRate;
  const m = preset.macros || {};
  const tone = clamp(numberOr(0.55, m.tone), 0, 1);
  const shape = clamp(numberOr(0.35, m.shape), 0, 1);
  const motion = clamp(numberOr(0.2, m.motion), 0, 1);
  const drive = clamp(numberOr(0.08, m.drive), 0, 1);
  const mix = clamp(numberOr(0.72, m.mix), 0, 1);
  const phase = nextPhase(voice, 0, voice.frequency * (1 + motion * 0.035 * Math.sin(TAU * (0.25 + motion * 5) * t)));
  const tonal = simpleWave('sine', phase) * (0.75 - 0.25 * shape);
  const wave = wavetable(shape > 0.55 ? 'digital' : 'basic', nextPhase(voice, 1, voice.frequency * (1 + tone * 0.01)), shape) * (0.25 + 0.5 * shape);
  const sub = simpleWave('sine', nextPhase(voice, 2, voice.frequency * 0.5)) * (0.18 + 0.22 * (1 - tone));
  return finish(voice, preset, Math.tanh((tonal * mix + wave * (1 - mix + 0.25) + sub) * (1 + drive * 3)));
}

export function synthSampleSytrix(voice) {
  const preset = voice.preset || {};
  const t = voice.ageSamples / sampleRate;
  const ops = cachedList(voice, 'sytrixOps', preset, preset.operators, [
    { ratio: 1, level: 0.85, role: 'carrier', feedback: 0 },
    { ratio: 2, level: 0.35, role: 'modulator', feedback: 0 },
    { ratio: 3, level: 0.18, role: 'modulator', feedback: 0 },
    { ratio: 0.5, level: 0.25, role: 'carrier', feedback: 0 }
  ], 4);
  const matrix = Array.isArray(preset.matrix) ? preset.matrix : [[0, 0.42, 0.12, 0], [0, 0, 0.08, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const values = voice.sytrixValues || (voice.sytrixValues = new Array(ops.length).fill(0));
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    let phaseMod = numberOr(0, op.feedback) * Math.sin(TAU * voice.frequency * numberOr(1, op.ratio) * t) * 2;
    const row = Array.isArray(matrix[i]) ? matrix[i] : [];
    for (let j = 0; j < values.length; j += 1) phaseMod += values[j] * numberOr(0, row[j]) * 5;
    values[i] = Math.sin(TAU * voice.frequency * numberOr(1, op.ratio) * t + phaseMod) * numberOr(0.5, op.level);
  }
  let carrierSum = 0;
  let carrierCount = 0;
  for (let i = 0; i < values.length; i += 1) {
    if ((ops[i].role || 'carrier') === 'carrier') {
      carrierSum += values[i];
      carrierCount += 1;
    }
  }
  return finish(voice, preset, carrierSum / Math.max(1, carrierCount));
}

export function synthSampleHarmonis(voice) {
  const preset = voice.preset || {};
  const t = voice.ageSamples / sampleRate;
  const h = preset.harmonics || {};
  const count = Math.max(4, Math.min(32, Math.round(numberOr(16, h.count))));
  const brightness = clamp(numberOr(0.58, h.brightness), 0, 1);
  const oddEven = clamp(numberOr(0.1, h.odd_even), -1, 1);
  const tilt = Math.max(0.05, numberOr(1.1, h.tilt));
  const pluck = clamp(numberOr(0.2, h.pluck), 0, 1);
  const unison = Math.max(1, Math.min(5, Math.round(numberOr(1, h.unison))));
  let value = 0;
  for (let u = 0; u < unison; u += 1) {
    const detune = 1 + (u - (unison - 1) / 2) * 0.0025;
    for (let harmonic = 1; harmonic <= count; harmonic += 1) {
      const parity = 1 + oddEven * (harmonic % 2 ? 0.35 : -0.35);
      let amp = parity * (brightness ** (harmonic / 5)) / (harmonic ** tilt);
      if (pluck > 0) amp *= Math.exp(-t * pluck * harmonic * 1.8);
      value += Math.sin(TAU * voice.frequency * harmonic * detune * t) * amp;
    }
  }
  return finish(voice, preset, value / unison);
}

export function synthSamplePadis(voice) {
  const preset = voice.preset || {};
  const t = voice.ageSamples / sampleRate;
  const layers = cachedList(voice, 'padisLayers', preset, preset.layers, [
    { wave: 'vowel', ratio: 1, gain: 0.5, grain_size: 0.28, density: 0.55, motion: 0.18, spread: 0.25 },
    { wave: 'mirror', ratio: 1.5, gain: 0.34, grain_size: 0.45, density: 0.4, motion: 0.28, spread: 0.35 }
  ], 2);
  let value = 0;
  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i];
    const grainSize = Math.max(0.02, numberOr(0.25, layer.grain_size));
    const density = clamp(numberOr(0.5, layer.density), 0, 1);
    const motion = numberOr(0.2, layer.motion);
    const spread = numberOr(0.2, layer.spread);
    const frequency = voice.frequency * numberOr(1, layer.ratio) * (1 + spread * 0.015 * Math.sin(TAU * motion * t));
    const grainEnv = 0.55 + 0.45 * (Math.sin(TAU * (density * 8 + 0.2) * (t % grainSize) / grainSize) ** 2);
    value += wavetable(numberOr('vowel', layer.wave), nextPhase(voice, i, frequency), 0.35) * grainEnv * numberOr(0.4, layer.gain);
  }
  const texture = preset.texture || {};
  if (texture.noise !== false) value += pseudoNoise(t, numberOr(101, texture.seed)) * numberOr(0.035, texture.gain);
  return finish(voice, preset, value);
}

export function synthSampleDrumis(voice) {
  const preset = voice.preset || {};
  const t = voice.ageSamples / sampleRate;
  let kind = preset.drum_type || 'auto';
  if (kind === 'auto') {
    if (voice.pitch === 35 || voice.pitch === 36) kind = 'kick';
    else if (voice.pitch === 38 || voice.pitch === 40) kind = 'snare';
    else if (voice.pitch === 42 || voice.pitch === 44 || voice.pitch === 46) kind = 'hat';
    else if (voice.pitch === 39) kind = 'clap';
    else kind = 'perc';
  }
  const tone = preset.tone || {};
  const body = numberOr(0.8, tone.body);
  const snap = numberOr(0.35, tone.snap);
  const decay = Math.max(0.02, numberOr(0.28, tone.decay));
  const noise = pseudoNoise(t, numberOr(911, tone.seed));
  let value;
  if (kind === 'kick') {
    const f = 42 + 110 * Math.exp(-t * (18 + snap * 28));
    value = Math.sin(TAU * f * t) * Math.exp(-t / decay) * body;
  } else if (kind === 'snare') {
    value = (Math.sin(TAU * 185 * t) * 0.32 + noise * 0.68) * Math.exp(-t / decay) * body;
  } else if (kind === 'hat') {
    value = (noise - 0.55 * pseudoNoise(t + 0.0004, numberOr(911, tone.seed))) * Math.exp(-t / Math.max(0.025, decay * 0.32)) * body;
  } else if (kind === 'clap') {
    const bursts = [0, 0.018, 0.034].reduce((sum, offset) => sum + Math.exp(-((t - offset) ** 2) / 0.00018), 0);
    value = noise * bursts * body + noise * Math.exp(-t / decay) * 0.18;
  } else {
    value = (Math.sin(TAU * voice.frequency * t) * 0.45 + noise * 0.25) * Math.exp(-t / decay) * body;
  }
  return finish(voice, preset, value);
}

function finish(voice, preset, value) {
  const t = voice.ageSamples / sampleRate;
  return value * ampEnvelope(preset, t, voice.durationSeconds, voice.totalSeconds) * Math.pow(voice.velocity, 1.1) * numberOr(0.3, preset.output_gain);
}

function ampEnvelope(preset, t, durationSeconds, totalSeconds) {
  const env = preset.amp_envelope || {};
  const attack = Math.max(0.0001, numberOr(0.006, env.attack));
  const decay = Math.max(0.001, numberOr(0.2, env.decay));
  const sustain = clamp(numberOr(0.7, env.sustain), 0, 1);
  const release = Math.max(0.001, numberOr(0.08, env.release));
  let level = t < attack ? t / attack : 1 + (sustain - 1) * Math.min(1, (t - attack) / decay);
  const releaseStart = Math.max(0, totalSeconds - release);
  if (t > releaseStart) level *= Math.max(0, (totalSeconds - t) / release);
  if (durationSeconds <= 0.12 && t > durationSeconds) level *= Math.exp(-(t - durationSeconds) * 18);
  return level;
}

function synthList(source, defaults, count) {
  if (!Array.isArray(source)) source = [];
  return defaults.slice(0, count).map((item, index) => ({ ...item, ...(source[index] || {}) }));
}

function cachedList(voice, key, preset, source, defaults, count) {
  const presetKey = `${key}Preset`;
  if (voice[presetKey] === preset && voice[key]) return voice[key];
  voice[presetKey] = preset;
  voice[key] = synthList(source, defaults, count);
  return voice[key];
}

function nextPhase(voice, index, frequency) {
  const phase = voice.phases[index] || 0;
  voice.phases[index] = (phase + frequency / sampleRate) % 1;
  return phase;
}

function wavetable(wave, phase, warp) {
  if (wave === 'metal') return Math.tanh(Math.sin(TAU * phase) * (1 + 5 * warp) + 0.45 * Math.sin(TAU * phase * 7));
  if (wave === 'vowel') return 0.58 * Math.sin(TAU * phase) + 0.28 * Math.sin(TAU * phase * (2 + warp * 2)) + 0.18 * Math.sin(TAU * phase * 5);
  if (wave === 'digital') {
    const steps = Math.max(3, Math.round(18 - 14 * clamp(warp, 0, 1)));
    return 2 * (Math.floor(phase * steps) / Math.max(1, steps - 1)) - 1;
  }
  if (wave === 'mirror') {
    const folded = Math.abs(2 * phase - 1);
    return Math.sin(TAU * (folded + warp * Math.sin(TAU * phase) * 0.12));
  }
  return (1 - warp) * Math.sin(TAU * phase) + warp * (2 * phase - 1);
}

function simpleWave(wave, phase) {
  if (wave === 'square') return phase < 0.5 ? 1 : -1;
  if (wave === 'saw') return 2 * phase - 1;
  if (wave === 'triangle') return 2 * Math.abs(2 * phase - 1) - 1;
  return Math.sin(TAU * phase);
}

function pseudoNoise(t, seed) {
  const value = Math.sin((t * 44100 + seed) * 12.9898) * 43758.5453;
  return 2 * (value - Math.floor(value)) - 1;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function numberOr(fallback, value) {
  return value === undefined || value === null || Number.isNaN(value) ? fallback : value;
}
