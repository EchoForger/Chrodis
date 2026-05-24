import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  api,
  barFromBeatIndex,
  beatIndexFromBar,
  clipLeft,
  clipWidth,
  noteFromStartBeats,
  noteStartBeats,
  pitchToY,
  snapBeats,
  yToPitch,
  keyForClip,
  keyForNote,
  type AudioClip,
  type ClipKey,
  type Clip,
  type Note,
  type NoteKey,
  type Project,
  type Track
} from './api';
import { RealtimeAudioEngine } from './realtime/engine';
import { type PresetLibraryData } from './realtime/project';
import { DeferredRange, PanKnob, ValueFader } from './components/controls';
import { Mixer } from './components/Mixer';
import { PresetPicker } from './components/PresetPicker';
import { SheetMusicView } from './components/SheetMusicView';
import { SynthEditor } from './components/SynthEditor';
import { clamp } from './lib/controls';
import { presetCategories, presetCategory, resolveBaseSystemPreset, synthEngineLabel } from './lib/presets';
import { AudioRecorder, blobToBase64 } from './recording';
import { DEFAULT_PREFERENCES, SHORTCUT_GROUPS, loadPreferences, savePreferences, verticalWheelDelta, type Preferences } from './preferences';
import { midiThumbnailNotes } from './thumbnail';
import './style.css';

const BASE_PX_PER_BAR = 88;
const BASE_TRACK_HEADER_WIDTH = 330;
const BASE_LANE_HEIGHT = 82;
const MIN_PITCH = 36;
const MAX_PITCH = 84;
const BASE_NOTE_ROW = 14;

type Selection = { type: 'project' } | { type: 'track'; track: number } | { type: 'clip'; track: number; clip: string };
type EditorMode = 'docked' | 'floating';
type ActiveWindow = 'arranger' | 'pianoRoll';
type Tool = 'pointer' | 'marquee' | 'scissors';
type Clipboard = { type: 'clips'; clips: Array<{ track: number; kind: 'midi'; clip: Clip } | { track: number; kind: 'audio'; clip: AudioClip }> } | { type: 'notes'; notes: Note[] } | null;
type ContextMenuItem = { label: string; action: () => void; disabled?: boolean };
type ContextMenu = { x: number; y: number; items: ContextMenuItem[] } | null;
type MenuCommand =
  | 'new-project' | 'save' | 'export-midi' | 'export-wav'
  | 'undo' | 'redo' | 'copy' | 'paste' | 'duplicate' | 'delete' | 'select-all'
  | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'tool-pointer' | 'tool-marquee' | 'tool-scissors' | 'toggle-editor-mode' | 'close-editor'
  | 'add-instrument-track' | 'add-audio-track' | 'rename-track' | 'toggle-mute' | 'toggle-solo' | 'toggle-record-arm' | 'delete-track'
  | 'add-midi-clip' | 'open-piano-roll' | 'split-clip' | 'clip-color-green' | 'clip-color-blue'
  | 'play-pause' | 'stop' | 'record' | 'compose-demo' | 'preferences' | 'help';
type Marquee = { type: 'clips' | 'notes'; startX: number; startY: number; x: number; y: number; track?: number; clip?: string };
type InspectorTab = 'library' | 'inspector';
type PreferenceTab = 'general' | 'audio' | 'editing' | 'display' | 'shortcuts';
type DeviceOption = { deviceId: string; label: string; kind: MediaDeviceKind };
type ClipDrag =
  | { mode: 'move'; track: number; clip: string; startX: number; initialBar: number; initialBeats: number }
  | { mode: 'resize-left' | 'resize-right'; track: number; clip: string; startX: number; initialBar: number; initialBeats: number }
  | { mode: 'loop-right'; track: number; clip: string; startX: number; initialBeats: number; initialLoopCount: number };
type NoteDrag =
  | { mode: 'move'; index: number; startX: number; startY: number; initialStart: number; initialPitch: number; initialDuration: number }
  | { mode: 'resize'; index: number; startX: number; initialDuration: number };

declare global {
  interface Window {
    chrodis?: {
      onMenuCommand: (callback: (command: MenuCommand) => void) => () => void;
    };
  }
}

