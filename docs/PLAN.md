# 完成 `docs/TODO.md` 当前需求

## Summary

把项目从旧品牌彻底迁移到 **Chrodis**，补齐偏好设置、左侧资源库、MIDI 片段音符缩略图和快捷键文档，并修复当前实时播放无声的问题。实现时以现有 Electron + React + Python API 架构为基础，不重写工程模型；所有用户可见入口、命令、包名、默认工程扩展都统一为 Chrodis。

## Key Changes

- **Chrodis 全量改名**
  - Python 包、CLI 入口、Electron app 名称、窗口标题、菜单、前端文案、README、测试全部使用 `chrodis` / `Chrodis`。
  - 默认工程格式改为 `.chrodis/` 和 `.chrodis.json`，移除旧工程扩展兼容逻辑、旧命令入口和旧 worklet 名称。
  - Electron 设置 `app.name/app.setName/productName` 为 `Chrodis`，使用新的 `app/assets/chrodis-icon.svg` 作为窗口和 Dock 图标。

- **系统偏好设置**
  - 在 macOS 原生菜单增加 `Chrodis > 偏好设置...`，快捷键 `Cmd+,`，通过 IPC 命令打开 React 偏好设置弹窗。
  - 做轻量可用版，分为：通用、音频、编辑、显示、快捷键。
  - 偏好设置保存到本地用户设置 `localStorage` 的 `chrodis.preferences.v1`，不写入工程文件。
  - 音频页包含实时音频开关、主输出音量、延迟模式/缓冲区、输入设备选择；输入设备用于录音，输出设备若浏览器支持 `setSinkId` 则用于导出预览音频，实时引擎至少应用主输出音量和延迟模式。
  - 编辑/显示页包含网格吸附、默认工具、滚轮缩放方向、是否显示 MIDI 缩略图、默认钢琴卷帘停靠状态。

- **左侧资源库**
  - 左侧 Inspector 改为可切换的“资源库 / 检查器”布局；资源库用于给当前选中轨道更换乐器。
  - 扩展 `presets/builtin.json`，增加分类、显示名、描述和更多内置合成器预设，例如钢琴、贝司、架子鼓、电子鼓、吉他类近似音色、键盘、Pad、Lead、音效。
  - 资源库 UI 采用类似 Logic 的两栏分类 + 预设列表；点击预设立即更新当前轨道 `preset` 并推入 undo 栈，实时播放引擎同步更新。
  - 没有选中轨道时资源库显示禁用提示；音频轨不显示 MIDI 乐器预设，或只显示“音频轨无软件乐器”。

- **MIDI pattern 音符缩略图**
  - 时间线 MIDI clip 内不再用点号占位，改为根据 `clip.notes` 绘制小型 piano-roll 缩略图。
  - 缩略图按片段内部起止 beat 和 pitch 范围归一化，显示短横线；支持 loop_count 时重复绘制可见循环。
  - 片段过窄时自动减少细节但保留音符走势，不让文字和缩略图重叠。
  - 增加纯函数测试覆盖 note-to-thumbnail 几何映射、空 clip、极窄 clip、多 pitch 范围和 loop 显示。

- **快捷键与触控板**
  - 增加 `Cmd+A` 全选：arranger 焦点全选片段，piano roll 焦点全选音符。
  - 增加 `Option + 双指上下滚动` 做垂直缩放：在时间线缩放轨道高度，在钢琴卷帘缩放音符行高。
  - 保留并整理现有快捷键：`Space` 播放/暂停，`Enter` 停止，`Delete` 删除，`Cmd+Z/Shift+Cmd+Z` 撤销/重做，`Cmd+C/V/D` 复制/粘贴/复制一份，`1/2/3` 指针/框选/剪刀，`Cmd+Plus/Minus/0` 水平缩放。
  - 新增 `docs/SHORTCUTS.md`，按“传输、编辑、选择、工具、缩放、窗口/偏好设置”分组写清楚快捷键。

- **修复播放无声**
  - 检查并修正实时播放链路：renderer 加载 `chrodis-worklet.js`、worklet 注册名、项目事件 flatten、preset 名称、AudioContext resume、输出增益。
  - 在播放失败或 worklet 加载失败时给 UI 明确状态，不再只是按钮无反应。
  - 增加一个最小“可听测试”级别的前端单元测试：MIDI clip notes 能生成 realtime events，preset fallback 存在，master output gain 不为 0。

## Test Plan

- 前端：
  - `cd app && npm test`
  - `cd app && npm run build`
  - 增加测试：Chrodis 菜单命令映射、偏好设置读写/默认值、`Cmd+A` 全选逻辑、Option 滚轮垂直缩放、MIDI 缩略图几何、realtime project 事件生成。

- Python：
  - `PYTHONPATH=src python3 -m unittest tests/test_chrodis.py`
  - 验证 `python3 -m chrodis.cli ...`、`chrodis` console script、`.chrodis` 工程保存/读取、新建工程、导出 MIDI/WAV。
  - 确认源码和文档中不再残留旧品牌字符串，除非是 git 历史外部内容。

- 手动验收：
  - 启动 `chrodis gui projects/mandopop-3min.chrodis`，Electron 菜单、Dock/窗口标题和图标均显示 Chrodis。
  - 打开偏好设置，修改音频/显示/编辑选项，关闭重开后仍保留。
  - 选中轨道，在资源库切换钢琴、贝司、Pad、Lead 后，轨道 preset 改变且播放音色变化。
  - 时间线 MIDI 片段显示真实音符缩略图。
  - 播放 demo 工程有声音；静音/独奏仍按轨道状态生效。
  - `Cmd+A`、Option 双指滚动、常用编辑快捷键可用，且输入框聚焦时不误触工程命令。

## Assumptions

- 采用你选择的“彻底移除旧名”：实现完成后不保留旧包名、旧命令或旧工程扩展兼容。
- 偏好设置第一版做真实可保存、会影响应用行为的轻量版，不追求完整复刻 Logic 的所有高级设置。
- 资源库基于现有内置合成器预设扩展，不引入外部采样库或插件系统。
- MIDI 缩略图只用于时间线展示，不改变 MIDI 数据本身。
