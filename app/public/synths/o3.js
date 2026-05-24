/**
 * O3 — Simple 3-Oscillator Synthesizer
 *
 * Minimal engine with exactly 3 oscillators:
 *   - Fixed 3-oscillator limit
 *   - ADSR amplitude envelope
 *   - No noise layer
 *   - No filter
 *   - Velocity amplitude scaling
 */

const TAU = Math.PI * 2;

export function synthSampleO3(voice) {
  const preset = voice.preset;
  const t = voice.ageSamples / sampleRate;
  const outputGain = numberOr(0.3, preset.output_gain);
  const env = ampEnvelopeO3(preset, t, voice.durationSeconds, voice.totalSeconds);
  const velocityAmp = Math.pow(voice.velocity, 1.1);
  let value = 0;
  const oscillators = o3Oscillators(preset);
  for (let i = 0; i < 3; i++) {
    const osc = oscillators[i];
    const ratio = numberOr(1, osc.ratio);
    const detune = Math.pow(2, numberOr(0, osc.detune_cents) / 1200);
    const frequency = voice.frequency * ratio * detune;
    const phase = voice.phases[i] || 0;
    value += waveformO3(numberOr('sine', osc.wave), phase) * numberOr(1, osc.gain);
    voice.phases[i] = (phase + frequency / sampleRate) % 1;
  }
  return value * env * velocityAmp * outputGain;
}

function o3Oscillators(preset) {
  const oscillators = Array.isArray(preset.oscillators) ? preset.oscillators : [];
  const defaults = [
    { wave: 'sine', ratio: 1, gain: 1, detune_cents: 0 },
    { wave: 'sine', ratio: 2, gain: 0, detune_cents: 0 },
    { wave: 'sine', ratio: 0.5, gain: 0, detune_cents: 0 }
  ];
  return defaults.map((osc, index) => ({ ...osc, ...(oscillators[index] || {}) }));
}

function ampEnvelopeO3(preset, t, durationSeconds, totalSeconds) {
  const env = preset.amp_envelope || {};
  const attack = Math.max(0.0001, numberOr(0.006, env.attack));
  const decay = Math.max(0.001, numberOr(0.2, env.decay));
  const sustain = Math.max(0, Math.min(1, numberOr(0.7, env.sustain)));
  const release = Math.max(0.001, numberOr(0.06, env.release));
  let level;
  if (t < attack) level = t / attack;
  else level = 1 + (sustain - 1) * Math.min(1, (t - attack) / decay);
  const releaseStart = Math.max(0, totalSeconds - release);
  if (t > releaseStart) level *= Math.max(0, (totalSeconds - t) / release);
  if (durationSeconds <= 0.12 && t > durationSeconds) level *= Math.exp(-(t - durationSeconds) * 18);
  return level;
}

function waveformO3(wave, phase) {
  if (wave === 'saw') return 2 * phase - 1;
  if (wave === 'square') return phase < 0.5 ? 1 : -1;
  if (wave === 'triangle') return 2 * Math.abs(2 * phase - 1) - 1;
  return Math.sin(TAU * phase);
}

function numberOr(fallback, value) {
  return value === undefined || value === null || Number.isNaN(value) ? fallback : value;
}