function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [presets, setPresets] = useState<PresetLibraryData | null>(null);
  const effectivePresets = presets;
  const [selected, setSelected] = useState<Selection>({ type: 'project' });
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [isRealtimeReady, setIsRealtimeReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(0);
  const [arrangerZoomX, setArrangerZoomX] = useState(1);
  const [arrangerZoomY, setArrangerZoomY] = useState(1);
  const [pianoZoomX, setPianoZoomX] = useState(1);
  const [pianoZoomY, setPianoZoomY] = useState(1);
  const [inspectorWidth, setInspectorWidth] = useState(286);
  const [editorHeight, setEditorHeight] = useState(320);
  const [clipDrag, setClipDrag] = useState<ClipDrag | null>(null);
  const [editorClip, setEditorClip] = useState<{ track: number; clip: string } | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>('docked');
  const [selectedNote, setSelectedNote] = useState<number | null>(null);
  const [activeWindow, setActiveWindow] = useState<ActiveWindow>('arranger');
  const [tool, setTool] = useState<Tool>('pointer');
  const [selectedClips, setSelectedClips] = useState<Set<string>>(new Set());
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());
  const [clipboard, setClipboard] = useState<Clipboard>(null);
  const [undoStack, setUndoStack] = useState<Project[]>([]);
  const [redoStack, setRedoStack] = useState<Project[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenu>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProject, setNewProject] = useState({ title: 'Untitled', bpm: 120, key: 'C', time_signature: '4/4', length_bars: 32, slug: 'untitled' });
  const [isRecording, setIsRecording] = useState(false);
  const [noteDrag, setNoteDrag] = useState<NoteDrag | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());
  const [showPreferences, setShowPreferences] = useState(false);
  const [preferenceTab, setPreferenceTab] = useState<PreferenceTab>('general');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('library');
  const [libraryCategory, setLibraryCategory] = useState('钢琴');
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [showSynthEditor, setShowSynthEditor] = useState(false);
  const [showEditHint, setShowEditHint] = useState(false);
  const [showMixer, setShowMixer] = useState(false);
  const [mixerHeight, setMixerHeight] = useState(240);
  const [quantizeStep, setQuantizeStep] = useState(0.25);
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [audioDevices, setAudioDevices] = useState<DeviceOption[]>([]);
  const projectRef = useRef<Project | null>(null);
  const presetsRef = useRef<PresetLibraryData | null>(null);
  const engineRef = useRef<RealtimeAudioEngine | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const selectedRef = useRef<Selection>(selected);
  const editorClipRef = useRef<{ track: number; clip: string } | null>(null);
  const selectedClipsRef = useRef<Set<string>>(selectedClips);
  const selectedNotesRef = useRef<Set<string>>(selectedNotes);
  const preferencesRef = useRef<Preferences>(preferences);
  const menuHandlerRef = useRef<(command: MenuCommand) => void>(() => undefined);
  const pendingPlayBeatRef = useRef<number | null>(null);
  const pxPerBar = Math.round(BASE_PX_PER_BAR * arrangerZoomX);
  const pxPerBeat = pxPerBar / 4;
  const laneHeight = Math.round(BASE_LANE_HEIGHT * arrangerZoomY);
  const trackHeaderWidth = BASE_TRACK_HEADER_WIDTH;
  const noteRow = Math.round(BASE_NOTE_ROW * pianoZoomY);
  const pianoPxPerBeat = pxPerBeat * pianoZoomX;

  useEffect(() => { void refresh(); void loadPresets(); }, []);
  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { presetsRef.current = presets; }, [presets]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { editorClipRef.current = editorClip; }, [editorClip]);
  useEffect(() => { selectedClipsRef.current = selectedClips; }, [selectedClips]);
  useEffect(() => { selectedNotesRef.current = selectedNotes; }, [selectedNotes]);
  useEffect(() => { preferencesRef.current = preferences; savePreferences(preferences); }, [preferences]);
  useEffect(() => { menuHandlerRef.current = handleMenuCommand; });
  useEffect(() => {
    setTool(preferences.editing.defaultTool);
    setEditorMode(preferences.display.defaultEditorMode);
  }, []);

  useEffect(() => {
    engineRef.current?.setMasterGain(preferences.audio.masterGain);
  }, [preferences.audio.masterGain, isRealtimeReady]);

  useEffect(() => {
    if (!showPreferences || !navigator.mediaDevices?.enumerateDevices) return;
    void navigator.mediaDevices.enumerateDevices()
      .then(devices => setAudioDevices(devices
        .filter(device => device.kind === 'audioinput' || device.kind === 'audiooutput')
        .map(device => ({ deviceId: device.deviceId, label: device.label || defaultDeviceLabel(device), kind: device.kind }))))
      .catch(() => setAudioDevices([]));
  }, [showPreferences]);

  useEffect(() => {
    let disposed = false;
    RealtimeAudioEngine.create(position => {
      const lengthBeats = projectRef.current ? projectRef.current.length_bars * 4 : Infinity;
      if (position.beat >= lengthBeats) {
        engineRef.current?.pause();
        setIsPlaying(false);
        setCurrentBeat(lengthBeats);
      } else {
        setCurrentBeat(position.beat);
      }
    }, preferencesRef.current.audio.latencyMode).then(engine => {
      if (disposed) {
        engine.dispose();
        return;
      }
      engineRef.current = engine;
      engine.setMasterGain(preferencesRef.current.audio.masterGain);
      setIsRealtimeReady(true);
      if (projectRef.current && presetsRef.current) engine.updateProject(projectRef.current, presetsRef.current);
      if (pendingPlayBeatRef.current !== null) {
        const beat = pendingPlayBeatRef.current;
        pendingPlayBeatRef.current = null;
        engine.play(beat).then(() => { if (!disposed) setIsPlaying(true); }).catch(() => {});
      }
    }).catch(error => {
      console.error('Realtime audio engine failed to start', error);
      setAudioError('实时音频启动失败');
      setIsRealtimeReady(false);
    });
    return () => {
      disposed = true;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (project && presets && engineRef.current) engineRef.current.updateProject(project, presets);
  }, [project, presets, isRealtimeReady]);

  useEffect(() => {
    return window.chrodis?.onMenuCommand(command => menuHandlerRef.current(command));
  }, []);

  async function refresh() {
    setProject(await api<Project>('/api/project'));
  }

  async function loadPresets() {
    setPresets(await api<PresetLibraryData>('/api/presets'));
  }

  const selectedTrack = project && selected.type !== 'project' ? project.tracks[selected.track] : null;
  const selectedClip = selectedTrack && selected.type === 'clip' ? selectedTrack.clips.find(c => c.id === selected.clip) || null : null;
  const selectedAudioClip = project && selected.type !== 'project' && selectedClips.size === 1
    ? project.tracks[selected.track]?.audio_clips.find(clip => selectedClips.has(keyForClip({ track: selected.track, id: clip.id, kind: 'audio' }))) || null
    : null;
  const openClip = project && editorClip ? project.tracks[editorClip.track]?.clips.find(c => c.id === editorClip.clip) || null : null;
  const timelineWidth = project ? project.length_bars * pxPerBar : 0;

  useEffect(() => {
    if (!clipDrag || !project) return;
    const onMove = (event: MouseEvent) => {
      const delta = snapBeats(event.clientX - clipDrag.startX, pxPerBeat);
      updateClipLocal(clipDrag.track, clipDrag.clip, clip => {
        if (clipDrag.mode === 'move') {
          const startBeat = Math.max(0, beatIndexFromBar(clipDrag.initialBar) + delta);
          return { ...clip, bar: barFromBeatIndex(startBeat) };
        }
        if (clipDrag.mode === 'resize-right') {
          return { ...clip, beats: Math.max(1, clipDrag.initialBeats + delta) };
        }
        if (clipDrag.mode === 'loop-right') {
          const loopCount = Math.max(1, Math.round(clipDrag.initialLoopCount + delta / clipDrag.initialBeats));
          return { ...clip, loop_count: loopCount };
        }
        const maxDelta = Math.min(delta, clipDrag.initialBeats - 1);
        const startBeat = Math.max(0, beatIndexFromBar(clipDrag.initialBar) + maxDelta);
        return { ...clip, bar: barFromBeatIndex(startBeat), beats: Math.max(1, clipDrag.initialBeats - maxDelta) };
      });
    };
    const onUp = () => {
      setClipDrag(null);
      saveCurrentProject();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, { once: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [clipDrag, project]);

  useEffect(() => {
    if (!noteDrag || !editorClip) return;
    const onMove = (event: MouseEvent) => {
      const clip = getClip(editorClip.track, editorClip.clip);
      if (!clip) return;
      const notes = [...clip.notes];
      const note = notes[noteDrag.index];
      if (!note) return;
      if (noteDrag.mode === 'resize') {
        const rawDelta = snapBeats(event.clientX - noteDrag.startX, pianoPxPerBeat);
        const delta = Math.round(rawDelta / quantizeStep) * quantizeStep;
        notes[noteDrag.index] = { ...note, duration: Math.max(quantizeStep, noteDrag.initialDuration + delta) };
      } else {
        const rawDeltaX = snapBeats(event.clientX - noteDrag.startX, pianoPxPerBeat);
        const deltaX = Math.round(rawDeltaX / quantizeStep) * quantizeStep;
        const deltaPitch = -Math.round((event.clientY - noteDrag.startY) / noteRow);
        notes[noteDrag.index] = noteFromStartBeats(
          Math.max(0, noteDrag.initialStart + deltaX),
          Math.max(MIN_PITCH, Math.min(MAX_PITCH, noteDrag.initialPitch + deltaPitch)),
          noteDrag.initialDuration,
          note.velocity
        );
      }
      updateClipLocal(editorClip.track, editorClip.clip, current => ({ ...current, notes }));
    };
    const onUp = () => {
      setNoteDrag(null);
      saveCurrentProject();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, { once: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [noteDrag, editorClip, project]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if ((event.key === 'Delete' || event.key === 'Backspace') && project && !isTyping) {
        event.preventDefault();
        handleMenuCommand('delete');
        return;
      }
      if (isTyping) return;
      if (event.key === ' ') {
        event.preventDefault();
        void togglePlayback();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        stopPlayback();
      } else if (event.key === 'Escape') {
        setEditorClip(null);
        setSelectedNote(null);
        setContextMenu(null);
        setMarquee(null);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copySelected();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAllInFocus();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteClipboard();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicateSelected();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveCurrentProject();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setShowKeyInput(v => !v);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        void api('/api/export-midi', 'POST', { output: 'exports/gui/export.mid' });
      } else if (event.key === '1') {
        setTool('pointer');
      } else if (event.key === '2') {
        setTool('marquee');
      } else if (event.key === '3') {
        setTool('scissors');
      } else if ((event.key === '+' || event.key === '=') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (event.altKey) setArrangerZoomY(value => clamp(value + 0.1, 0.65, 1.8));
        else setArrangerZoomX(value => clamp(value + 0.1, 0.45, 2.5));
      } else if (event.key === '-' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (event.altKey) setArrangerZoomY(value => clamp(value - 0.1, 0.65, 1.8));
        else setArrangerZoomX(value => clamp(value - 0.1, 0.45, 2.5));
      } else if (event.key === '0' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setArrangerZoomX(1);
        setArrangerZoomY(1);
        setPianoZoomX(1);
        setPianoZoomY(1);
      } else if (event.key.toLowerCase() === 'm' && selected.type !== 'project') {
        const track = projectRef.current?.tracks[selected.track];
        if (track) void patchTrack(selected.track, { muted: !track.muted });
      } else if (event.key.toLowerCase() === 's' && selected.type !== 'project') {
        const track = projectRef.current?.tracks[selected.track];
        if (track) void patchTrack(selected.track, { solo: !track.solo });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editorClip, selectedNote, selectedNotes, selectedClips, clipboard, project, selected, isPlaying, currentBeat]);

  if (!project) return <div className="loading">Loading chrodis...</div>;

  function getClip(trackIndex: number, clipId: string): Clip | null {
    return projectRef.current?.tracks[trackIndex]?.clips.find(clip => clip.id === clipId) || null;
  }

  function getAudioClip(trackIndex: number, clipId: string): AudioClip | null {
    return projectRef.current?.tracks[trackIndex]?.audio_clips?.find(clip => clip.id === clipId) || null;
  }

  function cloneProject(value: Project): Project {
    return JSON.parse(JSON.stringify(value)) as Project;
  }

  function commitProject(next: Project, options: { pushUndo?: boolean; save?: boolean } = {}) {
    const pushUndo = options.pushUndo ?? true;
    const save = options.save ?? preferencesRef.current.general.autoSave;
    const current = projectRef.current;
    if (current && pushUndo) setUndoStack(stack => [...stack.slice(-49), cloneProject(current)]);
    setRedoStack([]);
    setProject(next);
    projectRef.current = next;
    if (save) void api('/api/project', 'POST', next);
  }

  function mutateProject(mutator: (draft: Project) => void, options?: { pushUndo?: boolean; save?: boolean }) {
    const current = projectRef.current;
    if (!current) return;
    const draft = cloneProject(current);
    mutator(draft);
    commitProject(draft, options);
  }

  function previewProject(mutator: (draft: Project) => void) {
    const current = projectRef.current;
    if (!current) return;
    const draft = cloneProject(current);
    mutator(draft);
    setProject(draft);
    projectRef.current = draft;
  }

  function saveCurrentProject() {
    const current = projectRef.current;
    if (current) void api('/api/project', 'POST', current);
  }

  function undo() {
    const previous = undoStack.at(-1);
    const current = projectRef.current;
    if (!previous || !current) return;
    setUndoStack(stack => stack.slice(0, -1));
    setRedoStack(stack => [...stack, cloneProject(current)]);
    setProject(previous);
    projectRef.current = previous;
    void api('/api/project', 'POST', previous);
  }

  function redo() {
    const next = redoStack.at(-1);
    const current = projectRef.current;
    if (!next || !current) return;
    setRedoStack(stack => stack.slice(0, -1));
    setUndoStack(stack => [...stack, cloneProject(current)]);
    setProject(next);
    projectRef.current = next;
    void api('/api/project', 'POST', next);
  }

  function updateClipLocal(trackIndex: number, clipId: string, updater: (clip: Clip) => Clip) {
    setProject(current => {
      if (!current) return current;
      const next = {
        ...current,
        tracks: current.tracks.map((track, index) => index === trackIndex
          ? { ...track, clips: track.clips.map(clip => clip.id === clipId ? updater(clip) : clip) }
          : track)
      };
      projectRef.current = next;
      return next;
    });
  }

  function pushUndoSnapshot() {
    const current = projectRef.current;
    if (!current) return;
    setUndoStack(stack => [...stack.slice(-49), cloneProject(current)]);
    setRedoStack([]);
  }

  async function patchTrack(index: number, patch: Partial<Track>) {
    mutateProject(draft => {
      const track = draft.tracks[index];
      const changes = { ...patch };
      if (Object.prototype.hasOwnProperty.call(changes, 'preset') && !Object.prototype.hasOwnProperty.call(changes, 'name')) {
        const nextPreset = changes.preset;
        if (nextPreset !== track.preset && shouldTrackNameFollowPreset(track, effectivePresets)) {
          changes.name = nextPreset ? presetDisplayName(effectivePresets, nextPreset) : track.kind;
        }
      }
      Object.assign(track, changes);
    });
  }

  function previewTrack(index: number, patch: Partial<Track>) {
    previewProject(draft => {
      Object.assign(draft.tracks[index], patch);
    });
  }

  function commitTrackPreview() {
    const current = projectRef.current;
    if (current) commitProject(cloneProject(current));
  }

  async function patchProjectMeta(patch: Partial<Pick<Project, 'title' | 'bpm' | 'key' | 'time_signature' | 'length_bars'>>) {
    mutateProject(draft => {
      Object.assign(draft, patch);
    });
  }

  async function patchClip(trackIndex: number, clipId: string, patch: Partial<Clip>) {
    mutateProject(draft => {
      const clip = draft.tracks[trackIndex].clips.find(item => item.id === clipId);
      if (clip) Object.assign(clip, patch);
    });
  }

  async function patchAudioClip(trackIndex: number, clipId: string, patch: Partial<AudioClip>) {
    mutateProject(draft => {
      const clip = draft.tracks[trackIndex].audio_clips.find(item => item.id === clipId);
      if (clip) Object.assign(clip, patch);
    });
  }

  function previewAudioClip(trackIndex: number, clipId: string, patch: Partial<AudioClip>) {
    previewProject(draft => {
      const clip = draft.tracks[trackIndex].audio_clips.find(item => item.id === clipId);
      if (clip) Object.assign(clip, patch);
    });
  }

  async function deleteTrack(index: number) {
    mutateProject(draft => {
      draft.tracks.splice(index, 1);
    });
    setSelected({ type: 'project' });
    setSelectedClips(new Set());
  }

  async function addTrack(kind: 'instrument' | 'drum' | 'audio' = 'instrument') {
    mutateProject(draft => {
      const preset = kind === 'audio' ? undefined : 'SYSTEM/合成器/o3-lead';
      draft.tracks.push({
        name: kind === 'audio' ? 'Audio Track' : presetDisplayName(effectivePresets, preset || ''),
        kind,
        channel: nextChannel(draft, kind),
        preset,
        volume: 96,
        pan: 64,
        muted: false,
        solo: false,
        record_armed: false,
        notes: [],
        clips: [],
        audio_clips: [],
        effects: []
      });
    });
  }

  async function addMidiClip(trackIndex: number, bar = Math.floor(currentBeat / 4) + 1) {
    mutateProject(draft => {
      draft.tracks[trackIndex]?.clips.push({ id: `clip-${Date.now()}-${Math.random().toString(16).slice(2)}`, name: 'New MIDI', bar, beats: 4, notes: [], color: '#18a83a', loop_count: 1 });
    });
  }

  async function exportWav() {
    const result = await api<{ url: string }>('/api/export-wav', 'POST', { output: 'exports/gui/export.wav' });
    setAudioUrl(result.url + '?t=' + Date.now());
  }

  async function togglePlayback() {
    const engine = engineRef.current;
    if (!preferencesRef.current.audio.realtimeEnabled) {
      setAudioError('偏好设置中已关闭实时音频');
      return;
    }
    if (!engine || !isRealtimeReady) {
      if (preferencesRef.current.audio.realtimeEnabled) {
        pendingPlayBeatRef.current = currentBeat;
        setAudioError(null);
      } else {
        setAudioError('偏好设置中已关闭实时音频');
      }
      return;
    }
    if (isPlaying) {
      engine.pause();
      setIsPlaying(false);
      return;
    }
    try {
      setAudioError(null);
      await engine.play(currentBeat);
      setIsPlaying(true);
    } catch {
      setAudioError('播放启动失败，请检查音频偏好设置');
    }
  }

  function stopPlayback() {
    engineRef.current?.stop(currentBeat);
    setIsPlaying(false);
  }

  function seekPlayback(beat: number) {
    const nextBeat = Math.max(0, Math.min(projectRef.current?.length_bars ? projectRef.current.length_bars * 4 : beat, beat));
    setCurrentBeat(nextBeat);
    engineRef.current?.seek(nextBeat);
  }

  function seekFromTimeline(event: React.MouseEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const beat = Math.round(Math.max(0, event.clientX - rect.left) / pxPerBeat);
    seekPlayback(beat);
  }

  function isAdditiveSelection(event: React.MouseEvent | MouseEvent): boolean {
    return event.shiftKey || event.metaKey || event.ctrlKey;
  }

  function selectClip(trackIndex: number, clip: Clip, additive = false) {
    setActiveWindow('arranger');
    setSelected({ type: 'clip', track: trackIndex, clip: clip.id });
    const key = keyForClip({ track: trackIndex, id: clip.id, kind: 'midi' });
    setSelectedClips(previous => {
      const next = additive ? new Set(previous) : new Set<string>();
      if (additive && next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAudioClip(trackIndex: number, clip: AudioClip, additive = false) {
    setActiveWindow('arranger');
    setSelected({ type: 'track', track: trackIndex });
    const key = keyForClip({ track: trackIndex, id: clip.id, kind: 'audio' });
    setSelectedClips(previous => {
      const next = additive ? new Set(previous) : new Set<string>();
      if (additive && next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectMidiClip(trackIndex: number, clip: Clip, additive = false) {
    setActiveWindow('arranger');
    setSelected({ type: 'clip', track: trackIndex, clip: clip.id });
    const key = keyForClip({ track: trackIndex, id: clip.id, kind: 'midi' });
    setSelectedClips(previous => {
      const next = additive ? new Set(previous) : new Set<string>();
      if (additive && next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectNoteKey(track: number, clip: string, index: number, additive = false) {
    setActiveWindow('pianoRoll');
    const key = keyForNote({ track, clip, index });
    setSelectedNote(index);
    setSelectedNotes(previous => {
      const next = additive ? new Set(previous) : new Set<string>();
      if (additive && next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function openPianoRoll(trackIndex: number, clip: Clip) {
    selectMidiClip(trackIndex, clip);
    setEditorClip({ track: trackIndex, clip: clip.id });
    setSelectedNote(null);
    setSelectedNotes(new Set());
  }

  function startClipDrag(event: React.MouseEvent, mode: ClipDrag['mode'], trackIndex: number, clip: Clip) {
    event.preventDefault();
    event.stopPropagation();
    if (tool === 'scissors') {
      splitMidiClipAtBeat(trackIndex, clip.id, cutBeatFromClipEvent(event, clip));
      return;
    }
    selectClip(trackIndex, clip, isAdditiveSelection(event));
    if (tool !== 'pointer') return;
    pushUndoSnapshot();
    if (mode === 'loop-right') {
      setClipDrag({ mode: 'loop-right', track: trackIndex, clip: clip.id, startX: event.clientX, initialBeats: clip.beats, initialLoopCount: clip.loop_count || 1 });
    } else {
      setClipDrag({ mode, track: trackIndex, clip: clip.id, startX: event.clientX, initialBar: clip.bar, initialBeats: clip.beats });
    }
  }

  function cutBeatFromClipEvent(event: React.MouseEvent, clip: Pick<Clip, 'bar'>): number {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return beatIndexFromBar(clip.bar) + snapBeats(event.clientX - rect.left, pxPerBeat);
  }

  function addNoteFromEditor(event: React.MouseEvent<HTMLDivElement>) {
    if (!editorClip || !openClip || event.detail !== 2) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const rawBeats = Math.max(0, snapBeats(event.clientX - rect.left, pianoPxPerBeat));
    const start = Math.round(rawBeats / quantizeStep) * quantizeStep;
    const pitch = yToPitch(event.clientY - rect.top, MAX_PITCH, MIN_PITCH, noteRow);
    const note = noteFromStartBeats(start, pitch, quantizeStep * 4, 88);
    const notes = [...openClip.notes, note];
    updateClipLocal(editorClip.track, openClip.id, clip => ({ ...clip, notes }));
    void patchClip(editorClip.track, openClip.id, { notes });
  }

  function startInspectorResize(event: React.MouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = inspectorWidth;
    const onMove = (move: MouseEvent) => setInspectorWidth(clamp(startWidth + move.clientX - startX, 230, 440));
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', () => window.removeEventListener('mousemove', onMove), { once: true });
  }

  function startEditorResize(event: React.MouseEvent) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = editorHeight;
    const onMove = (move: MouseEvent) => setEditorHeight(clamp(startHeight - (move.clientY - startY), 180, 620));
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', () => window.removeEventListener('mousemove', onMove), { once: true });
  }

  function startMixerResize(event: React.MouseEvent) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = mixerHeight;
    const onMove = (move: MouseEvent) => setMixerHeight(clamp(startHeight - (move.clientY - startY), 160, 420));
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', () => window.removeEventListener('mousemove', onMove), { once: true });
  }

  function zoomArranger(axis: 'x' | 'y', amount: number) {
    if (axis === 'x') setArrangerZoomX(value => clamp(value + amount, 0.45, 2.5));
    else setArrangerZoomY(value => clamp(value + amount, 0.65, 1.8));
  }

  function zoomPiano(axis: 'x' | 'y', amount: number) {
    if (axis === 'x') setPianoZoomX(value => clamp(value + amount, 0.5, 3));
    else setPianoZoomY(value => clamp(value + amount, 0.75, 2.4));
  }

  function deleteSelected() {
    if (activeWindow === 'pianoRoll' && editorClip && selectedNotes.size) {
      mutateProject(draft => {
        const clip = draft.tracks[editorClip.track].clips.find(item => item.id === editorClip.clip);
        if (!clip) return;
        clip.notes = clip.notes.filter((_, index) => !selectedNotes.has(keyForNote({ track: editorClip.track, clip: editorClip.clip, index })));
      });
      setSelectedNotes(new Set());
      setSelectedNote(null);
      return;
    }
    if (!selectedClips.size) return;
    mutateProject(draft => {
      draft.tracks.forEach((track, trackIndex) => {
        track.clips = track.clips.filter(clip => !selectedClips.has(keyForClip({ track: trackIndex, id: clip.id, kind: 'midi' })));
        track.audio_clips = (track.audio_clips || []).filter(clip => !selectedClips.has(keyForClip({ track: trackIndex, id: clip.id, kind: 'audio' })));
      });
    });
    setSelectedClips(new Set());
    setSelected({ type: 'project' });
  }

  function selectAllInFocus() {
    const current = projectRef.current;
    if (!current) return;
    if (activeWindow === 'pianoRoll' && editorClipRef.current) {
      const target = editorClipRef.current;
      const clip = current.tracks[target.track]?.clips.find(item => item.id === target.clip);
      setSelectedNotes(new Set((clip?.notes || []).map((_, index) => keyForNote({ track: target.track, clip: target.clip, index }))));
      setSelectedNote(clip?.notes.length ? 0 : null);
      return;
    }
    const keys = new Set<string>();
    current.tracks.forEach((track, trackIndex) => {
      track.clips.forEach(clip => keys.add(keyForClip({ track: trackIndex, id: clip.id, kind: 'midi' })));
      (track.audio_clips || []).forEach(clip => keys.add(keyForClip({ track: trackIndex, id: clip.id, kind: 'audio' })));
    });
    setSelectedClips(keys);
    setActiveWindow('arranger');
  }

  function copySelected() {
    const current = projectRef.current;
    if (!current) return;
    if (activeWindow === 'pianoRoll' && editorClip && selectedNotes.size) {
      const clip = current.tracks[editorClip.track].clips.find(item => item.id === editorClip.clip);
      if (clip) setClipboard({ type: 'notes', notes: clip.notes.filter((_, index) => selectedNotes.has(keyForNote({ track: editorClip.track, clip: editorClip.clip, index }))).map(note => ({ ...note })) });
      return;
    }
    const clips: NonNullable<Extract<Clipboard, { type: 'clips' }>['clips']> = [];
    current.tracks.forEach((track, trackIndex) => {
      track.clips.forEach(clip => {
        if (selectedClips.has(keyForClip({ track: trackIndex, id: clip.id, kind: 'midi' }))) clips.push({ track: trackIndex, kind: 'midi', clip: cloneProject({ title: '', tracks: [{ ...track, clips: [clip] }], bpm: 120, key: 'C', time_signature: '4/4', length_bars: 1, master_effects: [] }).tracks[0].clips[0] });
      });
      (track.audio_clips || []).forEach(clip => {
        if (selectedClips.has(keyForClip({ track: trackIndex, id: clip.id, kind: 'audio' }))) clips.push({ track: trackIndex, kind: 'audio', clip: JSON.parse(JSON.stringify(clip)) as AudioClip });
      });
    });
    if (clips.length) setClipboard({ type: 'clips', clips });
  }

  function pasteClipboard() {
    if (!clipboard) return;
    if (clipboard.type === 'notes' && editorClip) {
      mutateProject(draft => {
        const clip = draft.tracks[editorClip.track].clips.find(item => item.id === editorClip.clip);
        if (!clip) return;
        const minStart = Math.min(...clipboard.notes.map(noteStartBeats));
        const base = Math.max(0, Math.round(currentBeat) - minStart);
        clip.notes.push(...clipboard.notes.map(note => noteFromStartBeats(noteStartBeats(note) + base, note.pitch, note.duration, note.velocity)));
      });
      return;
    }
    if (clipboard.type === 'clips') {
      const minStart = Math.min(...clipboard.clips.map(item => (item.clip.bar - 1) * 4));
      mutateProject(draft => {
        for (const item of clipboard.clips) {
          const target = draft.tracks[item.track] || draft.tracks[0];
          const bar = 1 + (Math.max(0, Math.round(currentBeat)) + (item.clip.bar - 1) * 4 - minStart) / 4;
          if (item.kind === 'midi') target.clips.push({ ...(JSON.parse(JSON.stringify(item.clip)) as Clip), id: `clip-${Date.now()}-${Math.random().toString(16).slice(2)}`, bar });
          else target.audio_clips.push({ ...(JSON.parse(JSON.stringify(item.clip)) as AudioClip), id: `audio-${Date.now()}-${Math.random().toString(16).slice(2)}`, bar });
        }
      });
    }
  }

  function duplicateSelected() {
    const current = projectRef.current;
    if (!current) return;
    if (activeWindow === 'pianoRoll' && editorClip && selectedNotes.size) {
      mutateProject(draft => {
        const clip = draft.tracks[editorClip.track].clips.find(item => item.id === editorClip.clip);
        if (!clip) return;
        const copies = clip.notes
          .filter((_, index) => selectedNotes.has(keyForNote({ track: editorClip.track, clip: editorClip.clip, index })))
          .map(note => noteFromStartBeats(noteStartBeats(note) + 1, note.pitch, note.duration, note.velocity));
        clip.notes.push(...copies);
      });
      return;
    }
    const offsetBars = 1;
    mutateProject(draft => {
      draft.tracks.forEach((track, trackIndex) => {
        const midiCopies = track.clips
          .filter(clip => selectedClips.has(keyForClip({ track: trackIndex, id: clip.id, kind: 'midi' })))
          .map(clip => ({ ...(JSON.parse(JSON.stringify(clip)) as Clip), id: `clip-${Date.now()}-${Math.random().toString(16).slice(2)}`, bar: clip.bar + offsetBars, name: `${clip.name} copy` }));
        const audioCopies = (track.audio_clips || [])
          .filter(clip => selectedClips.has(keyForClip({ track: trackIndex, id: clip.id, kind: 'audio' })))
          .map(clip => ({ ...(JSON.parse(JSON.stringify(clip)) as AudioClip), id: `audio-${Date.now()}-${Math.random().toString(16).slice(2)}`, bar: clip.bar + offsetBars, name: `${clip.name} copy` }));
        track.clips.push(...midiCopies);
        track.audio_clips.push(...audioCopies);
      });
    });
  }

  function splitMidiClipAtBeat(trackIndex: number, clipId: string, cutBeat: number) {
    mutateProject(draft => {
      const track = draft.tracks[trackIndex];
      const index = track.clips.findIndex(clip => clip.id === clipId);
      if (index < 0) return;
      const clip = track.clips[index];
      const clipStart = (clip.bar - 1) * 4;
      const split = Math.round(cutBeat - clipStart);
      if (split <= 0 || split >= clip.beats) return;
      const right: Clip = { ...JSON.parse(JSON.stringify(clip)), id: `clip-${Date.now()}-${Math.random().toString(16).slice(2)}`, name: `${clip.name} B`, bar: 1 + (clipStart + split) / 4, beats: clip.beats - split, notes: [] };
      clip.beats = split;
      const leftNotes: Note[] = [];
      for (const note of clip.notes) {
        const start = noteStartBeats(note);
        const end = start + note.duration;
        if (end <= split) leftNotes.push(note);
        else if (start >= split) right.notes.push(noteFromStartBeats(start - split, note.pitch, note.duration, note.velocity));
        else {
          leftNotes.push({ ...note, duration: split - start });
          right.notes.push(noteFromStartBeats(0, note.pitch, end - split, note.velocity));
        }
      }
      clip.notes = leftNotes;
      track.clips.splice(index + 1, 0, right);
    });
  }

  function splitAudioClipAtBeat(trackIndex: number, clipId: string, cutBeat: number) {
    mutateProject(draft => {
      const track = draft.tracks[trackIndex];
      const index = track.audio_clips.findIndex(clip => clip.id === clipId);
      if (index < 0) return;
      const clip = track.audio_clips[index];
      const clipStart = (clip.bar - 1) * 4;
      const split = Math.round(cutBeat - clipStart);
      if (split <= 0 || split >= clip.beats) return;
      const right = { ...JSON.parse(JSON.stringify(clip)), id: `audio-${Date.now()}-${Math.random().toString(16).slice(2)}`, name: `${clip.name} B`, bar: 1 + (clipStart + split) / 4, beats: clip.beats - split };
      clip.beats = split;
      track.audio_clips.splice(index + 1, 0, right);
    });
  }

  async function createNewProject() {
    const result = await api<{ project: Project }>('/api/project/new', 'POST', newProject);
    setProject(result.project);
    projectRef.current = result.project;
    setShowNewProject(false);
    setUndoStack([]);
    setRedoStack([]);
    setEditorClip(null);
    setSelected({ type: 'project' });
    setSelectedClips(new Set());
    setSelectedNotes(new Set());
    setIsRecording(false);
  }

  async function toggleRecording() {
    if (isRecording && recorderRef.current) {
      const result = await recorderRef.current.stop();
      recorderRef.current = null;
      setIsRecording(false);
      const armedTrack = projectRef.current?.tracks.findIndex(track => track.record_armed) ?? -1;
      if (armedTrack < 0) return;
      const data = await blobToBase64(result.blob);
      const asset = await api<{ asset_path: string; duration_seconds: number; sample_rate: number; channels: number }>('/api/assets/audio', 'POST', { name: 'recording', data });
      const beats = Math.max(1, Math.ceil(result.durationSeconds * (projectRef.current?.bpm || 120) / 60));
      setProject(await api<Project>('/api/audio-clip', 'POST', { track_index: armedTrack, name: 'Audio Recording', bar: 1 + Math.floor(currentBeat) / 4, beats, ...asset }));
      return;
    }
    const armed = projectRef.current?.tracks.find(track => track.record_armed);
    if (!armed) return;
    const recorder = new AudioRecorder();
    await recorder.start(preferencesRef.current.audio.inputDeviceId);
    recorderRef.current = recorder;
    setIsRecording(true);
  }

  function openContextMenu(event: React.MouseEvent, items: ContextMenuItem[]) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  }

  function handleMenuCommand(command: MenuCommand) {
    const current = projectRef.current;
    const currentSelection = selectedRef.current;
    switch (command) {
      case 'new-project':
        setShowNewProject(true);
        break;
      case 'preferences':
        setShowPreferences(true);
        break;
      case 'save':
        saveCurrentProject();
        break;
      case 'export-midi':
        void api('/api/export-midi', 'POST', { output: 'exports/gui/export.mid' });
        break;
      case 'export-wav':
        void exportWav();
        break;
      case 'undo':
        undo();
        break;
      case 'redo':
        redo();
        break;
      case 'copy':
        copySelected();
        break;
      case 'paste':
        pasteClipboard();
        break;
      case 'duplicate':
        duplicateSelected();
        break;
      case 'delete':
        deleteByFocus();
        break;
      case 'select-all':
        selectAllInFocus();
        break;
      case 'zoom-in':
        zoomArranger('x', 0.1);
        break;
      case 'zoom-out':
        zoomArranger('x', -0.1);
        break;
      case 'zoom-reset':
        setArrangerZoomX(1);
        setArrangerZoomY(1);
        setPianoZoomX(1);
        setPianoZoomY(1);
        break;
      case 'tool-pointer':
        setTool('pointer');
        break;
      case 'tool-marquee':
        setTool('marquee');
        break;
      case 'tool-scissors':
        setTool('scissors');
        break;
      case 'toggle-editor-mode':
        setEditorMode(value => value === 'docked' ? 'floating' : 'docked');
        break;
      case 'close-editor':
        setEditorClip(null);
        setSelectedNote(null);
        setSelectedNotes(new Set());
        break;
      case 'add-instrument-track':
        void addTrack('instrument');
        break;
      case 'add-audio-track':
        void addTrack('audio');
        break;
      case 'rename-track':
        if (currentSelection.type !== 'project') renameTrack(currentSelection.track);
        break;
      case 'toggle-mute':
        if (currentSelection.type !== 'project' && current) void patchTrack(currentSelection.track, { muted: !current.tracks[currentSelection.track].muted });
        break;
      case 'toggle-solo':
        if (currentSelection.type !== 'project' && current) void patchTrack(currentSelection.track, { solo: !current.tracks[currentSelection.track].solo });
        break;
      case 'toggle-record-arm':
        if (currentSelection.type !== 'project' && current) void patchTrack(currentSelection.track, { record_armed: !current.tracks[currentSelection.track].record_armed });
        break;
      case 'delete-track':
        if (currentSelection.type !== 'project') void deleteTrack(currentSelection.track);
        break;
      case 'add-midi-clip':
        if (currentSelection.type !== 'project') void addMidiClip(currentSelection.track);
        break;
      case 'open-piano-roll':
        if (currentSelection.type === 'clip' && current) {
          const clip = current.tracks[currentSelection.track].clips.find(item => item.id === currentSelection.clip);
          if (clip) openPianoRoll(currentSelection.track, clip);
        }
        break;
      case 'split-clip':
        splitSelectedAtPlayhead();
        break;
      case 'clip-color-green':
        colorSelectedClips('#18a83a');
        break;
      case 'clip-color-blue':
        colorSelectedClips('#2f73c8');
        break;
      case 'play-pause':
        void togglePlayback();
        break;
      case 'stop':
        stopPlayback();
        break;
      case 'record':
        void toggleRecording();
        break;
      case 'compose-demo':
        void composeDemo();
        break;
      case 'help':
        setPreferenceTab('shortcuts');
        setShowPreferences(true);
        break;
    }
  }

  function deleteByFocus() {
    if (activeWindow === 'pianoRoll' && editorClipRef.current && (selectedNote !== null || selectedNotesRef.current.size)) {
      deleteSelected();
      return;
    }
    if (selectedClipsRef.current.size) {
      deleteSelected();
      return;
    }
    const currentSelection = selectedRef.current;
    if (currentSelection.type === 'track') void deleteTrack(currentSelection.track);
  }

  function splitSelectedAtPlayhead() {
    const current = projectRef.current;
    if (!current) return;
    const keys = selectedClipsRef.current;
    if (!keys.size && selectedRef.current.type === 'clip') {
      splitMidiClipAtBeat(selectedRef.current.track, selectedRef.current.clip, currentBeat);
      return;
    }
    current.tracks.forEach((track, trackIndex) => {
      track.clips.forEach(clip => {
        if (keys.has(keyForClip({ track: trackIndex, id: clip.id, kind: 'midi' }))) splitMidiClipAtBeat(trackIndex, clip.id, currentBeat);
      });
      track.audio_clips.forEach(clip => {
        if (keys.has(keyForClip({ track: trackIndex, id: clip.id, kind: 'audio' }))) splitAudioClipAtBeat(trackIndex, clip.id, currentBeat);
      });
    });
  }

  function colorSelectedClips(color: string) {
    if (!selectedClipsRef.current.size) return;
    mutateProject(draft => {
      draft.tracks.forEach((track, trackIndex) => {
        track.clips.forEach(clip => {
          if (selectedClipsRef.current.has(keyForClip({ track: trackIndex, id: clip.id, kind: 'midi' }))) clip.color = color;
        });
        track.audio_clips.forEach(clip => {
          if (selectedClipsRef.current.has(keyForClip({ track: trackIndex, id: clip.id, kind: 'audio' }))) clip.color = color;
        });
      });
    });
  }

  async function composeDemo() {
    const current = projectRef.current;
    if (current) setUndoStack(stack => [...stack.slice(-49), cloneProject(current)]);
    setRedoStack([]);
    const composed = await api<Project>('/api/compose/mandopop', 'POST', { title: '晚风里的光', minutes: 3 });
    setProject(composed);
    projectRef.current = composed;
  }

  function renameTrack(index: number) {
    const name = window.prompt('轨道名称', projectRef.current?.tracks[index]?.name || '');
    if (name) void patchTrack(index, { name });
  }

  function renameClip(trackIndex: number, clip: Clip | AudioClip, kind: 'midi' | 'audio') {
    const name = window.prompt('片段名称', clip.name);
    if (!name) return;
    if (kind === 'midi') void patchClip(trackIndex, clip.id, { name });
    else void patchAudioClip(trackIndex, clip.id, { name });
  }

  function copyClipDirect(trackIndex: number, clip: Clip | AudioClip, kind: 'midi' | 'audio') {
    setClipboard({ type: 'clips', clips: [{ track: trackIndex, kind, clip: JSON.parse(JSON.stringify(clip)) }] });
  }

  function duplicateClipDirect(trackIndex: number, clip: Clip | AudioClip, kind: 'midi' | 'audio') {
    mutateProject(draft => {
      const target = draft.tracks[trackIndex];
      const copy = { ...(JSON.parse(JSON.stringify(clip)) as Clip | AudioClip), id: `${kind === 'midi' ? 'clip' : 'audio'}-${Date.now()}-${Math.random().toString(16).slice(2)}`, bar: clip.bar + 1, name: `${clip.name} copy` };
      if (kind === 'midi') target.clips.push(copy as Clip);
      else target.audio_clips.push(copy as AudioClip);
    });
  }

  function deleteClipDirect(trackIndex: number, clipId: string, kind: 'midi' | 'audio') {
    mutateProject(draft => {
      const target = draft.tracks[trackIndex];
      if (kind === 'midi') target.clips = target.clips.filter(clip => clip.id !== clipId);
      else target.audio_clips = target.audio_clips.filter(clip => clip.id !== clipId);
    });
    setSelectedClips(previous => {
      const next = new Set(previous);
      next.delete(keyForClip({ track: trackIndex, id: clipId, kind }));
      return next;
    });
  }

  function copyNoteDirect(trackIndex: number, clipId: string, noteIndex: number) {
    const note = projectRef.current?.tracks[trackIndex]?.clips.find(clip => clip.id === clipId)?.notes[noteIndex];
    if (note) setClipboard({ type: 'notes', notes: [{ ...note }] });
  }

  function duplicateNoteDirect(trackIndex: number, clipId: string, noteIndex: number) {
    mutateProject(draft => {
      const clip = draft.tracks[trackIndex].clips.find(item => item.id === clipId);
      const note = clip?.notes[noteIndex];
      if (clip && note) clip.notes.push(noteFromStartBeats(noteStartBeats(note) + 1, note.pitch, note.duration, note.velocity));
    });
  }

  function deleteNoteDirect(trackIndex: number, clipId: string, noteIndex: number) {
    mutateProject(draft => {
      const clip = draft.tracks[trackIndex].clips.find(item => item.id === clipId);
      if (clip) clip.notes = clip.notes.filter((_, index) => index !== noteIndex);
    });
    setSelectedNotes(new Set());
    setSelectedNote(null);
  }

  function quantizeSelectedNotes() {
    if (!editorClip || !selectedNotes.size) return;
    mutateProject(draft => {
      const clip = draft.tracks[editorClip.track].clips.find(item => item.id === editorClip.clip);
      if (!clip) return;
      const step = quantizeStep;
      clip.notes = clip.notes.map((note, index) => selectedNotes.has(keyForNote({ track: editorClip.track, clip: editorClip.clip, index }))
        ? noteFromStartBeats(Math.round(noteStartBeats(note) / step) * step, note.pitch, Math.max(step, Math.round(note.duration / step) * step), note.velocity)
        : note);
    });
  }

  function startClipMarquee(event: React.MouseEvent<HTMLDivElement>, trackIndex: number) {
    if (tool !== 'marquee') return;
    event.preventDefault();
    const laneRect = event.currentTarget.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    setMarquee({ type: 'clips', startX, startY, x: startX, y: startY, track: trackIndex });
    const onMove = (move: MouseEvent) => setMarquee(current => current ? { ...current, x: move.clientX, y: move.clientY } : current);
    const onUp = (up: MouseEvent) => {
      const current = projectRef.current;
      if (!current) return;
      window.removeEventListener('mousemove', onMove);
      const minX = Math.min(startX, up.clientX) - laneRect.left;
      const maxX = Math.max(startX, up.clientX) - laneRect.left;
      const minTrack = Math.max(0, trackIndex + Math.floor((Math.min(startY, up.clientY) - laneRect.top) / laneHeight));
      const maxTrack = Math.min(current.tracks.length - 1, trackIndex + Math.floor((Math.max(startY, up.clientY) - laneRect.top) / laneHeight));
      const next = new Set<string>();
      current.tracks.forEach((track, index) => {
        if (index < minTrack || index > maxTrack) return;
        track.clips.forEach(clip => {
          const left = clipLeft(clip.bar, pxPerBar);
          const right = left + clipWidth(clip.beats, pxPerBar);
          if (rectsIntersect(minX, maxX, left, right)) next.add(keyForClip({ track: index, id: clip.id, kind: 'midi' }));
        });
        (track.audio_clips || []).forEach(clip => {
          const left = clipLeft(clip.bar, pxPerBar);
          const right = left + clipWidth(clip.beats, pxPerBar);
          if (rectsIntersect(minX, maxX, left, right)) next.add(keyForClip({ track: index, id: clip.id, kind: 'audio' }));
        });
      });
      setSelectedClips(next);
      setActiveWindow('arranger');
      setMarquee(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, { once: true });
  }

  return <div className="shell" onClick={() => setContextMenu(null)}>
    <Transport project={project} currentBeat={currentBeat} isPlaying={isPlaying} isRecording={isRecording} isRealtimeReady={isRealtimeReady && preferences.audio.realtimeEnabled} audioError={audioError} canRecord={project.tracks.some(track => track.record_armed)} showMixer={showMixer} onPlay={togglePlayback} onStop={stopPlayback} onRecord={toggleRecording} onProjectSettings={() => setShowProjectSettings(true)} onToggleMixer={() => setShowMixer(v => !v)} />
    <main className="studio" style={{ gridTemplateColumns: `${inspectorWidth}px 6px 1fr` }}>
      <Inspector project={project} presets={effectivePresets} tab={inspectorTab} libraryCategory={libraryCategory} selected={selected} selectedTrack={selectedTrack} selectedClip={selectedClip} selectedAudioClip={selectedAudioClip} selectedTrackIndex={selected.type !== 'project' ? selected.track : null} audioUrl={audioUrl} outputDeviceId={preferences.audio.outputDeviceId} showEditHint={showEditHint} onShowEditHint={setShowEditHint} onTab={setInspectorTab} onLibraryCategory={setLibraryCategory} onPatchProject={patchProjectMeta} onPatchTrack={patchTrack} onPatchClip={(patch) => { if (selectedClip && selected.type === 'clip') void patchClip(selected.track, selectedClip.id, patch); }} onPatchAudioClip={(patch) => { if (selectedAudioClip && selected.type !== 'project') void patchAudioClip(selected.track, selectedAudioClip.id, patch); }} onOpenEditor={() => selectedClip && selected.type === 'clip' ? openPianoRoll(selected.track, selectedClip) : undefined} onOpenSynthEditor={() => setShowSynthEditor(true)} />
      <div className="panel-resizer vertical" onMouseDown={startInspectorResize} />
      <section className={`arranger ${openClip && editorMode === 'docked' ? 'with-editor' : ''}`} style={{ gridTemplateRows: (() => { const rows = []; rows.push(openClip && editorMode === 'docked' ? `minmax(220px, 1fr) 6px ${editorHeight}px` : '1fr'); if (showMixer) rows.push(`6px ${mixerHeight}px`); return rows.join(' '); })() }}>
        <div className="arranger-scroll" onWheel={event => {
          if (event.altKey && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            zoomArranger('y', verticalWheelDelta(event.deltaY, preferences.editing.verticalWheelDirection));
          } else if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            zoomArranger(event.altKey ? 'y' : 'x', event.deltaY < 0 ? 0.08 : -0.08);
          }
        }}>
          <div className="timeline-grid" style={{ width: trackHeaderWidth + timelineWidth }}>
            <div className="timeline-top-row" style={{ gridTemplateColumns: `${trackHeaderWidth}px ${timelineWidth}px` }}>
              <div className="corner">轨道<button className="add-track-btn" title="添加轨道" onClick={event => openContextMenu(event, [
                { label: '添加乐器轨道', action: () => void addTrack('instrument') },
                { label: '添加音频轨道', action: () => void addTrack('audio') }
              ])}>+</button></div>
              <div className="ruler" style={{ width: timelineWidth }} onMouseDown={seekFromTimeline}>
                {Array.from({ length: project.length_bars }, (_, index) => index + 1).map(bar =>
                  <div className={`ruler-bar ${bar % 2 === 1 ? 'labelled' : ''}`} style={{ width: pxPerBar }} key={bar}>{bar % 2 === 1 ? bar : ''}</div>
                )}
              </div>
            </div>
            <div className="playhead" style={{ left: trackHeaderWidth + currentBeat * pxPerBeat, height: 38 + project.tracks.length * laneHeight }} />
            {project.tracks.map((track, index) => <div className="timeline-track-row" style={{ gridTemplateColumns: `${trackHeaderWidth}px ${timelineWidth}px` }} key={`${track.name}-${index}`}>
              <TrackHeader track={track} index={index} selected={selected.type === 'track' && selected.track === index} height={laneHeight} onSelect={() => {
                setSelected({ type: 'track', track: index });
                setInspectorTab('library');
                if (track.preset && effectivePresets) {
                  const baseName = resolveBaseSystemPreset(track.preset, effectivePresets);
                  const basePreset = effectivePresets.presets.find(pr => pr.name === baseName);
                  const cat = basePreset ? presetCategory(basePreset) : undefined;
                  if (cat) setLibraryCategory(cat);
                }
              }} onPatch={(patch) => patchTrack(index, patch)} onContextMenu={event => openContextMenu(event, [
                { label: '重命名轨道', action: () => renameTrack(index) },
                { label: track.muted ? '取消静音' : '静音', action: () => void patchTrack(index, { muted: !track.muted }) },
                { label: track.solo ? '取消独奏' : '独奏', action: () => void patchTrack(index, { solo: !track.solo }) },
                { label: track.record_armed ? '取消录音待命' : '录音待命', action: () => void patchTrack(index, { record_armed: !track.record_armed }) },
                { label: '添加 MIDI 片段', action: () => void addMidiClip(index) },
                { label: '添加音频轨道', action: () => void addTrack('audio') },
                { label: '删除轨道', action: () => void deleteTrack(index) }
              ])} />
              <div className={`lane tool-${tool}`} style={{ width: timelineWidth, height: laneHeight, backgroundSize: `${pxPerBar}px 100%,${pxPerBeat}px 100%` }} onMouseDown={event => startClipMarquee(event, index)} onClick={event => { if (tool !== 'marquee') { setSelected({ type: 'project' }); setSelectedClips(new Set()); } }}>
                {track.clips.map(clip => <div
                  className={`clip ${selectedClips.has(keyForClip({ track: index, id: clip.id, kind: 'midi' })) ? 'selected' : ''}`}
                  key={clip.id}
                  onClick={event => { event.stopPropagation(); selectClip(index, clip, isAdditiveSelection(event)); }}
                  onMouseDown={event => startClipDrag(event, 'move', index, clip)}
                  onContextMenu={event => openContextMenu(event, [
                    { label: '重命名片段', action: () => renameClip(index, clip, 'midi') },
                    { label: '打开钢琴卷帘', action: () => openPianoRoll(index, clip) },
                    { label: '复制', action: () => copyClipDirect(index, clip, 'midi') },
                    { label: '复制一份', action: () => duplicateClipDirect(index, clip, 'midi') },
                    { label: '切分', action: () => splitMidiClipAtBeat(index, clip.id, currentBeat) },
                    { label: '换成绿色', action: () => void patchClip(index, clip.id, { color: '#18a83a' }) },
                    { label: '换成蓝色', action: () => void patchClip(index, clip.id, { color: '#2f73c8' }) },
                    { label: '删除', action: () => deleteClipDirect(index, clip.id, 'midi') }
                  ])}
                  onDoubleClick={event => { event.stopPropagation(); openPianoRoll(index, clip); }}
                  style={{ left: clipLeft(clip.bar, pxPerBar), width: clipWidth(clip.beats * (clip.loop_count || 1), pxPerBar), height: laneHeight, background: clip.color }}
                >
                  <div className="clip-handle left" onMouseDown={event => tool === 'pointer' && startClipDrag(event, 'resize-left', index, clip)} />
                  <div className="clip-title">{clip.name}{(clip.loop_count || 1) > 1 ? ` ×${clip.loop_count}` : ''}<div className="clip-loop-handle" onMouseDown={event => { event.preventDefault(); event.stopPropagation(); tool === 'pointer' && startClipDrag(event, 'loop-right', index, clip); }} /></div>
                  {preferences.display.showMidiThumbnails ? <MidiThumbnail clip={clip} /> : <div className="clip-notes">{'· '.repeat(Math.min(36, clip.notes.length))}</div>}
                  <div className="clip-handle right" onMouseDown={event => tool === 'pointer' && startClipDrag(event, 'resize-right', index, clip)} />
                </div>)}
                {(track.audio_clips || []).map(clip => <div
                  className={`clip audio-clip ${selectedClips.has(keyForClip({ track: index, id: clip.id, kind: 'audio' })) ? 'selected' : ''}`}
                  key={clip.id}
                  onClick={event => { event.stopPropagation(); selectAudioClip(index, clip, isAdditiveSelection(event)); }}
                  onMouseDown={event => { event.preventDefault(); event.stopPropagation(); if (tool === 'scissors') splitAudioClipAtBeat(index, clip.id, cutBeatFromClipEvent(event, clip)); else selectAudioClip(index, clip, isAdditiveSelection(event)); }}
                  onContextMenu={event => openContextMenu(event, [
                    { label: '重命名音频片段', action: () => renameClip(index, clip, 'audio') },
                    { label: '复制', action: () => copyClipDirect(index, clip, 'audio') },
                    { label: '复制一份', action: () => duplicateClipDirect(index, clip, 'audio') },
                    { label: '切分', action: () => splitAudioClipAtBeat(index, clip.id, currentBeat) },
                    { label: '删除', action: () => deleteClipDirect(index, clip.id, 'audio') }
                  ])}
                  style={{ left: clipLeft(clip.bar, pxPerBar), width: clipWidth(clip.beats, pxPerBar), height: laneHeight, background: clip.color }}
                >
                  <div className="clip-title">{clip.name}</div>
                  <div className="waveform" />
                </div>)}
              </div>
            </div>)}
            {marquee && <div className="marquee-box" style={{ left: Math.min(marquee.startX, marquee.x), top: Math.min(marquee.startY, marquee.y), width: Math.abs(marquee.x - marquee.startX), height: Math.abs(marquee.y - marquee.startY) }} />}
          </div>
        </div>
        {showMixer && <div className="panel-resizer horizontal" onMouseDown={startMixerResize} />}
        {showMixer && <Mixer project={project} onPatchTrack={patchTrack} renderTrackIcon={track => <TrackIcon kind={track.kind} preset={track.preset} size={18} />} />}
        {openClip && editorMode === 'docked' && <div className="panel-resizer horizontal" onMouseDown={startEditorResize} />}
        {openClip && editorMode === 'docked' && <PianoRoll trackIndex={editorClip!.track} track={project.tracks[editorClip!.track]} clip={openClip} tool={tool} mode={editorMode} selectedNotes={selectedNotes} selectedNote={selectedNote} noteRow={noteRow} pxPerBeat={pianoPxPerBeat} verticalWheelDirection={preferences.editing.verticalWheelDirection} onZoom={zoomPiano} onMode={setEditorMode} onClose={() => setEditorClip(null)} quantizeStep={quantizeStep} onQuantizeStep={setQuantizeStep} onCanvasDoubleClick={addNoteFromEditor} onSelectNote={(event, index) => selectNoteKey(editorClip!.track, openClip.id, index, isAdditiveSelection(event))} onContextNote={(event, index) => { selectNoteKey(editorClip!.track, openClip.id, index, isAdditiveSelection(event)); openContextMenu(event, [
          { label: '删除音符', action: () => deleteNoteDirect(editorClip!.track, openClip.id, index) },
          { label: '复制音符', action: () => copyNoteDirect(editorClip!.track, openClip.id, index) },
          { label: '复制一份', action: () => duplicateNoteDirect(editorClip!.track, openClip.id, index) },
          { label: '量化到网格', action: quantizeSelectedNotes }
        ]); }} onMarquee={(next) => setSelectedNotes(next)} onNoteMouseDown={(event, index, mode) => {
          const note = openClip.notes[index];
          event.stopPropagation();
          pushUndoSnapshot();
          setNoteDrag(mode === 'resize'
            ? { mode, index, startX: event.clientX, initialDuration: note.duration }
            : { mode, index, startX: event.clientX, startY: event.clientY, initialStart: noteStartBeats(note), initialPitch: note.pitch, initialDuration: note.duration });
        }} onPreviewNote={pitch => { const p = effectivePresets?.presets.find(pr => pr.name === project.tracks[editorClip!.track].preset); void engineRef.current?.previewNote(pitch, (p || {}) as Record<string, unknown>); }} onStopPreviewNote={pitch => engineRef.current?.stopPreviewNote(pitch)} currentBeat={currentBeat} />}
      </section>
    </main>
    {openClip && editorMode === 'floating' && <div className="editor-overlay">
      <PianoRoll trackIndex={editorClip!.track} track={project.tracks[editorClip!.track]} clip={openClip} tool={tool} mode={editorMode} selectedNotes={selectedNotes} selectedNote={selectedNote} noteRow={noteRow} pxPerBeat={pianoPxPerBeat} verticalWheelDirection={preferences.editing.verticalWheelDirection} onZoom={zoomPiano} onMode={setEditorMode} onClose={() => setEditorClip(null)} quantizeStep={quantizeStep} onQuantizeStep={setQuantizeStep} onCanvasDoubleClick={addNoteFromEditor} onSelectNote={(event, index) => selectNoteKey(editorClip!.track, openClip.id, index, isAdditiveSelection(event))} onContextNote={(event, index) => { selectNoteKey(editorClip!.track, openClip.id, index, isAdditiveSelection(event)); openContextMenu(event, [
        { label: '删除音符', action: () => deleteNoteDirect(editorClip!.track, openClip.id, index) },
        { label: '复制音符', action: () => copyNoteDirect(editorClip!.track, openClip.id, index) },
        { label: '复制一份', action: () => duplicateNoteDirect(editorClip!.track, openClip.id, index) },
        { label: '量化到网格', action: quantizeSelectedNotes }
      ]); }} onMarquee={(next) => setSelectedNotes(next)} onNoteMouseDown={(event, index, mode) => {
        const note = openClip.notes[index];
        event.stopPropagation();
        pushUndoSnapshot();
        setNoteDrag(mode === 'resize'
          ? { mode, index, startX: event.clientX, initialDuration: note.duration }
          : { mode, index, startX: event.clientX, startY: event.clientY, initialStart: noteStartBeats(note), initialPitch: note.pitch, initialDuration: note.duration });
      }} onPreviewNote={pitch => { const p = effectivePresets?.presets.find(pr => pr.name === project.tracks[editorClip!.track].preset); void engineRef.current?.previewNote(pitch, (p || {}) as Record<string, unknown>); }} onStopPreviewNote={pitch => engineRef.current?.stopPreviewNote(pitch)} currentBeat={currentBeat} />
    </div>}
    {contextMenu && <ContextMenuView menu={contextMenu} onClose={() => setContextMenu(null)} />}
    {showNewProject && <NewProjectDialog value={newProject} onChange={setNewProject} onCancel={() => setShowNewProject(false)} onCreate={createNewProject} />}
    {showPreferences && <PreferencesDialog value={preferences} tab={preferenceTab} devices={audioDevices} onTab={setPreferenceTab} onChange={setPreferences} onClose={() => setShowPreferences(false)} />}
    {showProjectSettings && <ProjectSettingsDialog project={project} onPatch={patchProjectMeta} onClose={() => setShowProjectSettings(false)} />}
    {showSynthEditor && selectedTrack && selected.type !== 'project' && selected.track !== undefined && <SynthEditor track={selectedTrack} trackIndex={selected.track} presets={effectivePresets} onPatchTrack={patchTrack} onClose={() => setShowSynthEditor(false)} renderTrackIcon={(track, size) => <TrackIcon kind={track.kind} preset={track.preset} size={size} />} />}
    {showKeyInput && <KeyInputPanel preset={(effectivePresets?.presets.find(p => p.name === selectedTrack?.preset) || {}) as Record<string, unknown>} onPreviewNote={(pitch, preset, vel) => void engineRef.current?.previewNote(pitch, preset, vel)} onStopPreviewNote={pitch => engineRef.current?.stopPreviewNote(pitch)} onClose={() => setShowKeyInput(false)} />}
  </div>;
}

function Transport({ project, currentBeat, isPlaying, isRecording, isRealtimeReady, audioError, canRecord, showMixer, onPlay, onStop, onRecord, onProjectSettings, onToggleMixer }: { project: Project; currentBeat: number; isPlaying: boolean; isRecording: boolean; isRealtimeReady: boolean; audioError: string | null; canRecord: boolean; showMixer: boolean; onPlay: () => void; onStop: () => void; onRecord: () => void; onProjectSettings: () => void; onToggleMixer: () => void }) {
  const bar = Math.floor(currentBeat / 4) + 1;
  const beat = Math.floor(currentBeat % 4) + 1;
  return <header className="transport">
    <div className="tool-group"><button className="icon-button" onClick={onStop}>■</button><button className="icon-button primary" disabled={!isRealtimeReady} onClick={onPlay}>{isPlaying ? '❚❚' : '▶'}</button><button className={`icon-button record ${isRecording ? 'active' : ''}`} disabled={!canRecord && !isRecording} title={canRecord || isRecording ? '录音' : '先在轨道上打开 R'} onClick={onRecord}>●</button></div>
    <div className={`lcd ${audioError ? 'warning' : ''}`}><strong>{String(bar).padStart(3, '0')} {beat}</strong><span>{audioError || (isRealtimeReady ? '实时' : '启动中')} · {project.bpm} BPM · {project.time_signature} · {project.key}</span></div>
    <div className="transport-right"><button className={`icon-button ${showMixer ? 'active' : ''}`} title="混音台" onClick={onToggleMixer}>台</button><button className="icon-button" title="项目设置" onClick={onProjectSettings}>⚙</button></div>
  </header>;
}

function Inspector({ project, presets, tab, libraryCategory, selected, selectedTrack, selectedClip, selectedAudioClip, selectedTrackIndex, audioUrl, outputDeviceId, showEditHint, onShowEditHint, onTab, onLibraryCategory, onPatchProject, onPatchTrack, onPatchClip, onPatchAudioClip, onOpenEditor, onOpenSynthEditor }: {
  project: Project;
  presets: PresetLibraryData | null;
  tab: InspectorTab;
  libraryCategory: string;
  selected: Selection;
  selectedTrack: Track | null;
  selectedClip: Clip | null;
  selectedAudioClip: AudioClip | null;
  selectedTrackIndex: number | null;
  audioUrl: string | null;
  outputDeviceId: string;
  showEditHint: boolean;
  onShowEditHint: (show: boolean) => void;
  onTab: (tab: InspectorTab) => void;
  onLibraryCategory: (category: string) => void;
  onPatchProject: (patch: Partial<Pick<Project, 'title' | 'bpm' | 'key' | 'time_signature' | 'length_bars'>>) => void;
  onPatchTrack: (index: number, patch: Partial<Track>) => void;
  onPatchClip: (patch: Partial<Clip>) => void | undefined;
  onPatchAudioClip: (patch: Partial<AudioClip>) => void | undefined;
  onOpenEditor: () => void | undefined;
  onOpenSynthEditor: () => void;
}) {
  const libraryPresets = (presets?.presets || []).filter(preset => presetCategory(preset) !== undefined);
  const categories = presetCategories(libraryPresets);
  const currentCategory = categories.includes(libraryCategory) ? libraryCategory : categories[0] || '钢琴';
  const categoryPresets = libraryPresets.filter(preset => presetCategory(preset) === currentCategory);
  const baseSystemPresetName = selectedTrack?.preset && presets
    ? resolveBaseSystemPreset(selectedTrack.preset, presets)
    : selectedTrack?.preset;
  return <aside className="inspector">
    <div className="inspector-tabs">
      <button className={tab === 'library' ? 'active' : ''} onClick={() => onTab('library')}>资源库</button>
      <button className={tab === 'inspector' ? 'active' : ''} onClick={() => onTab('inspector')}>检查器</button>
    </div>
    {tab === 'library' && <section className="library-section">
      {selectedTrack && selectedTrackIndex !== null && selectedTrack.kind !== 'audio' ? <>
        <div className="library-hero">
          <div className="instrument-art" onMouseEnter={() => onShowEditHint(true)} onMouseLeave={() => onShowEditHint(false)}>
            <TrackIcon kind={selectedTrack.kind} preset={selectedTrack.preset} size={48} />
            {showEditHint && <button className="edit-synth-btn" onClick={onOpenSynthEditor}>✎</button>}
          </div>
          <strong>{selectedTrack.preset ? presetDisplayName(presets, selectedTrack.preset) : '未选择乐器'}</strong>
          <span>{selectedTrack.name}</span>
        </div>
        <div className="library-browser">
          <div className="library-categories">{categories.map(category => <button key={category} className={category === currentCategory ? 'active' : ''} onClick={() => onLibraryCategory(category)}>{category}</button>)}</div>
          <div className="library-presets">{categoryPresets.map(preset => <button key={preset.name} className={preset.name === baseSystemPresetName ? 'active' : ''} onClick={() => onPatchTrack(selectedTrackIndex, { preset: preset.name, synth_params: null })}>
            <strong>{preset.display_name || '未命名预设'}</strong>
            {preset.description && <span>{preset.description}</span>}
            <small className="preset-engine-tag">{synthEngineLabel(preset.synth_engine)}</small>
          </button>)}</div>
        </div>
      </> : <div className="empty-state">{selectedTrack?.kind === 'audio' ? '音频轨没有软件乐器。' : '选择一个乐器轨道后可以在这里更换声音。'}</div>}
    </section>}
    {tab === 'inspector' && <>
      {selected.type === 'project' && <div className="empty-state">点击轨道或片段以查看属性</div>}
      {selected.type !== 'project' && selectedTrack && selectedTrackIndex !== null && selectedClip === null && selectedAudioClip === null && <section>
        <h3>轨道</h3>
        <EditableInput label="名称" value={selectedTrack.name} onCommit={value => onPatchTrack(selectedTrackIndex, { name: value })} />
        <label>Preset<PresetPicker presets={presets} value={selectedTrack.preset} onChange={name => onPatchTrack(selectedTrackIndex, { preset: name || undefined, synth_params: null })} /></label>
        <label>Volume</label><ValueFader value={selectedTrack.volume} onChange={value => onPatchTrack(selectedTrackIndex, { volume: value })} />
        <label>Pan</label><PanKnob value={selectedTrack.pan} onChange={value => onPatchTrack(selectedTrackIndex, { pan: value })} />
        <div className="button-row"><button className={selectedTrack.muted ? 'active' : ''} onClick={() => onPatchTrack(selectedTrackIndex, { muted: !selectedTrack.muted })}>Mute</button><button className={selectedTrack.solo ? 'active' : ''} onClick={() => onPatchTrack(selectedTrackIndex, { solo: !selectedTrack.solo })}>Solo</button><button className={selectedTrack.record_armed ? 'record active' : 'record'} onClick={() => onPatchTrack(selectedTrackIndex, { record_armed: !selectedTrack.record_armed })}>Rec</button></div>
      </section>}
      {selected.type !== 'project' && selectedClip && <section>
        <h3>片段</h3>
        <EditableInput label="名称" value={selectedClip.name} onCommit={value => onPatchClip({ name: value })} />
        <div className="field-grid"><EditableInput label="Bar" type="number" value={selectedClip.bar} min={1} step={0.25} onCommit={value => onPatchClip({ bar: Number(value) })} /><EditableInput label="Beats" type="number" value={selectedClip.beats} min={1} step={1} onCommit={value => onPatchClip({ beats: Number(value) })} /></div>
        <EditableInput label="Loop" type="number" value={selectedClip.loop_count || 1} min={1} step={1} onCommit={value => onPatchClip({ loop_count: Number(value) })} />
        <label>Color</label><input type="color" value={selectedClip.color} onChange={e => onPatchClip({ color: e.target.value })} />
        <button className="wide" onClick={onOpenEditor}>打开 MIDI 编辑器</button>
      </section>}
      {selected.type !== 'project' && selectedAudioClip && <section>
        <h3>音频片段</h3>
        <EditableInput label="名称" value={selectedAudioClip.name} onCommit={value => onPatchAudioClip({ name: value })} />
        <div className="field-grid"><EditableInput label="Bar" type="number" value={selectedAudioClip.bar} min={1} step={0.25} onCommit={value => onPatchAudioClip({ bar: Number(value) })} /><EditableInput label="Beats" type="number" value={selectedAudioClip.beats} min={1} step={1} onCommit={value => onPatchAudioClip({ beats: Number(value) })} /></div>
        <label>Gain</label><DeferredRange min={0} max={2} step={0.01} value={selectedAudioClip.gain} onCommit={value => onPatchAudioClip({ gain: value })} />
        <label>Color</label><input type="color" value={selectedAudioClip.color} onChange={e => onPatchAudioClip({ color: e.target.value })} />
      </section>}
    </>}
    {audioUrl && <AudioPreview src={audioUrl} outputDeviceId={outputDeviceId} />}
  </aside>;
}

function AudioPreview({ src, outputDeviceId }: { src: string; outputDeviceId: string }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const element = ref.current as (HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> }) | null;
    if (!element?.setSinkId || !outputDeviceId) return;
    void element.setSinkId(outputDeviceId).catch(() => undefined);
  }, [outputDeviceId, src]);
  return <audio ref={ref} controls src={src} />;
}

function MidiThumbnail({ clip }: { clip: Clip }) {
  const notes = midiThumbnailNotes(clip.notes, clip.beats, clip.loop_count || 1);
  return <div className="clip-thumbnail" aria-hidden="true">
    {notes.map((note, index) => <span key={index} style={{ left: `${note.leftPct}%`, top: `${note.topPct}%`, width: `${note.widthPct}%`, opacity: note.opacity }} />)}
  </div>;
}

function PreferencesDialog({ value, tab, devices, onTab, onChange, onClose }: { value: Preferences; tab: PreferenceTab; devices: DeviceOption[]; onTab: (tab: PreferenceTab) => void; onChange: (value: Preferences) => void; onClose: () => void }) {
  const inputs = devices.filter(device => device.kind === 'audioinput');
  const outputs = devices.filter(device => device.kind === 'audiooutput');
  const patch = <K extends keyof Preferences>(section: K, partial: Partial<Preferences[K]>) => onChange({ ...value, [section]: { ...value[section], ...partial } });
  return <div className="modal-backdrop" onClick={onClose}>
    <div className="preferences-window" onClick={event => event.stopPropagation()}>
      <div className="preferences-title">偏好设置</div>
      <div className="preferences-icons">
        {[
          ['general', '通用', '▣'],
          ['audio', '音频', '≋'],
          ['editing', '编辑', '✎'],
          ['display', '显示', '▭'],
          ['shortcuts', '快捷键', '⌘']
        ].map(([id, label, icon]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => onTab(id as PreferenceTab)}><span>{icon}</span>{label}</button>)}
      </div>
      <div className="preferences-content">
        {tab === 'general' && <section>
          <h3>通用</h3>
          <label>启动操作<select value={value.general.startupAction} onChange={event => patch('general', { startupAction: event.target.value as Preferences['general']['startupAction'] })}><option value="recent">打开最近使用的项目</option><option value="empty">打开空工程</option></select></label>
          <CheckRow label="关闭项目前确认" checked={value.general.confirmClose} onChange={checked => patch('general', { confirmClose: checked })} />
          <CheckRow label="编辑后自动保存" checked={value.general.autoSave} onChange={checked => patch('general', { autoSave: checked })} />
        </section>}
        {tab === 'audio' && <section>
          <h3>音频</h3>
          <CheckRow label="启用实时音频" checked={value.audio.realtimeEnabled} onChange={checked => patch('audio', { realtimeEnabled: checked })} />
          <label>主输出音量<DeferredRange min={0} max={1.5} step={0.01} value={value.audio.masterGain} onCommit={masterGain => patch('audio', { masterGain })} /></label>
          <label>延迟模式<select value={value.audio.latencyMode} onChange={event => patch('audio', { latencyMode: event.target.value as Preferences['audio']['latencyMode'] })}><option value="interactive">低延迟</option><option value="balanced">平衡</option><option value="playback">播放稳定</option></select></label>
          <label>I/O 缓冲区<select value={value.audio.bufferSize} onChange={event => patch('audio', { bufferSize: Number(event.target.value) })}><option value={64}>64 样本</option><option value={128}>128 样本</option><option value={256}>256 样本</option><option value={512}>512 样本</option></select></label>
          <label>输入设备<select value={value.audio.inputDeviceId} onChange={event => patch('audio', { inputDeviceId: event.target.value })}><option value="">系统默认</option>{inputs.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></label>
          <label>输出设备<select value={value.audio.outputDeviceId} onChange={event => patch('audio', { outputDeviceId: event.target.value })}><option value="">系统默认</option>{outputs.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></label>
        </section>}
        {tab === 'editing' && <section>
          <h3>编辑</h3>
          <CheckRow label="吸附到网格" checked={value.editing.snapToGrid} onChange={checked => patch('editing', { snapToGrid: checked })} />
          <label>默认工具<select value={value.editing.defaultTool} onChange={event => patch('editing', { defaultTool: event.target.value as Tool })}><option value="pointer">指针</option><option value="marquee">框选</option><option value="scissors">剪刀</option></select></label>
          <label>Option 滚轮方向<select value={value.editing.verticalWheelDirection} onChange={event => patch('editing', { verticalWheelDirection: event.target.value as Preferences['editing']['verticalWheelDirection'] })}><option value="natural">自然</option><option value="inverted">反向</option></select></label>
        </section>}
        {tab === 'display' && <section>
          <h3>显示</h3>
          <CheckRow label="显示 MIDI 片段音符缩略图" checked={value.display.showMidiThumbnails} onChange={checked => patch('display', { showMidiThumbnails: checked })} />
          <label>钢琴卷帘默认模式<select value={value.display.defaultEditorMode} onChange={event => patch('display', { defaultEditorMode: event.target.value as EditorMode })}><option value="docked">停靠</option><option value="floating">浮动</option></select></label>
        </section>}
        {tab === 'shortcuts' && <section>
          <h3>快捷键</h3>
          {SHORTCUT_GROUPS.map(group => <div className="shortcut-group" key={group.group}><h4>{group.group}</h4>{group.items.map(item => <div className="shortcut-row" key={`${group.group}-${item.keys}`}><kbd>{item.keys}</kbd><span>{item.action}</span></div>)}</div>)}
        </section>}
      </div>
    </div>
  </div>;
}

function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="check-row"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />{label}</label>;
}

function IconPiano() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: '100%', height: '100%' }}><rect x="2" y="5" width="6" height="14" rx="1"/><rect x="9" y="5" width="6" height="14" rx="1"/><rect x="16" y="5" width="6" height="14" rx="1"/><rect x="5.5" y="5" width="4" height="9" rx="0.5" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="9" rx="0.5" fill="currentColor" stroke="none"/></svg>; }
function IconBass() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: '100%', height: '100%' }}><path d="M6 4 Q14 2 15 10 Q16 17 9 18"/><circle cx="17" cy="7" r="1.5" fill="currentColor"/><circle cx="17" cy="13" r="1.5" fill="currentColor"/><line x1="4" y1="11" x2="7" y2="11"/><line x1="4" y1="14" x2="7" y2="14"/></svg>; }
function IconDrum() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: '100%', height: '100%' }}><ellipse cx="12" cy="15" rx="8" ry="4"/><line x1="4" y1="11" x2="4" y2="15"/><line x1="20" y1="11" x2="20" y2="15"/><ellipse cx="12" cy="11" rx="8" ry="3"/><line x1="8" y1="8" x2="5" y2="3"/><line x1="16" y1="8" x2="19" y2="3"/></svg>; }
function IconSynth() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: '100%', height: '100%' }}><rect x="2" y="8" width="20" height="10" rx="2"/><circle cx="6.5" cy="13" r="1.5"/><circle cx="12" cy="13" r="1.5"/><circle cx="17.5" cy="13" r="1.5"/><line x1="5" y1="8" x2="5" y2="5"/><line x1="10" y1="8" x2="10" y2="5"/><line x1="15" y1="8" x2="15" y2="5"/><line x1="20" y1="8" x2="20" y2="5"/></svg>; }
function IconGuitar() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: '100%', height: '100%' }}><ellipse cx="12" cy="16" rx="5" ry="5"/><ellipse cx="12" cy="9" rx="3" ry="3"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="10" y1="3.5" x2="14" y2="3.5"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/></svg>; }
function IconPad() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: '100%', height: '100%' }}><rect x="2" y="2" width="9" height="9" rx="1.5"/><rect x="13" y="2" width="9" height="9" rx="1.5"/><rect x="2" y="13" width="9" height="9" rx="1.5"/><rect x="13" y="13" width="9" height="9" rx="1.5"/></svg>; }
function IconAudio() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: '100%', height: '100%' }}><polyline points="2,12 5,7 7,17 10,5 12,19 14,8 16,15 19,10 22,12"/></svg>; }
function IconKeys() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: '100%', height: '100%' }}><rect x="2" y="6" width="20" height="12" rx="1.5"/><line x1="6" y1="6" x2="6" y2="18"/><line x1="10" y1="6" x2="10" y2="18"/><line x1="14" y1="6" x2="14" y2="18"/><line x1="18" y1="6" x2="18" y2="18"/><rect x="4.5" y="6" width="3" height="7" rx="0.5" fill="currentColor" stroke="none"/><rect x="8.5" y="6" width="3" height="7" rx="0.5" fill="currentColor" stroke="none"/><rect x="16.5" y="6" width="3" height="7" rx="0.5" fill="currentColor" stroke="none"/></svg>; }

