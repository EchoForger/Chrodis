/**
 * Serumis — wavetable-style synthesizer inspired by modern visual synths.
 *
 * Two wavetable oscillators, sub, noise, ADSR envelope, simple filter, and LFO
 * modulation. This is intentionally compact enough for the realtime worklet.
 */

const TAU = Math.PI * 2;

export function synthSampleSerumis(voice) {
  const preset = voice.preset || {};
  const t = voice.ageSamples / sampleRate;
  const env = ampEnvelope(preset, t, voice.durationSeconds, voice.totalSeconds);
  const velocityAmp = Math.pow(voice.velocity, 1.08);
  let value = 0;
  const oscillators = serumisOscillators(voice, preset);
  for (let i = 0; i < oscillators.length; i += 1) {
    const osc = oscillators[i];
    if (osc.enabled === false) continue;
    const unison = Math.max(1, Math.min(7, Math.round(numberOr(1, osc.unison))));
    const blend = clamp(numberOr(0, osc.blend), 0, 1);
    const spread = numberOr(8, osc.spread_cents) * blend;
    let oscValue = 0;
    for (let u = 0; u < unison; u += 1) {
      const offset = unison === 1 ? 0 : (u - (unison - 1) / 2) / Math.max(1, (unison - 1) / 2);
      const ratio = numberOr(1, osc.ratio);
      const detune = Math.pow(2, (numberOr(0, osc.detune_cents) + offset * spread) / 1200);
      const frequency = voice.frequency * ratio * detune;
      const phaseIndex = i * 8 + u;
      const phase = voice.phases[phaseIndex] || 0;
      oscValue += wavetable(numberOr('basic', osc.wave), phase, numberOr(0, osc.warp));
      voice.phases[phaseIndex] = (phase + frequency / sampleRate) % 1;
    }
    value += (oscValue / unison) * numberOr(0.5, osc.gain);
  }

  const sub = preset.sub || {};
  if (sub.enabled) {
    const phase = voice.phases[30] || 0;
    value += simpleWave(numberOr('sine', sub.wave), phase) * numberOr(0.2, sub.gain);
    voice.phases[30] = (phase + voice.frequency * numberOr(0.5, sub.ratio) / sampleRate) % 1;
  }
  const noise = preset.noise || {};
  if (noise.enabled) value += pseudoNoise(t, numberOr(17, noise.seed)) * numberOr(0.05, noise.gain);

  value = applyFilter(preset, value, voice.frequency, t);
  return value * env * velocityAmp * numberOr(0.28, preset.output_gain);
}

function serumisOscillators(voice, preset) {
  if (voice.serumisPreset === preset && voice.serumisOscillators) return voice.serumisOscillators;
  const source = Array.isArray(preset.serumis_oscillators) ? preset.serumis_oscillators : [];
  const defaults = [
    { enabled: true, wave: 'basic', ratio: 1, gain: 0.52, detune_cents: 0, unison: 1, blend: 0, warp: 0 },
    { enabled: true, wave: 'metal', ratio: 1, gain: 0.38, detune_cents: 7, unison: 3, blend: 0.45, warp: 0.35 }
  ];
  voice.serumisPreset = preset;
  voice.serumisOscillators = defaults.map((osc, index) => ({ ...osc, ...(source[index] || {}) }));
  return voice.serumisOscillators;
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

function applyFilter(preset, value, frequency, t) {
  const filter = preset.filter || {};
  if (filter.enabled === false) return value;
  let cutoff = Math.max(40, numberOr(6000, filter.cutoff_hz));
  const lfo = preset.lfo || {};
  if (lfo.enabled) cutoff *= 1 + numberOr(0, lfo.filter_amount) * (0.5 + 0.5 * Math.sin(TAU * numberOr(2, lfo.rate_hz) * t));
  const resonance = clamp(numberOr(0.2, filter.resonance), 0, 1);
  let attenuation = Math.min(1, Math.max(0.05, cutoff / Math.max(cutoff, frequency * (2 + resonance * 8))));
  if (filter.type === 'highpass') attenuation = 1 - attenuation * 0.75;
  if (filter.type === 'bandpass') {
    const width = Math.max(120, cutoff * (0.3 + resonance));
    attenuation = Math.exp(-((frequency - cutoff) ** 2) / (2 * width * width));
  }
  return Math.tanh(value * (1 + clamp(numberOr(0, filter.drive), 0, 1) * 3)) * attenuation;
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
