import { buildRealtimeProject, type PresetLibraryData } from './project';
import { type Project } from '../api';

export type PositionCallback = (position: { beat: number; seconds: number }) => void;

export class RealtimeAudioEngine {
  private context: AudioContext;
  private node: AudioWorkletNode;
  private onPosition: PositionCallback;

  private constructor(context: AudioContext, node: AudioWorkletNode, onPosition: PositionCallback) {
    this.context = context;
    this.node = node;
    this.onPosition = onPosition;
    this.node.port.onmessage = event => {
      if (event.data?.type === 'position') {
        this.onPosition({ beat: event.data.beat, seconds: event.data.seconds });
      }
    };
    this.node.connect(this.context.destination);
  }

  static async create(onPosition: PositionCallback, latencyHint: AudioContextLatencyCategory = 'interactive'): Promise<RealtimeAudioEngine> {
    const context = new AudioContext({ latencyHint });
    await context.audioWorklet.addModule('/chrodis-worklet.js');
    const node = new AudioWorkletNode(context, 'chrodis-worklet', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    return new RealtimeAudioEngine(context, node, onPosition);
  }

  async updateProject(project: Project, presets: PresetLibraryData): Promise<void> {
    const realtimeProject = buildRealtimeProject(project, presets);
    const audioBuffers = await this.loadAudioBuffers(realtimeProject.audioEvents.map(event => event.assetPath));
    this.node.port.postMessage({ type: 'loadProject', project: realtimeProject, audioBuffers });
  }

  async play(beat: number): Promise<void> {
    await this.context.resume();
    this.node.port.postMessage({ type: 'play', beat });
  }

  setMasterGain(gain: number): void {
    this.node.port.postMessage({ type: 'setMasterGain', gain });
  }

  pause(): void {
    this.node.port.postMessage({ type: 'pause' });
  }

  stop(beat = 0): void {
    this.node.port.postMessage({ type: 'stop', beat });
  }

  seek(beat: number): void {
    this.node.port.postMessage({ type: 'seek', beat });
  }

  dispose(): void {
    this.node.port.postMessage({ type: 'stop', beat: 0 });
    this.node.disconnect();
    void this.context.close();
  }

  private async loadAudioBuffers(paths: string[]): Promise<Record<string, { sampleRate: number; channels: Float32Array[] }>> {
    const unique = Array.from(new Set(paths.filter(Boolean)));
    const buffers: Record<string, { sampleRate: number; channels: Float32Array[] }> = {};
    await Promise.all(unique.map(async path => {
      const response = await fetch('/' + path);
      if (!response.ok) return;
      const data = await response.arrayBuffer();
      const decoded = await this.context.decodeAudioData(data.slice(0));
      buffers[path] = {
        sampleRate: decoded.sampleRate,
        channels: Array.from({ length: decoded.numberOfChannels }, (_, channel) => new Float32Array(decoded.getChannelData(channel)))
      };
    }));
    return buffers;
  }
}
