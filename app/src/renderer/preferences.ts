export type Preferences = {
  general: {
    startupAction: 'recent' | 'empty';
    confirmClose: boolean;
    autoSave: boolean;
  };
  audio: {
    realtimeEnabled: boolean;
    masterGain: number;
    latencyMode: 'interactive' | 'balanced' | 'playback';
    bufferSize: number;
    inputDeviceId: string;
    outputDeviceId: string;
  };
  editing: {
    snapToGrid: boolean;
    defaultTool: 'pointer' | 'marquee' | 'scissors';
    verticalWheelDirection: 'natural' | 'inverted';
  };
  display: {
    showMidiThumbnails: boolean;
    defaultEditorMode: 'docked' | 'floating';
  };
};

export const PREFERENCES_KEY = 'chrodis.preferences.v1';

export const DEFAULT_PREFERENCES: Preferences = {
  general: {
    startupAction: 'recent',
    confirmClose: true,
    autoSave: true
  },
  audio: {
    realtimeEnabled: true,
    masterGain: 0.9,
    latencyMode: 'interactive',
    bufferSize: 128,
    inputDeviceId: '',
    outputDeviceId: ''
  },
  editing: {
    snapToGrid: true,
    defaultTool: 'pointer',
    verticalWheelDirection: 'natural'
  },
  display: {
    showMidiThumbnails: true,
    defaultEditorMode: 'docked'
  }
};

export type ShortcutGroup = { group: string; items: Array<{ keys: string; action: string }> };

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  { group: '传输', items: [
    { keys: 'Space', action: '播放/暂停' },
    { keys: 'Enter', action: '停止并回到当前位置' },
    { keys: 'Cmd+R', action: '开始/停止录音' }
  ] },
  { group: '编辑', items: [
    { keys: 'Cmd+Z', action: '撤销' },
    { keys: 'Shift+Cmd+Z', action: '重做' },
    { keys: 'Cmd+C / Cmd+V', action: '复制/粘贴当前选择' },
    { keys: 'Cmd+D', action: '复制一份' },
    { keys: 'Delete', action: '删除当前焦点中的音符、片段或轨道' }
  ] },
  { group: '选择', items: [
    { keys: 'Cmd+A', action: '全选当前区域的片段或音符' },
    { keys: 'Shift 点击', action: '追加选择' },
    { keys: 'Cmd 点击', action: '切换选择' }
  ] },
  { group: '工具', items: [
    { keys: '1', action: '指针工具' },
    { keys: '2', action: '框选工具' },
    { keys: '3', action: '剪刀工具' }
  ] },
  { group: '缩放', items: [
    { keys: 'Cmd++ / Cmd+-', action: '水平放大/缩小' },
    { keys: 'Option + 双指上下滚动', action: '垂直放大/缩小' },
    { keys: 'Cmd+0', action: '重置缩放' }
  ] },
  { group: '窗口', items: [
    { keys: 'Cmd+,', action: '打开偏好设置' },
    { keys: 'Esc', action: '关闭菜单、框选或编辑器浮层' }
  ] }
];

export function loadPreferences(storage: Storage | undefined = typeof window !== 'undefined' ? window.localStorage : undefined): Preferences {
  if (!storage) return DEFAULT_PREFERENCES;
  try {
    const raw = storage.getItem(PREFERENCES_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    return mergePreferences(DEFAULT_PREFERENCES, JSON.parse(raw) as Partial<Preferences>);
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: Preferences, storage: Storage | undefined = typeof window !== 'undefined' ? window.localStorage : undefined): void {
  storage?.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
}

export function mergePreferences(base: Preferences, patch: Partial<Preferences>): Preferences {
  return {
    general: { ...base.general, ...patch.general },
    audio: { ...base.audio, ...patch.audio },
    editing: { ...base.editing, ...patch.editing },
    display: { ...base.display, ...patch.display }
  };
}

export function verticalWheelDelta(deltaY: number, direction: Preferences['editing']['verticalWheelDirection']): number {
  const amount = deltaY < 0 ? 0.08 : -0.08;
  return direction === 'inverted' ? -amount : amount;
}