function TrackIcon({ kind, preset, size = 20 }: { kind: string; preset?: string | null; size?: number }) {
  const name = (preset || kind || '').toLowerCase();
  const Icon = name.includes('drum') ? IconDrum
    : name.includes('bass') ? IconBass
    : name.includes('guitar') ? IconGuitar
    : name.includes('pad') ? IconPad
    : (name.includes('lead') || name.includes('synth') || name.includes('pluck')) ? IconSynth
    : name.includes('keys') || name.includes('electric') ? IconKeys
    : kind === 'audio' ? IconAudio
    : IconPiano;
  return <span style={{ width: size, height: size, display: 'inline-flex', color: 'rgba(255,255,255,0.8)', flexShrink: 0 }}><Icon /></span>;
}

function TrackHeader({ track, index, selected, height, onSelect, onPatch, onContextMenu }: { track: Track; index: number; selected: boolean; height: number; onSelect: () => void; onPatch: (patch: Partial<Track>) => void; onContextMenu: (event: React.MouseEvent) => void }) {
  return <div className={`track-head ${selected ? 'selected' : ''}`} onClick={onSelect} onContextMenu={onContextMenu} style={{ height }}>
    <div className="track-index-icon"><TrackIcon kind={track.kind} preset={track.preset} size={20} /><span className="track-num">{index + 1}</span></div>
    <div className="track-main"><strong>{track.name}</strong></div>
    <ValueFader className="track-slider" value={track.volume} onClick={event => event.stopPropagation()} onChange={value => onPatch({ volume: value })} />
    <button className={track.muted ? 'mini active' : 'mini'} onClick={event => { event.stopPropagation(); onPatch({ muted: !track.muted }); }}>M</button>
    <button className={track.solo ? 'mini active' : 'mini'} onClick={event => { event.stopPropagation(); onPatch({ solo: !track.solo }); }}>S</button>
    <button className={track.record_armed ? 'mini record active' : 'mini record'} onClick={event => { event.stopPropagation(); onPatch({ record_armed: !track.record_armed }); }}>R</button>
  </div>;
}

