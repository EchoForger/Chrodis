import { synthSampleO3 } from './synths/o3.js';
import { synthSampleSerumis } from './synths/serumis.js';
import { synthSampleDrumis, synthSampleFlexis, synthSampleHarmonis, synthSamplePadis, synthSampleSytrix } from './synths/core-synths.js';

const TAU = Math.PI * 2;
const MAX_VOICES = 96;

class ChrodisWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.project = { bpm: 120, lengthBeats: 128, tracks: [], events: [], audioEvents: [], presets: {}, masterEffects: [] };
    this.audioBuffers = {};
    this.masterGain = 0.9;
    this.playing = false;
    this.currentBeat = 0;
    this.eventCursor = 0;
    this.voices = [];
    this.voiceLeft = 0;
    this.voiceRight = 0;
    this.audioLeft = 0;
    this.audioRight = 0;
    this.trackLeft = new Float32Array(0);
    this.trackRight = new Float32Array(0);
    this.effectStates = {};
    this.positionCountdown = 0;
    this.port.onmessage = event => this.handleMessage(event.data);
  }

  handleMessage(message) {
    if (!message || !message.type) return;
    if (message.type === 'loadProject') {
      this.project = message.project;
      this.project.events = this.project.events || [];
      this.project.audioEvents = this.project.audioEvents || [];
      this.project.masterEffects = this.project.masterEffects || [];
      this.project.events.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
      this.audioBuffers = message.audioBuffers || {};
      this.trackLeft = new Float32Array(this.project.tracks.length);
      this.trackRight = new Float32Array(this.project.tracks.length);
      this.effectStates = {};
      this.seekTo(this.currentBeat);
    } else if (message.type === 'setMasterGain') {
      this.masterGain = Math.max(0, Math.min(1.5, numberOr(0.9, message.gain)));
    } else if (message.type === 'play') {
      this.playing = true;
      this.seekTo(numberOr(this.currentBeat, message.beat));
    } else if (message.type === 'pause') {
      this.playing = false;
    } else if (message.type === 'stop') {
      this.playing = false;
      this.seekTo(numberOr(0, message.beat));
    } else if (message.type === 'seek') {
      this.seekTo(numberOr(0, message.beat));
    } else if (message.type === 'previewNote') {
      this.voices = this.voices.filter(v => !v.isPreview);
      const preset = message.preset || {};
      const durationSeconds = 10;
      const tailSeconds = numberOr(0.3, preset.tail_seconds);
      this.voices.push({
        kind: 'instrument',
        engine: preset.synth_engine || 'o3',
        preset,
        pitch: message.pitch,
        frequency: midiToHz(message.pitch),
        velocity: Math.max(0, Math.min(1, numberOr(0.8, message.velocity))),
        durationSeconds,
        totalSeconds: durationSeconds + tailSeconds,
        ageSamples: 0,
        phases: [],
        isPreview: true,
        trackIndex: -1,
        gain: 1,
        leftGain: 0.7,
        rightGain: 0.7
      });
    } else if (message.type === 'stopPreviewNote') {
      const releaseTime = 0.15;
      for (const voice of this.voices) {
        if (voice.isPreview && (message.pitch === undefined || voice.pitch === message.pitch)) {
          voice.totalSeconds = voice.ageSamples / sampleRate + releaseTime;
          voice.isPreview = false;
        }
      }
    }
  }

  seekTo(beat) {
    this.currentBeat = Math.max(0, beat);
    this.eventCursor = lowerBoundEvents(this.project.events, this.currentBeat);
    this.voices = [];
    this.addOverlappingVoices(this.currentBeat);
  }

  addOverlappingVoices(beat) {
    const lookback = beat - 16;
    for (let index = Math.max(0, lowerBoundEvents(this.project.events, lookback)); index < this.eventCursor; index += 1) {
      const event = this.project.events[index];
      const track = this.project.tracks[event.trackIndex];
      if (!track || !shouldRenderTrack(track, this.project.tracks)) continue;
      const preset = this.project.presets[track.preset] || this.project.presets.keys || {};
      const tailBeats = numberOr(0, preset.tail_seconds) * this.project.bpm / 60;
      if (event.startBeat + event.durationBeats + tailBeats > beat) {
        this.startVoice(event, beat);
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    left.fill(0);
    right.fill(0);
    if (!this.playing) return true;

    const beatPerSample = this.project.bpm / 60 / sampleRate;
    for (let frame = 0; frame < left.length; frame += 1) {
      this.trackLeft.fill(0);
      this.trackRight.fill(0);
      this.scheduleEvents(this.currentBeat);
      this.renderVoices();
      this.renderAudioClips(this.currentBeat);
      let sumLeft = this.voiceLeft + this.audioLeft;
      let sumRight = this.voiceRight + this.audioRight;
      for (let trackIndex = 0; trackIndex < this.project.tracks.length; trackIndex += 1) {
        let trackLeft = this.trackLeft[trackIndex];
        let trackRight = this.trackRight[trackIndex];
        if (trackLeft || trackRight) {
          const processed = this.applyEffectChain(trackLeft, trackRight, this.project.tracks[trackIndex].effects || [], `t${trackIndex}`);
          sumLeft += processed.left;
          sumRight += processed.right;
        }
      }
      const master = this.applyEffectChain(sumLeft, sumRight, this.project.masterEffects || [], 'm');
      left[frame] = softLimit(master.left * this.masterGain);
      right[frame] = softLimit(master.right * this.masterGain);
      this.currentBeat += beatPerSample;
      this.positionCountdown -= 1;
      if (this.positionCountdown <= 0) {
        this.positionCountdown = Math.round(sampleRate / 20);
        this.port.postMessage({ type: 'position', beat: this.currentBeat, seconds: this.currentBeat * 60 / this.project.bpm });
      }
    }
    return true;
  }

  scheduleEvents(beat) {
    while (this.eventCursor < this.project.events.length && this.project.events[this.eventCursor].startBeat <= beat) {
      const event = this.project.events[this.eventCursor];
      const track = this.project.tracks[event.trackIndex];
      if (track && shouldRenderTrack(track, this.project.tracks)) this.startVoice(event, beat);
      this.eventCursor += 1;
    }
  }

  startVoice(event, atBeat) {
    const track = this.project.tracks[event.trackIndex];
    const basePreset = this.project.presets[track.preset] || this.project.presets.keys || {};
    const preset = track.synthParams ? mergePresetParams(basePreset, track.synthParams) : basePreset;
    const ageSeconds = Math.max(0, (atBeat - event.startBeat) * 60 / this.project.bpm);
    const durationSeconds = event.durationBeats * 60 / this.project.bpm;
    const tailSeconds = numberOr(track.kind === 'drum' ? 0.25 : 0.2, preset.tail_seconds);
    const velocity = Math.max(0, Math.min(1, event.velocity / 127));
    const pan = Math.max(0, Math.min(1, track.pan / 127));
    const gain = Math.pow(track.volume / 127, 1.5);
    if (ageSeconds >= durationSeconds + tailSeconds) return;
    this.voices.push({
      kind: track.kind,
      engine: preset.synth_engine || 'o3',
      preset,
      pitch: event.pitch,
      frequency: midiToHz(event.pitch),
      velocity,
      durationSeconds,
      totalSeconds: durationSeconds + tailSeconds,
      ageSamples: Math.round(ageSeconds * sampleRate),
      phases: [],
      trackIndex: event.trackIndex,
      gain,
      leftGain: Math.cos(pan * Math.PI / 2) * gain,
      rightGain: Math.sin(pan * Math.PI / 2) * gain
    });
    if (this.voices.length > MAX_VOICES) this.voices.splice(0, this.voices.length - MAX_VOICES);
  }

  renderVoices() {
    let left = 0;
    let right = 0;
    for (let index = this.voices.length - 1; index >= 0; index -= 1) {
      const voice = this.voices[index];
      const sample = voice.kind === 'drum' && voice.engine !== 'drumis' ? drumSample(voice)
        : voice.engine === 'serumis' ? synthSampleSerumis(voice)
        : voice.engine === 'flexis' ? synthSampleFlexis(voice)
        : voice.engine === 'sytrix' ? synthSampleSytrix(voice)
        : voice.engine === 'harmonis' ? synthSampleHarmonis(voice)
        : voice.engine === 'padis' ? synthSamplePadis(voice)
        : voice.engine === 'drumis' ? synthSampleDrumis(voice)
        : synthSampleO3(voice);
      if (voice.trackIndex >= 0 && voice.trackIndex < this.trackLeft.length) {
        this.trackLeft[voice.trackIndex] += sample * voice.leftGain;
        this.trackRight[voice.trackIndex] += sample * voice.rightGain;
      } else {
        left += sample * voice.leftGain;
        right += sample * voice.rightGain;
      }
      voice.ageSamples += 1;
      if (voice.ageSamples >= voice.totalSeconds * sampleRate) this.voices.splice(index, 1);
    }
    this.voiceLeft = left;
    this.voiceRight = right;
  }

  renderAudioClips(beat) {
    let left = 0;
    let right = 0;
    if (!this.project.audioEvents?.length) {
      this.audioLeft = 0;
      this.audioRight = 0;
      return;
    }
    for (const event of this.project.audioEvents || []) {
      const track = this.project.tracks[event.trackIndex];
      const buffer = this.audioBuffers[event.assetPath];
      if (!track || !buffer || !shouldRenderTrack(track, this.project.tracks)) continue;
      if (beat < event.startBeat || beat >= event.startBeat + event.durationBeats) continue;
      const seconds = (beat - event.startBeat) * 60 / this.project.bpm;
      const sourceIndex = Math.floor(seconds * buffer.sampleRate);
      const channels = buffer.channels || [];
      if (!channels[0] || sourceIndex < 0 || sourceIndex >= channels[0].length) continue;
      const gain = numberOr(1, event.gain) * Math.pow(track.volume / 127, 1.5);
      const pan = Math.max(0, Math.min(1, track.pan / 127));
      const leftGain = Math.cos(pan * Math.PI / 2) * gain;
      const rightGain = Math.sin(pan * Math.PI / 2) * gain;
      this.trackLeft[event.trackIndex] += channels[0][sourceIndex] * leftGain;
      this.trackRight[event.trackIndex] += (channels[1] || channels[0])[sourceIndex] * rightGain;
    }
    this.audioLeft = left;
    this.audioRight = right;
  }

  applyEffectChain(left, right, effects, scope) {
    let l = left;
    let r = right;
    for (let index = 0; index < effects.length; index += 1) {
      const effect = effects[index];
      if (!effect || effect.enabled === false) continue;
      const state = this.effectState(`${scope}:${index}:${effect.type}`);
      const processed = applyEffectSample(l, r, effect, state);
      l = processed.left;
      r = processed.right;
    }
    return { left: l, right: r };
  }

  effectState(key) {
    return this.effectStates[key] || (this.effectStates[key] = {});
  }
}


function applyEffectSample(left, right, effect, state) {
  const params = effect.params || {};
  if (effect.type === 'eq') return applyEqSample(left, right, params, state);
  if (effect.type === 'gate') return applyGateSample(left, right, params, state);
  if (effect.type === 'compressor') return applyCompressorSample(left, right, params, state);
  if (effect.type === 'limiter') return applyLimiterSample(left, right, params);
  if (effect.type === 'delay') return applyDelaySample(left, right, params, state);
  if (effect.type === 'reverb') return applyReverbSample(left, right, params, state);
  return { left, right };
}

function applyEqSample(left, right, params, state) {
  const bands = Array.isArray(params.bands) ? params.bands : [];
  let l = left;
  let r = right;
  if (!state.bands || state.source !== bands) {
    state.source = bands;
    state.bands = bands.map(band => ({
      coeffs: biquadCoefficients(
        band.type || 'peaking',
        clamp(numberOr(1000, band.frequency), 20, sampleRate * 0.45),
        clamp(numberOr(0, band.gain_db), -24, 24),
        clamp(numberOr(0.707, band.q), 0.1, 12)
      ),
      lx1: 0, lx2: 0, ly1: 0, ly2: 0,
      rx1: 0, rx2: 0, ry1: 0, ry2: 0
    }));
  }
  for (const band of state.bands) {
    const c = band.coeffs;
    const nextL = c.b0 * l + c.b1 * band.lx1 + c.b2 * band.lx2 - c.a1 * band.ly1 - c.a2 * band.ly2;
    band.lx2 = band.lx1; band.lx1 = l; band.ly2 = band.ly1; band.ly1 = nextL;
    l = nextL;
    const nextR = c.b0 * r + c.b1 * band.rx1 + c.b2 * band.rx2 - c.a1 * band.ry1 - c.a2 * band.ry2;
    band.rx2 = band.rx1; band.rx1 = r; band.ry2 = band.ry1; band.ry1 = nextR;
    r = nextR;
  }
  return { left: l, right: r };
}

function biquadCoefficients(kind, freq, gainDb, q) {
  const a = 10 ** (gainDb / 40);
  const omega = TAU * freq / sampleRate;
  const sn = Math.sin(omega);
  const cs = Math.cos(omega);
  const alpha = sn / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'low_shelf') {
    const beta = Math.sqrt(a) / q;
    b0 = a * ((a + 1) - (a - 1) * cs + beta * sn);
    b1 = 2 * a * ((a - 1) - (a + 1) * cs);
    b2 = a * ((a + 1) - (a - 1) * cs - beta * sn);
    a0 = (a + 1) + (a - 1) * cs + beta * sn;
    a1 = -2 * ((a - 1) + (a + 1) * cs);
    a2 = (a + 1) + (a - 1) * cs - beta * sn;
  } else if (kind === 'high_shelf') {
    const beta = Math.sqrt(a) / q;
    b0 = a * ((a + 1) + (a - 1) * cs + beta * sn);
    b1 = -2 * a * ((a - 1) + (a + 1) * cs);
    b2 = a * ((a + 1) + (a - 1) * cs - beta * sn);
    a0 = (a + 1) - (a - 1) * cs + beta * sn;
    a1 = 2 * ((a - 1) - (a + 1) * cs);
    a2 = (a + 1) - (a - 1) * cs - beta * sn;
  } else {
    b0 = 1 + alpha * a;
    b1 = -2 * cs;
    b2 = 1 - alpha * a;
    a0 = 1 + alpha / a;
    a1 = -2 * cs;
    a2 = 1 - alpha / a;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function applyGateSample(left, right, params, state) {
  const threshold = dbToLinear(numberOr(-42, params.threshold_db));
  const range = dbToLinear(clamp(numberOr(-48, params.range_db), -80, 0));
  const attack = coeff(numberOr(0.004, params.attack));
  const release = coeff(numberOr(0.08, params.release));
  const level = Math.max(Math.abs(left), Math.abs(right));
  state.envelope = Math.max(level, numberOr(0, state.envelope) * release);
  const target = state.envelope >= threshold ? 1 : range;
  const current = numberOr(0, state.gain);
  const c = target > current ? attack : release;
  state.gain = c * current + (1 - c) * target;
  return { left: left * state.gain, right: right * state.gain };
}

function applyCompressorSample(left, right, params, state) {
  const threshold = dbToLinear(numberOr(-18, params.threshold_db));
  const ratio = clamp(numberOr(3, params.ratio), 1, 40);
  const makeup = dbToLinear(numberOr(0, params.makeup_db));
  const attack = coeff(numberOr(0.01, params.attack));
  const release = coeff(numberOr(0.08, params.release));
  const level = Math.max(Math.abs(left), Math.abs(right));
  const current = numberOr(0, state.envelope);
  const c = level > current ? attack : release;
  state.envelope = c * current + (1 - c) * level;
  let gain = 1;
  if (state.envelope > threshold && threshold > 0) {
    gain = (state.envelope / threshold) ** (1 / ratio - 1);
  }
  return { left: left * gain * makeup, right: right * gain * makeup };
}

function applyLimiterSample(left, right, params) {
  const ceiling = dbToLinear(numberOr(-0.8, params.ceiling_db));
  const peak = Math.max(Math.abs(left), Math.abs(right));
  if (peak <= ceiling || peak <= 0) return { left, right };
  const gain = ceiling / peak;
  return { left: left * gain, right: right * gain };
}

function applyDelaySample(left, right, params, state) {
  const delaySamples = Math.max(1, Math.round(clamp(numberOr(0.25, params.time), 0.001, 4) * sampleRate));
  if (!state.left || state.delaySamples !== delaySamples) {
    state.delaySamples = delaySamples;
    state.left = new Float32Array(delaySamples);
    state.right = new Float32Array(delaySamples);
    state.index = 0;
  }
  const index = state.index || 0;
  const wetL = state.left[index];
  const wetR = state.right[index];
  const feedback = clamp(numberOr(0.25, params.feedback), 0, 0.95);
  const mix = clamp(numberOr(0.2, params.mix), 0, 1);
  state.left[index] = left + wetL * feedback;
  state.right[index] = right + wetR * feedback;
  state.index = (index + 1) % delaySamples;
  return { left: left * (1 - mix) + wetL * mix, right: right * (1 - mix) + wetR * mix };
}

function applyReverbSample(left, right, params, state) {
  const taps = [0.0297, 0.0371, 0.0411, 0.053];
  if (!state.taps) {
    state.taps = taps.map(delay => ({ left: new Float32Array(Math.max(1, Math.round(delay * sampleRate))), right: new Float32Array(Math.max(1, Math.round(delay * sampleRate))), index: 0 }));
  }
  const mix = clamp(numberOr(0.18, params.mix), 0, 1);
  const decay = clamp(numberOr(0.45, params.decay), 0, 0.95);
  let wetL = 0;
  let wetR = 0;
  for (const tap of state.taps) {
    const delayedL = tap.left[tap.index];
    const delayedR = tap.right[tap.index];
    wetL += delayedL;
    wetR += delayedR;
    tap.left[tap.index] = left + delayedL * decay;
    tap.right[tap.index] = right + delayedR * decay;
    tap.index = (tap.index + 1) % tap.left.length;
  }
  wetL /= state.taps.length;
  wetR /= state.taps.length;
  return { left: left * (1 - mix) + wetL * mix, right: right * (1 - mix) + wetR * mix };
}

function drumSample(voice) {
  const t = voice.ageSamples / sampleRate;
  const velocity = Math.pow(voice.velocity, 1.1);
  if (voice.pitch === 36) {
    const frequency = 55 + 95 * Math.exp(-t * 35);
    return Math.sin(TAU * frequency * t) * Math.exp(-t * 18) * 0.9 * velocity;
  }
  if (voice.pitch === 38) {
    return (pseudoNoise(t, 3101) * Math.exp(-t * 18) * 0.55 + Math.sin(TAU * 190 * t) * Math.exp(-t * 24) * 0.25) * velocity;
  }
  if (voice.pitch === 42 || voice.pitch === 46) {
    const decay = voice.pitch === 42 ? 55 : 18;
    return highpassNoise(t, 11003) * Math.exp(-t * decay) * 0.35 * velocity;
  }
  return Math.sin(TAU * voice.frequency * t) * Math.exp(-t * 16) * 0.25 * velocity;
}


function shouldRenderTrack(track, tracks) {
  const hasSolo = tracks.some(item => item.solo && !item.muted);
  return hasSolo ? track.solo && !track.muted : !track.muted;
}

function lowerBoundEvents(events, beat) {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (events[mid].startBeat < beat) low = mid + 1;
    else high = mid;
  }
  return low;
}

function midiToHz(pitch) {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

function pseudoNoise(t, seed) {
  const value = Math.sin((t * 44100 + seed) * 12.9898) * 43758.5453;
  return 2 * (value - Math.floor(value)) - 1;
}

function highpassNoise(t, seed) {
  return pseudoNoise(t, seed) - 0.5 * pseudoNoise(t + 0.0007, seed);
}

function softLimit(value) {
  return Math.tanh(value * 1.2) * 0.85;
}

function dbToLinear(value) {
  return 10 ** (value / 20);
}

function coeff(seconds) {
  return Math.exp(-1 / (sampleRate * clamp(seconds, 0.0001, 5)));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function numberOr(fallback, value) {
  return value === undefined || value === null || Number.isNaN(value) ? fallback : value;
}

function mergePresetParams(base, overrides) {
  const result = { ...base };
  for (const key of Object.keys(overrides)) {
    const ov = overrides[key];
    const bv = base[key];
    if (ov !== null && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      result[key] = { ...bv, ...ov };
    } else {
      result[key] = ov;
    }
  }
  return result;
}

registerProcessor('chrodis-worklet', ChrodisWorklet);
