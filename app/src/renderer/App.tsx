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
  | { mode: 'resize-left' | 'resize-right'; track: number; clip: string; startX: number; initialBar: number; initialBeats: number };
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
        const delta = snapBeats(event.clientX - noteDrag.startX, pianoPxPerBeat);
        notes[noteDrag.index] = { ...note, duration: Math.max(0.25, noteDrag.initialDuration + delta) };
      } else {
        const deltaX = snapBeats(event.clientX - noteDrag.startX, pianoPxPerBeat);
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
      Object.assign(draft.tracks[index], patch);
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
      draft.tracks.push({
        name: kind === 'audio' ? 'Audio Track' : 'New Instrument',
        kind,
        channel: nextChannel(draft, kind),
        preset: kind === 'audio' ? undefined : 'piano',
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
      setAudioError('实时音频尚未就绪');
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
    setClipDrag({ mode, track: trackIndex, clip: clip.id, startX: event.clientX, initialBar: clip.bar, initialBeats: clip.beats });
  }

  function cutBeatFromClipEvent(event: React.MouseEvent, clip: Pick<Clip, 'bar'>): number {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return beatIndexFromBar(clip.bar) + snapBeats(event.clientX - rect.left, pxPerBeat);
  }

  function addNoteFromEditor(event: React.MouseEvent<HTMLDivElement>) {
    if (!editorClip || !openClip || event.detail !== 2) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const start = Math.max(0, snapBeats(event.clientX - rect.left, pianoPxPerBeat));
    const pitch = yToPitch(event.clientY - rect.top, MAX_PITCH, MIN_PITCH, noteRow);
    const note = noteFromStartBeats(start, pitch, 1, 88);
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
      clip.notes = clip.notes.map((note, index) => selectedNotes.has(keyForNote({ track: editorClip.track, clip: editorClip.clip, index }))
        ? noteFromStartBeats(Math.round(noteStartBeats(note)), note.pitch, Math.max(0.25, Math.round(note.duration * 4) / 4), note.velocity)
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
    <Transport project={project} currentBeat={currentBeat} isPlaying={isPlaying} isRecording={isRecording} isRealtimeReady={isRealtimeReady && preferences.audio.realtimeEnabled} audioError={audioError} canRecord={project.tracks.some(track => track.record_armed)} onPlay={togglePlayback} onStop={stopPlayback} onRecord={toggleRecording} />
    <main className="studio" style={{ gridTemplateColumns: `${inspectorWidth}px 6px 1fr` }}>
      <Inspector project={project} presets={presets} tab={inspectorTab} libraryCategory={libraryCategory} selectedTrack={selectedTrack} selectedClip={selectedClip} selectedAudioClip={selectedAudioClip} selectedTrackIndex={selected.type !== 'project' ? selected.track : null} audioUrl={audioUrl} outputDeviceId={preferences.audio.outputDeviceId} onTab={setInspectorTab} onLibraryCategory={setLibraryCategory} onPatchProject={patchProjectMeta} onPatchTrack={patchTrack} onPatchClip={(patch) => { if (selectedClip && selected.type === 'clip') void patchClip(selected.track, selectedClip.id, patch); }} onPatchAudioClip={(patch) => { if (selectedAudioClip && selected.type !== 'project') void patchAudioClip(selected.track, selectedAudioClip.id, patch); }} onOpenEditor={() => selectedClip && selected.type === 'clip' ? openPianoRoll(selected.track, selectedClip) : undefined} />
      <div className="panel-resizer vertical" onMouseDown={startInspectorResize} />
      <section className={`arranger ${openClip && editorMode === 'docked' ? 'with-editor' : ''}`} style={{ gridTemplateRows: openClip && editorMode === 'docked' ? `minmax(220px, 1fr) 6px ${editorHeight}px` : '1fr' }}>
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
              <div className="corner">轨道</div>
              <div className="ruler" style={{ width: timelineWidth }} onMouseDown={seekFromTimeline}>
                {Array.from({ length: project.length_bars }, (_, index) => index + 1).map(bar =>
                  <div className={`ruler-bar ${bar % 2 === 1 ? 'labelled' : ''}`} style={{ width: pxPerBar }} key={bar}>{bar % 2 === 1 ? bar : ''}</div>
                )}
              </div>
            </div>
            <div className="playhead" style={{ left: trackHeaderWidth + currentBeat * pxPerBeat, height: 38 + project.tracks.length * laneHeight }} />
            {project.tracks.map((track, index) => <div className="timeline-track-row" style={{ gridTemplateColumns: `${trackHeaderWidth}px ${timelineWidth}px` }} key={`${track.name}-${index}`}>
              <TrackHeader track={track} index={index} selected={selected.type !== 'project' && selected.track === index} height={laneHeight} onSelect={() => setSelected({ type: 'track', track: index })} onPatch={(patch) => patchTrack(index, patch)} onContextMenu={event => openContextMenu(event, [
                { label: '重命名轨道', action: () => renameTrack(index) },
                { label: track.muted ? '取消静音' : '静音', action: () => void patchTrack(index, { muted: !track.muted }) },
                { label: track.solo ? '取消独奏' : '独奏', action: () => void patchTrack(index, { solo: !track.solo }) },
                { label: track.record_armed ? '取消录音待命' : '录音待命', action: () => void patchTrack(index, { record_armed: !track.record_armed }) },
                { label: '添加 MIDI 片段', action: () => void addMidiClip(index) },
                { label: '添加音频轨道', action: () => void addTrack('audio') },
                { label: '删除轨道', action: () => void deleteTrack(index) }
              ])} />
              <div className={`lane tool-${tool}`} style={{ width: timelineWidth, height: laneHeight, backgroundSize: `${pxPerBar}px 100%,${pxPerBeat}px 100%` }} onMouseDown={event => startClipMarquee(event, index)} onClick={event => { if (tool !== 'marquee') { seekFromTimeline(event); setSelected({ type: 'track', track: index }); } }}>
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
                  style={{ left: clipLeft(clip.bar, pxPerBar), width: clipWidth(clip.beats, pxPerBar), height: laneHeight, background: clip.color }}
                >
                  <div className="clip-handle left" onMouseDown={event => tool === 'pointer' && startClipDrag(event, 'resize-left', index, clip)} />
                  <div className="clip-title">{clip.name}</div>
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
        {openClip && editorMode === 'docked' && <div className="panel-resizer horizontal" onMouseDown={startEditorResize} />}
        {openClip && editorMode === 'docked' && <PianoRoll trackIndex={editorClip!.track} track={project.tracks[editorClip!.track]} clip={openClip} tool={tool} mode={editorMode} selectedNotes={selectedNotes} selectedNote={selectedNote} noteRow={noteRow} pxPerBeat={pianoPxPerBeat} verticalWheelDirection={preferences.editing.verticalWheelDirection} onZoom={zoomPiano} onMode={setEditorMode} onClose={() => setEditorClip(null)} onCanvasDoubleClick={addNoteFromEditor} onSelectNote={(event, index) => selectNoteKey(editorClip!.track, openClip.id, index, isAdditiveSelection(event))} onContextNote={(event, index) => { selectNoteKey(editorClip!.track, openClip.id, index, isAdditiveSelection(event)); openContextMenu(event, [
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
        }} />}
      </section>
    </main>
    {openClip && editorMode === 'floating' && <div className="editor-overlay">
      <PianoRoll trackIndex={editorClip!.track} track={project.tracks[editorClip!.track]} clip={openClip} tool={tool} mode={editorMode} selectedNotes={selectedNotes} selectedNote={selectedNote} noteRow={noteRow} pxPerBeat={pianoPxPerBeat} verticalWheelDirection={preferences.editing.verticalWheelDirection} onZoom={zoomPiano} onMode={setEditorMode} onClose={() => setEditorClip(null)} onCanvasDoubleClick={addNoteFromEditor} onSelectNote={(event, index) => selectNoteKey(editorClip!.track, openClip.id, index, isAdditiveSelection(event))} onContextNote={(event, index) => { selectNoteKey(editorClip!.track, openClip.id, index, isAdditiveSelection(event)); openContextMenu(event, [
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
      }} />
    </div>}
    {contextMenu && <ContextMenuView menu={contextMenu} onClose={() => setContextMenu(null)} />}
    {showNewProject && <NewProjectDialog value={newProject} onChange={setNewProject} onCancel={() => setShowNewProject(false)} onCreate={createNewProject} />}
    {showPreferences && <PreferencesDialog value={preferences} tab={preferenceTab} devices={audioDevices} onTab={setPreferenceTab} onChange={setPreferences} onClose={() => setShowPreferences(false)} />}
  </div>;
}

function Transport({ project, currentBeat, isPlaying, isRecording, isRealtimeReady, audioError, canRecord, onPlay, onStop, onRecord }: { project: Project; currentBeat: number; isPlaying: boolean; isRecording: boolean; isRealtimeReady: boolean; audioError: string | null; canRecord: boolean; onPlay: () => void; onStop: () => void; onRecord: () => void }) {
  const bar = Math.floor(currentBeat / 4) + 1;
  const beat = Math.floor(currentBeat % 4) + 1;
  return <header className="transport">
    <div className="tool-group"><button className="icon-button" onClick={onStop}>■</button><button className="icon-button primary" disabled={!isRealtimeReady} onClick={onPlay}>{isPlaying ? '❚❚' : '▶'}</button><button className={`icon-button record ${isRecording ? 'active' : ''}`} disabled={!canRecord && !isRecording} title={canRecord || isRecording ? '录音' : '先在轨道上打开 R'} onClick={onRecord}>●</button></div>
    <div className={`lcd ${audioError ? 'warning' : ''}`}><strong>{String(bar).padStart(3, '0')} {beat}</strong><span>{audioError || (isRealtimeReady ? '实时' : '启动中')} · {project.bpm} BPM · {project.time_signature} · {project.key}</span></div>
  </header>;
}

function Inspector({ project, presets, tab, libraryCategory, selectedTrack, selectedClip, selectedAudioClip, selectedTrackIndex, audioUrl, outputDeviceId, onTab, onLibraryCategory, onPatchProject, onPatchTrack, onPatchClip, onPatchAudioClip, onOpenEditor }: {
  project: Project;
  presets: PresetLibraryData | null;
  tab: InspectorTab;
  libraryCategory: string;
  selectedTrack: Track | null;
  selectedClip: Clip | null;
  selectedAudioClip: AudioClip | null;
  selectedTrackIndex: number | null;
  audioUrl: string | null;
  outputDeviceId: string;
  onTab: (tab: InspectorTab) => void;
  onLibraryCategory: (category: string) => void;
  onPatchProject: (patch: Partial<Pick<Project, 'title' | 'bpm' | 'key' | 'time_signature' | 'length_bars'>>) => void;
  onPatchTrack: (index: number, patch: Partial<Track>) => void;
  onPatchClip: (patch: Partial<Clip>) => void | undefined;
  onPatchAudioClip: (patch: Partial<AudioClip>) => void | undefined;
  onOpenEditor: () => void | undefined;
}) {
  const libraryPresets = (presets?.presets || []).filter(preset => preset.category);
  const categories = Array.from(new Set(libraryPresets.map(preset => String(preset.category))));
  const currentCategory = categories.includes(libraryCategory) ? libraryCategory : categories[0] || '钢琴';
  const categoryPresets = libraryPresets.filter(preset => preset.category === currentCategory);
  return <aside className="inspector">
    <div className="inspector-tabs">
      <button className={tab === 'library' ? 'active' : ''} onClick={() => onTab('library')}>资源库</button>
      <button className={tab === 'inspector' ? 'active' : ''} onClick={() => onTab('inspector')}>检查器</button>
    </div>
    {tab === 'library' && <section className="library-section">
      {selectedTrack && selectedTrackIndex !== null && selectedTrack.kind !== 'audio' ? <>
        <div className="library-hero">
          <div className="instrument-art">{instrumentInitial(selectedTrack.preset || 'piano')}</div>
          <strong>{presetDisplayName(presets, selectedTrack.preset || 'piano')}</strong>
          <span>{selectedTrack.name}</span>
        </div>
        <div className="library-browser">
          <div className="library-categories">{categories.map(category => <button key={category} className={category === currentCategory ? 'active' : ''} onClick={() => onLibraryCategory(category)}>{category}</button>)}</div>
          <div className="library-presets">{categoryPresets.map(preset => <button key={preset.name} className={preset.name === selectedTrack.preset ? 'active' : ''} onClick={() => onPatchTrack(selectedTrackIndex, { preset: preset.name })}>
            <strong>{preset.display_name || preset.name}</strong>
            <span>{preset.description || preset.name}</span>
          </button>)}</div>
        </div>
      </> : <div className="empty-state">{selectedTrack?.kind === 'audio' ? '音频轨没有软件乐器。' : '选择一个乐器轨道后可以在这里更换声音。'}</div>}
    </section>}
    {tab === 'inspector' && <>
      <section className="project-section">
        <h3>工程</h3>
        <EditableInput label="标题" value={project.title} onCommit={value => onPatchProject({ title: value })} />
        <div className="field-grid"><EditableInput label="BPM" type="number" value={project.bpm} min={40} max={240} onCommit={value => onPatchProject({ bpm: Number(value) })} /><EditableInput label="长度" type="number" value={project.length_bars} min={1} onCommit={value => onPatchProject({ length_bars: Number(value) })} /></div>
        <div className="field-grid"><EditableInput label="拍号" value={project.time_signature} onCommit={value => onPatchProject({ time_signature: value })} /><EditableInput label="调性" value={project.key} onCommit={value => onPatchProject({ key: value })} /></div>
        <div className="meta">{project.tracks.length} tracks</div>
      </section>
      {selectedTrack && selectedTrackIndex !== null && <section>
        <h3>轨道</h3>
        <EditableInput label="名称" value={selectedTrack.name} onCommit={value => onPatchTrack(selectedTrackIndex, { name: value })} />
        <EditableInput label="Preset" value={selectedTrack.preset || ''} onCommit={value => onPatchTrack(selectedTrackIndex, { preset: value || undefined })} />
        <label>Volume</label><DeferredRange min={0} max={127} value={selectedTrack.volume} onCommit={value => onPatchTrack(selectedTrackIndex, { volume: value })} />
        <label>Pan</label><DeferredRange min={0} max={127} value={selectedTrack.pan} onCommit={value => onPatchTrack(selectedTrackIndex, { pan: value })} />
        <div className="button-row"><button className={selectedTrack.muted ? 'active' : ''} onClick={() => onPatchTrack(selectedTrackIndex, { muted: !selectedTrack.muted })}>Mute</button><button className={selectedTrack.solo ? 'active' : ''} onClick={() => onPatchTrack(selectedTrackIndex, { solo: !selectedTrack.solo })}>Solo</button><button className={selectedTrack.record_armed ? 'record active' : 'record'} onClick={() => onPatchTrack(selectedTrackIndex, { record_armed: !selectedTrack.record_armed })}>Rec</button></div>
      </section>}
      {selectedClip && <section>
        <h3>片段</h3>
        <EditableInput label="名称" value={selectedClip.name} onCommit={value => onPatchClip({ name: value })} />
        <div className="field-grid"><EditableInput label="Bar" type="number" value={selectedClip.bar} min={1} step={0.25} onCommit={value => onPatchClip({ bar: Number(value) })} /><EditableInput label="Beats" type="number" value={selectedClip.beats} min={1} step={1} onCommit={value => onPatchClip({ beats: Number(value) })} /></div>
        <EditableInput label="Loop" type="number" value={selectedClip.loop_count || 1} min={1} step={1} onCommit={value => onPatchClip({ loop_count: Number(value) })} />
        <label>Color</label><input type="color" value={selectedClip.color} onChange={e => onPatchClip({ color: e.target.value })} />
        <button className="wide" onClick={onOpenEditor}>打开 MIDI 编辑器</button>
      </section>}
      {selectedAudioClip && <section>
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

function TrackHeader({ track, index, selected, height, onSelect, onPatch, onContextMenu }: { track: Track; index: number; selected: boolean; height: number; onSelect: () => void; onPatch: (patch: Partial<Track>) => void; onContextMenu: (event: React.MouseEvent) => void }) {
  return <div className={`track-head ${selected ? 'selected' : ''}`} onClick={onSelect} onContextMenu={onContextMenu} style={{ height }}>
    <div className="track-index">{index + 1}</div>
    <div className="track-main"><strong>{track.name}</strong><span>{track.preset || track.kind}</span><small>vol {track.volume} · pan {track.pan}</small></div>
    <DeferredRange className="track-slider" min={0} max={127} value={track.volume} onClick={event => event.stopPropagation()} onCommit={value => onPatch({ volume: value })} />
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

function DeferredRange({ value, min, max, step = 1, className, onClick, onCommit }: { value: number; min: number; max: number; step?: number; className?: string; onClick?: (event: React.MouseEvent<HTMLInputElement>) => void; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(value);
  }, [value, dirty]);
  function commit() {
    if (!dirty) return;
    setDirty(false);
    if (draft !== value) onCommit(draft);
  }
  return <input className={className} type="range" min={min} max={max} step={step} value={draft} onClick={onClick} onChange={event => {
    setDirty(true);
    setDraft(Number(event.currentTarget.value));
  }} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />;
}

function PianoRoll({ trackIndex, track, clip, tool, mode, selectedNotes, selectedNote, noteRow, pxPerBeat, verticalWheelDirection, onZoom, onMode, onClose, onCanvasDoubleClick, onSelectNote, onContextNote, onMarquee, onNoteMouseDown }: {
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
  onZoom: (axis: 'x' | 'y', amount: number) => void;
  onMode: (mode: EditorMode) => void;
  onClose: () => void;
  onCanvasDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onSelectNote: (event: React.MouseEvent, index: number) => void;
  onContextNote: (event: React.MouseEvent, index: number) => void;
  onMarquee: (notes: Set<string>) => void;
  onNoteMouseDown: (event: React.MouseEvent, index: number, mode: NoteDrag['mode']) => void;
}) {
  const pitches = useMemo(() => Array.from({ length: MAX_PITCH - MIN_PITCH + 1 }, (_, index) => MAX_PITCH - index), []);
  const width = Math.max(clip.beats * pxPerBeat, 12 * pxPerBeat * 4);
  const [localMarquee, setLocalMarquee] = useState<Marquee | null>(null);
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
  return <section className={`piano-roll ${mode}`}>
    <div className="editor-toolbar">
      <strong>{track.name} · {clip.name}</strong>
      <span>{clip.notes.length} notes</span>
    </div>
    <div className="piano-body">
      <div className="keys">{pitches.map(pitch => <div className={pitch % 12 === 0 ? 'key c' : 'key'} style={{ height: noteRow }} key={pitch}>{pitch % 12 === 0 ? `C${Math.floor(pitch / 12) - 1}` : ''}</div>)}</div>
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

function presetDisplayName(library: PresetLibraryData | null, presetName: string): string {
  return library?.presets.find(preset => preset.name === presetName)?.display_name || presetName || '未选择乐器';
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

createRoot(document.getElementById('root')!).render(<App />);