function EditableInput({ label, value, type = 'text', min, max, step, onCommit }: { label: string; value: string | number; type?: string; min?: number; max?: number; step?: number; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(String(value));
  const skipCommitRef = useRef(false);
  useEffect(() => setDraft(String(value)), [value]);
  function commit() {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    if (draft !== String(value)) onCommit(draft);
  }
  return <label>{label}<input className="editable" type={type} min={min} max={max} step={step} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') {
      skipCommitRef.current = true;
      setDraft(String(value));
      event.currentTarget.blur();
    }
  }} /></label>;
}

function PianoRoll({ trackIndex, track, clip, tool, mode, selectedNotes, selectedNote, noteRow, pxPerBeat, verticalWheelDirection, quantizeStep, onQuantizeStep, onZoom, onMode, onClose, onCanvasDoubleClick, onSelectNote, onContextNote, onMarquee, onNoteMouseDown, onPreviewNote, onStopPreviewNote, currentBeat }: {
  trackIndex: number;
  track: Track;
  clip: Clip;
  tool: Tool;
  mode: EditorMode;
  selectedNotes: Set<string>;
  selectedNote: number | null;
  noteRow: number;
  pxPerBeat: number;
  verticalWheelDirection: Preferences['editing']['verticalWheelDirection'];
  quantizeStep: number;
  onQuantizeStep: (step: number) => void;
  onZoom: (axis: 'x' | 'y', amount: number) => void;
  onMode: (mode: EditorMode) => void;
  onClose: () => void;
  onCanvasDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onSelectNote: (event: React.MouseEvent, index: number) => void;
  onContextNote: (event: React.MouseEvent, index: number) => void;
  onMarquee: (notes: Set<string>) => void;
  onNoteMouseDown: (event: React.MouseEvent, index: number, mode: NoteDrag['mode']) => void;
  onPreviewNote?: (pitch: number) => void;
  onStopPreviewNote?: (pitch?: number) => void;
  currentBeat?: number;
}) {
  const pitches = useMemo(() => Array.from({ length: MAX_PITCH - MIN_PITCH + 1 }, (_, index) => MAX_PITCH - index), []);
  const width = Math.max(clip.beats * pxPerBeat, 12 * pxPerBeat * 4);
  const [localMarquee, setLocalMarquee] = useState<Marquee | null>(null);
  const [scoreTab, setScoreTab] = useState<'piano' | 'score'>('piano');
  function startNoteMarquee(event: React.MouseEvent<HTMLDivElement>) {
    if (tool !== 'marquee') return;
    event.preventDefault();
    const area = event.currentTarget;
    const rect = area.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    setLocalMarquee({ type: 'notes', startX, startY, x: startX, y: startY, track: trackIndex, clip: clip.id });
    const onMove = (move: MouseEvent) => setLocalMarquee(current => current ? { ...current, x: move.clientX, y: move.clientY } : current);
    const onUp = (up: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      const minX = Math.min(startX, up.clientX) - rect.left;
      const maxX = Math.max(startX, up.clientX) - rect.left;
      const minY = Math.min(startY, up.clientY) - rect.top;
      const maxY = Math.max(startY, up.clientY) - rect.top;
      const next = new Set<string>();
      clip.notes.forEach((note, index) => {
        const left = noteStartBeats(note) * pxPerBeat;
        const right = left + Math.max(8, note.duration * pxPerBeat);
        const top = pitchToY(note.pitch, MAX_PITCH, noteRow);
        const bottom = top + noteRow;
        if (rectsIntersect(minX, maxX, left, right) && rectsIntersect(minY, maxY, top, bottom)) next.add(keyForNote({ track: trackIndex, clip: clip.id, index }));
      });
      onMarquee(next);
      setLocalMarquee(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, { once: true });
  }
  const clipStartBeat = (clip.bar - 1) * 4;
  return <section className={`piano-roll ${mode}`}>
    <div className="editor-toolbar">
      <strong>{track.name} · {clip.name}</strong>
      <span>{clip.notes.length} notes</span>
      <div className="editor-tabs"><button className={scoreTab === 'piano' ? 'active' : ''} onClick={() => setScoreTab('piano')}>钢琴卷帘</button><button className={scoreTab === 'score' ? 'active' : ''} onClick={() => setScoreTab('score')}>乐谱</button></div>
      {scoreTab === 'piano' && <select value={quantizeStep} onChange={e => onQuantizeStep(Number(e.target.value))} style={{ width: 'auto' }}>
        <option value={1}>1/4</option>
        <option value={0.5}>1/8</option>
        <option value={0.25}>1/16</option>
        <option value={0.125}>1/32</option>
        <option value={0.0625}>1/64</option>
      </select>}
    </div>
    {scoreTab === 'score' && <SheetMusicView clip={clip} cursorBeat={(currentBeat ?? 0) - clipStartBeat} />}
    <div className="piano-body" style={scoreTab === 'score' ? { display: 'none' } : undefined}>
      <div className="keys">{pitches.map(pitch => { const oct = pitch % 12; const isBlack = [1, 3, 6, 8, 10].includes(oct); const isC = oct === 0; return <div className={`key${isBlack ? ' black' : ''}${isC ? ' c' : ''}`} style={{ height: noteRow }} key={pitch} onMouseDown={event => { event.preventDefault(); onPreviewNote?.(pitch); }} onMouseUp={() => onStopPreviewNote?.(pitch)} onMouseLeave={() => onStopPreviewNote?.(pitch)}>{isC ? `C${Math.floor(pitch / 12) - 1}` : ''}</div>; })}</div>
      <div className={`note-area tool-${tool}`} style={{ width, height: pitches.length * noteRow, backgroundSize: `${pxPerBeat}px 100%,100% ${noteRow}px` }} onMouseDown={startNoteMarquee} onDoubleClick={onCanvasDoubleClick} onWheel={event => {
        if (event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          onZoom('y', verticalWheelDelta(event.deltaY, verticalWheelDirection));
        } else if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          onZoom(event.altKey ? 'y' : 'x', event.deltaY < 0 ? 0.08 : -0.08);
        }
      }}>
        <div className="beat-ruler">{Array.from({ length: Math.ceil(clip.beats) }, (_, index) => <span style={{ left: index * pxPerBeat }} key={index}>{index % 4 === 0 ? index / 4 + 1 : ''}</span>)}</div>
        {clip.notes.map((note, index) => <div className={`note ${selectedNote === index || selectedNotes.has(keyForNote({ track: trackIndex, clip: clip.id, index })) ? 'selected' : ''}`} key={`${index}-${note.pitch}-${note.bar}-${note.beat}`} onContextMenu={event => onContextNote(event, index)} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); onSelectNote(event, index); if (tool === 'pointer') onNoteMouseDown(event, index, 'move'); }} style={{ left: noteStartBeats(note) * pxPerBeat, top: pitchToY(note.pitch, MAX_PITCH, noteRow), width: Math.max(8, note.duration * pxPerBeat), height: noteRow - 2 }}>
          <span className="note-resize" onMouseDown={event => { event.preventDefault(); onNoteMouseDown(event, index, 'resize'); }} />
        </div>)}
        {localMarquee && <div className="marquee-box" style={{ left: Math.min(localMarquee.startX, localMarquee.x), top: Math.min(localMarquee.startY, localMarquee.y), width: Math.abs(localMarquee.x - localMarquee.startX), height: Math.abs(localMarquee.y - localMarquee.startY) }} />}
      </div>
    </div>
  </section>;
}

