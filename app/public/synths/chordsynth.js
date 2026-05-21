/**
 * CSynth — Chrodis Subtractive Synthesizer
 *
 * Full-featured subtractive synth engine:
 *   - Multiple oscillators with per-osc decay
 *   - ADSR amplitude envelope (linear or exponential curve)
 *   - Noise layer (hammer, pick, air types)
 *   - Lowpass filter with key-tracking and velocity brightness
 *   - Velocity amplitude scaling
 */

const TAU = Math.PI * 2;

export function synthSample(voice) {
  const preset = voice.preset;
  const t = voice.ageSamples / sampleRate;
  const velocitySettings = preset.velocity || {};
  const velocityAmp = Math.pow(voice.velocity, numberOr(1, velocitySettings.amplitude));
  const outputGain = numberOr(0.3, preset.output_gain);
  const env = ampEnvelope(preset, t, voice.durationSeconds, voice.totalSeconds);
  let value = 0;
  const oscillators = Array.isArray(preset.oscillators) ? preset.oscillators : [{ wave: 'sine', ratio: 1, gain: 1 }];
  for (let index = 0; index < oscillators.length; index += 1) {
    const osc = oscillators[index];
    const ratio = numberOr(1, osc.ratio);
    const detune = Math.pow(2, numberOr(0, osc.detune_cents) / 1200);
    const frequency = voice.frequency * ratio * detune;
    const phaseInc = frequency / sampleRate;
    const phase = voice.phases[index] || 0;
    const decay = numberOr(0, osc.decay);
    const decayGain = decay > 0 ? Math.exp(-t / Math.max(0.02, decay)) : 1;
    value += waveform(numberOr('sine', osc.wave), phase) * numberOr(1, osc.gain) * decayGain;
    voice.phases[index] = (phase + phaseInc) % 1;
  }
  value += noiseSample(preset, t);
  value = applyBrightnessFilter(preset, value, voice.frequency, voice.velocity);
  return value * env * velocityAmp * outputGain;
}

function ampEnvelope(preset, t, durationSeconds, totalSeconds) {
  const env = preset.amp_envelope || {};
  const attack = Math.max(0.0001, numberOr(0.006, env.attack));
  const decay = Math.max(0.001, numberOr(0.2, env.decay));
  const sustain = Math.max(0, Math.min(1, numberOr(0.7, env.sustain)));
  const release = Math.max(0.001, numberOr(0.06, env.release));
  let level;
  if (t < attack) level = t / attack;
  else if (env.curve === 'exponential') level = sustain + (1 - sustain) * Math.exp(-(t - attack) / decay);
  else level = 1 + (sustain - 1) * Math.min(1, (t - attack) / decay);
  const releaseStart = Math.max(0, totalSeconds - release);
  if (t > releaseStart) level *= Math.max(0, (totalSeconds - t) / release);
  if (durationSeconds <= 0.12 && t > durationSeconds) level *= Math.exp(-(t - durationSeconds) * 18);
  return level;
}

function waveform(wave, phase) {
  if (wave === 'saw') return 2 * phase - 1;
  if (wave === 'square') return phase < 0.5 ? 1 : -1;
  if (wave === 'triangle') return 2 * Math.abs(2 * phase - 1) - 1;
  return Math.sin(TAU * phase);
}

function noiseSample(preset, t) {
  const noise = preset.noise || {};
  if (!noise.type || noise.type === 'none') return 0;
  const gain = numberOr(0, noise.gain);
  const decay = Math.max(0.001, numberOr(0.02, noise.decay));
  return pseudoNoise(t, 7919) * gain * Math.exp(-t / decay);
}

function applyBrightnessFilter(preset, value, frequency, velocity) {
  const filter = preset.filter || {};
  if (filter.type !== 'lowpass') return value;
  const cutoff = numberOr(5000, filter.cutoff_hz);
  const keyTracking = numberOr(0, filter.key_tracking);
  const brightness = numberOr(0, (preset.velocity || {}).brightness);
  const effective = cutoff + frequency * keyTracking + cutoff * brightness * velocity;
  const attenuation = Math.min(1, Math.max(0.08, effective / Math.max(effective, frequency * 4)));
  return value * attenuation;
}

function pseudoNoise(t, seed) {
  const value = Math.sin((t * 44100 + seed) * 12.9898) * 43758.5453;
  return 2 * (value - Math.floor(value)) - 1;
}

function numberOr(fallback, value) {
  return value === undefined || value === null || Number.isNaN(value) ? fallback : value;
}
