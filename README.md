# Chrodis

Chrodis 是一个迷你 Logic 风格音乐工程工具，桌面界面使用 Electron + React，底层继续由 `chrodis` Python 工具和可读 JSON 工程文件驱动。它可以创建轨道、添加段落、写入 MIDI 音符或内置 pattern，并导出标准 MIDI/WAV 文件。

第一版只处理 MIDI 工程，不恢复或依赖 `.logicx` 工程，也不做音频混音、插件或实时播放。

## 常用命令

```bash
PYTHONPATH=src python3 -m chrodis.cli init projects/poker-face.chrodis.json --title "Poker Face" --bpm 119 --key C
PYTHONPATH=src python3 -m chrodis.cli add-track projects/poker-face.chrodis.json "Piano Pulse" --kind instrument --program 0 --preset piano --volume 88
PYTHONPATH=src python3 -m chrodis.cli marker projects/poker-face.chrodis.json 1 Intro
PYTHONPATH=src python3 -m chrodis.cli pattern projects/poker-face.chrodis.json "Piano Pulse" piano-pulse --start-bar 1 --bars 8
PYTHONPATH=src python3 -m chrodis.cli export-midi projects/poker-face.chrodis.json exports/headless/poker-face-headless.mid
PYTHONPATH=src python3 -m chrodis.cli export-wav projects/poker-face.chrodis.json exports/headless/poker-face-headless.wav --preset-library presets
PYTHONPATH=src python3 -m chrodis.cli compose mandopop projects/mandopop-3min.chrodis.json --title "晚风里的光" --minutes 3
PYTHONPATH=src python3 -m chrodis.cli gui projects/mandopop-3min.chrodis.json --port 8765
PYTHONPATH=src python3 -m chrodis.cli migrate projects/mandopop-3min.chrodis.json projects/mandopop-3min.chrodis
PYTHONPATH=src python3 -m chrodis.cli import-midi input.mid projects/imported.chrodis --title Imported
```

安装后也可以直接使用脚本入口：

```bash
chrodis info projects/poker-face.chrodis.json
```

`export-wav` 使用 JSON 预设驱动的内置合成器离线渲染，不需要 Logic 或第三方音源。轨道可以用 `--preset piano` 指定音色；如果旧工程没有 preset，普通轨道会按 MIDI program 回退到 keys/bass/lead/pad，鼓轨继续合成 kick、snare、hat。

内置预设保存在 `presets/` 目录下，并按乐器分类分成多个 JSON 文件。

## Chrodis 桌面界面

Chrodis 桌面界面使用 Electron + React + TypeScript，Python 作为本地工程/音频 API。安装前端依赖后启动：

```bash
cd app
npm install
cd ..
PYTHONPATH=src python3 -m chrodis.cli gui projects/mandopop-3min.chrodis --port 8765
```

界面包含轨道列表、Logic 风格时间线、Inspector、macOS 原生菜单、传输控制、保存、导出 MIDI/WAV、添加轨道、添加片段和生成华语流行 Demo。`chrodis serve PROJECT --port 8765` 可单独启动 Python API 服务用于调试。

## 项目文件夹

新的项目推荐使用 `.chrodis/` 文件夹：

```text
projects/song.chrodis/
  project.json
  exports/
  assets/
```

旧的 `*.chrodis.json` 仍然兼容。

## 内置 pattern

- `piano-pulse`
- `sub-bass`
- `four-on-floor`
- `pad`
- `lead-hook`