function ContextMenuView({ menu, onClose }: { menu: NonNullable<ContextMenu>; onClose: () => void }) {
  return <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={event => event.stopPropagation()}>
    {menu.items.map((item, index) => <button key={`${item.label}-${index}`} disabled={item.disabled} onClick={() => { if (!item.disabled) item.action(); onClose(); }}>{item.label}</button>)}
  </div>;
}

function NewProjectDialog({ value, onChange, onCancel, onCreate }: { value: { title: string; bpm: number; key: string; time_signature: string; length_bars: number; slug: string }; onChange: (value: { title: string; bpm: number; key: string; time_signature: string; length_bars: number; slug: string }) => void; onCancel: () => void; onCreate: () => void }) {
  return <div className="modal-backdrop" onClick={onCancel}>
    <div className="modal" onClick={event => event.stopPropagation()}>
      <h2>新建工程</h2>
      <label>标题<input value={value.title} onChange={event => onChange({ ...value, title: event.target.value, slug: slugifyClient(event.target.value) })} /></label>
      <div className="field-grid"><label>BPM<input type="number" min="40" max="240" value={value.bpm} onChange={event => onChange({ ...value, bpm: Number(event.target.value) })} /></label><label>长度<input type="number" min="1" value={value.length_bars} onChange={event => onChange({ ...value, length_bars: Number(event.target.value) })} /></label></div>
      <div className="field-grid"><label>拍号<input value={value.time_signature} onChange={event => onChange({ ...value, time_signature: event.target.value })} /></label><label>调性<input value={value.key} onChange={event => onChange({ ...value, key: event.target.value })} /></label></div>
      <label>Slug<input value={value.slug} onChange={event => onChange({ ...value, slug: event.target.value })} /></label>
      <div className="button-row"><button onClick={onCancel}>取消</button><button className="primary" onClick={onCreate}>创建</button></div>
    </div>
  </div>;
}

