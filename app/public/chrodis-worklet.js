import { synthSample } from './synths/chordsynth.js';
import { synthSampleO3 } from './synths/o3.js';

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
    } else if (message.type === 'previewNote') {
      this.voices = this.voices.filter(v => !v.isPreview);
      const preset = message.preset || {};
      const durationSeconds = 10;
      const tailSeconds = numberOr(0.3, preset.tail_seconds);
      this.voices.push({
        kind: 'instrument',
        preset,
        pitch: message.pitch,
        frequency: midiToHz(message.pitch),
        velocity: Math.max(0, Math.min(1, numberOr(0.8, message.velocity))),
        durationSeconds,
        totalSeconds: durationSeconds + tailSeconds,
        ageSamples: 0,
        phases: [],
        isPreview: true,
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
    const basePreset = this.project.presets[track.preset] || this.project.presets.keys || {};
    const preset = track.synthParams ? mergePresetParams(basePreset, track.synthParams) : basePreset;
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
      const sample = voice.kind === 'drum' ? drumSample(voice)
        : voice.preset.synth_engine === 'o3' ? synthSampleO3(voice)
        : synthSample(voice);
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
