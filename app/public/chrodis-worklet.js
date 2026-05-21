const TAU = Math.PI * 2;
const MAX_VOICES = 96;

class ChrodisWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.project = { bpm: 120, lengthBeats: 128, tracks: [], events: [], audioEvents: [], presets: {} };
    this.audioBuffers = {};
    this.masterGain = 0.9;
    this.playing = false;
    this.currentBeat = 0;
    this.eventCursor = 0;
    this.voices = [];
    this.positionCountdown = 0;
    this.port.onmessage = event => this.handleMessage(event.data);
  }

  handleMessage(message) {
    if (!message || !message.type) return;
    if (message.type === 'loadProject') {
      this.project = message.project;
      this.project.events = this.project.events || [];
      this.project.audioEvents = this.project.audioEvents || [];
      this.project.events.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
      this.audioBuffers = message.audioBuffers || {};
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
      this.scheduleEvents(this.currentBeat);
      const mixed = this.renderVoices();
      const audio = this.renderAudioClips(this.currentBeat);
      left[frame] = softLimit((mixed[0] + audio[0]) * this.masterGain);
      right[frame] = softLimit((mixed[1] + audio[1]) * this.masterGain);
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
    const preset = this.project.presets[track.preset] || this.project.presets.keys || {};
    const ageSeconds = Math.max(0, (atBeat - event.startBeat) * 60 / this.project.bpm);
    const durationSeconds = event.durationBeats * 60 / this.project.bpm;
    const tailSeconds = numberOr(track.kind === 'drum' ? 0.25 : 0.2, preset.tail_seconds);
    const velocity = Math.max(0, Math.min(1, event.velocity / 127));
    const pan = Math.max(0, Math.min(1, track.pan / 127));
    const gain = Math.pow(track.volume / 127, 1.5);
    this.voices.push({
      kind: track.kind,
      preset,
      pitch: event.pitch,
      frequency: midiToHz(event.pitch),
      velocity,
      durationSeconds,
      totalSeconds: durationSeconds + tailSeconds,
      ageSamples: Math.round(ageSeconds * sampleRate),
      phases: [],
      gain,
      leftGain: Math.cos(pan * Math.PI / 2) * gain,
      rightGain: Math.sin(pan * Math.PI / 2) * gain
    });
    if (this.voices.length > MAX_VOICES) this.voices.splice(0, this.voices.length - MAX_VOICES);
  }

  renderVoices() {
    let left = 0;
    let right = 0;
    const survivors = [];
    for (const voice of this.voices) {
      const sample = voice.kind === 'drum' ? drumSample(voice) : synthSample(voice);
      left += sample * voice.leftGain;
      right += sample * voice.rightGain;
      voice.ageSamples += 1;
      if (voice.ageSamples / sampleRate < voice.totalSeconds) survivors.push(voice);
    }
    this.voices = survivors;
    return [left, right];
  }

  renderAudioClips(beat) {
    let left = 0;
    let right = 0;
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
      left += channels[0][sourceIndex] * leftGain;
      right += (channels[1] || channels[0])[sourceIndex] * rightGain;
    }
    return [left, right];
  }
}

function synthSample(voice) {
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

function numberOr(fallback, value) {
  return value === undefined || value === null || Number.isNaN(value) ? fallback : value;
}

registerProcessor('chrodis-worklet', ChrodisWorklet);