const KEY_PIANO_MAP: Record<string, number> = {
  'a': 0, 'w': 1, 's': 2, 'e': 3, 'd': 4, 'f': 5, 't': 6, 'g': 7, 'y': 8, 'h': 9, 'u': 10, 'j': 11,
  'k': 12, 'o': 13, 'l': 14, 'p': 15, ';': 16
};
const BLACK_KEY_CHARS = new Set(['w', 'e', 't', 'y', 'u', 'o', 'p']);

function KeyInputPanel({ preset, onPreviewNote, onStopPreviewNote, onClose }: {
  preset: Record<string, unknown>;
  onPreviewNote: (pitch: number, preset: Record<string, unknown>, velocity: number) => void;
  onStopPreviewNote: (pitch: number) => void;
  onClose: () => void;
}) {
  const [octave, setOctave] = React.useState(4);
  const [velocity, setVelocity] = React.useState(80);
  const [activeKeys, setActiveKeys] = React.useState<Set<string>>(new Set());
  const octaveRef = React.useRef(octave);
  const velocityRef = React.useRef(velocity);
  octaveRef.current = octave;
  velocityRef.current = velocity;

  React.useEffect(() => {
    const pressed = new Set<string>();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === 'escape') { onClose(); return; }
      if (key === 'z') { setOctave(o => Math.max(0, o - 1)); return; }
      if (key === 'x') { setOctave(o => Math.min(8, o + 1)); return; }
      if (key === 'c') { setVelocity(v => Math.max(10, v - 10)); return; }
      if (key === 'v') { setVelocity(v => Math.min(127, v + 10)); return; }
      const offset = KEY_PIANO_MAP[key];
      if (offset === undefined) return;
      event.preventDefault();
      const pitch = (octaveRef.current + 1) * 12 + offset;
      if (pressed.has(key)) return;
      pressed.add(key);
      setActiveKeys(new Set(pressed));
      onPreviewNote(pitch, preset, velocityRef.current / 127);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const offset = KEY_PIANO_MAP[key];
      if (offset === undefined) return;
      const pitch = (octaveRef.current + 1) * 12 + offset;
      pressed.delete(key);
      setActiveKeys(new Set(pressed));
      onStopPreviewNote(pitch);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, [preset, onPreviewNote, onStopPreviewNote, onClose]);

  const keyRows = [
    ['a','s','d','f','g','h','j','k','l',';'],
    ['w','e','','t','y','u','','o','p']
  ];
  return <div className="key-input-panel">
    <div className="key-input-header"><strong>音乐键入</strong><span>⌘K 关闭</span><button onClick={onClose}>✕</button></div>
    <div className="key-input-keyboard">
      <div className="key-input-row black-row">{keyRows[1].map((k, i) => k ? <div key={i} className={`ki-key black${activeKeys.has(k) ? ' active' : ''}`}><span>{k.toUpperCase()}</span></div> : <div key={i} className="ki-key spacer" />)}</div>
      <div className="key-input-row white-row">{keyRows[0].map((k, i) => <div key={i} className={`ki-key white${activeKeys.has(k) ? ' active' : ''}`}><span>{k === ';' ? ';' : k.toUpperCase()}</span></div>)}</div>
    </div>
    <div className="key-input-controls">
      <div className="ki-control"><span>八度</span><button onClick={() => setOctave(o => Math.max(0, o - 1))}>Z −</button><strong>C{octave}</strong><button onClick={() => setOctave(o => Math.min(8, o + 1))}>X +</button></div>
      <div className="ki-control"><span>力度</span><button onClick={() => setVelocity(v => Math.max(10, v - 10))}>C −</button><strong>{velocity}</strong><button onClick={() => setVelocity(v => Math.min(127, v + 10))}>V +</button></div>
    </div>
  </div>;
}

function ProjectSettingsDialog({ project, onPatch, onClose }: { project: Project; onPatch: (patch: Partial<Pick<Project, 'title' | 'bpm' | 'key' | 'time_signature' | 'length_bars'>>) => void; onClose: () => void }) {
  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={event => event.stopPropagation()}>
      <h2>项目设置</h2>
      <EditableInput label="标题" value={project.title} onCommit={v => onPatch({ title: v })} />
      <div className="field-grid">
        <EditableInput label="BPM" type="number" value={project.bpm} min={40} max={240} onCommit={v => onPatch({ bpm: Number(v) })} />
        <EditableInput label="长度" type="number" value={project.length_bars} min={1} onCommit={v => onPatch({ length_bars: Number(v) })} />
      </div>
      <div className="field-grid">
        <EditableInput label="拍号" value={project.time_signature} onCommit={v => onPatch({ time_signature: v })} />
        <EditableInput label="调性" value={project.key} onCommit={v => onPatch({ key: v })} />
      </div>
      <div className="meta">{project.tracks.length} 条轨道</div>
      <div className="button-row"><button onClick={onClose}>关闭</button></div>
    </div>
  </div>;
}

function rectsIntersect(a1: number, a2: number, b1: number, b2: number): boolean {
  return Math.max(a1, b1) <= Math.min(a2, b2);
}

function slugifyClient(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

function nextChannel(project: Project, kind: string): number {
  if (kind === 'drum') return 9;
  const used = new Set(project.tracks.map(track => track.channel).filter(channel => channel !== undefined));
  for (let channel = 0; channel < 16; channel += 1) {
    if (channel !== 9 && !used.has(channel)) return channel;
  }
  return 0;
}

const FALLBACK_PRESET_DISPLAY_NAMES: Record<string, string> = {
  'SYSTEM/钢琴/piano': 'Chrodis Grand Piano',
  'SYSTEM/钢琴/soft-piano': 'Soft Studio Piano',
  'SYSTEM/键盘乐器/keys': 'Classic Keys',
  'SYSTEM/键盘乐器/electric-keys': 'Electric Bell Keys',
  'SYSTEM/贝司/sub-bass': 'Deep Sub Bass',
  'SYSTEM/合成器/pluck-lead': 'Plucked Lead',
  'SYSTEM/管弦乐器/string-pad': 'String Pad',
  'SYSTEM/吉他/guitar-clean': 'Clean Guitar Approx',
  'SYSTEM/打击乐器/drum': 'Studio Drum Kit',
  'SYSTEM/电影音效/fx-pulse': 'Pulse FX',
  'SYSTEM/合成器/o3-lead': 'O3 Bright Lead',
  'SYSTEM/贝司/o3-bass': 'O3 Dirty Bass',
  'SYSTEM/音垫/o3-pad': 'O3 Soft Pad'
};

function presetDisplayName(library: PresetLibraryData | null, presetName: string): string {
  if (!presetName) return '未选择乐器';
  return library?.presets.find(preset => preset.name === presetName)?.display_name || FALLBACK_PRESET_DISPLAY_NAMES[presetName] || '未知预设';
}

function shouldTrackNameFollowPreset(track: Track, library: PresetLibraryData | null): boolean {
  if (!track.preset) return track.name === 'New Instrument' || track.name === '未知预设';
  const presetName = presetDisplayName(library, track.preset);
  return track.name === presetName || track.name === track.preset || track.name === 'New Instrument' || track.name === '未知预设';
}

function instrumentInitial(presetName: string): string {
  const name = presetName.toLowerCase();
  if (name.includes('bass')) return 'B';
  if (name.includes('drum')) return 'D';
  if (name.includes('guitar')) return 'G';
  if (name.includes('pad')) return 'P';
  if (name.includes('lead')) return 'L';
  return 'C';
}

function defaultDeviceLabel(device: MediaDeviceInfo): string {
  if (device.kind === 'audioinput') return '音频输入';
  if (device.kind === 'audiooutput') return '音频输出';
  return '音频设备';
}

createRoot(document.getElementById('root')!).render(<App />);
