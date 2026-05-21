const { app, BrowserWindow, Menu, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

let backend = null;
let quitting = false;
let mainWindow = null;
const appIcon = join(__dirname, 'assets', 'chrodis-icon.iconset', 'icon_512x512@2x.png');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function defaultRendererUrl() {
  if (app.isPackaged) return pathToFileURL(join(__dirname, 'dist', 'index.html')).toString();
  return 'http://127.0.0.1:5173/';
}

function defaultProjectPath() {
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'projects', 'mandopop-3min.chrodis');
    if (existsSync(bundled)) return bundled;
  }
  return '../projects/mandopop-3min.chrodis';
}

function backendSpawn(project, port) {
  const env = { ...process.env, CHRODIS_EMBEDDED_API: '1' };
  if (app.isPackaged) {
    return {
      command: process.env.CHRODIS_CLI || 'chrodis',
      args: ['serve', project, '--port', port],
      cwd: process.resourcesPath,
      env
    };
  }
  return {
    command: 'python3',
    args: ['-m', 'chrodis.cli', 'serve', project, '--port', port],
    cwd: '..',
    env: { ...env, PYTHONPATH: 'src' }
  };
}

async function main() {
  const project = arg('--project', defaultProjectPath());
  const port = arg('--port', '8765');
  const rendererUrl = arg('--renderer-url', defaultRendererUrl());
  app.name = 'Chrodis';
  app.setName('Chrodis');
  configureAboutPanel();
  setDockIcon();
  Menu.setApplicationMenu(buildMenu());
  const backendCommand = backendSpawn(project, port);
  backend = spawn(backendCommand.command, backendCommand.args, {
    cwd: backendCommand.cwd,
    env: backendCommand.env,
    stdio: 'inherit'
  });
  backend.on('exit', code => {
    if (!quitting && code !== 0) app.quit();
  });
  const projectName = project.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.chrodis(?:\.json)?$/, '') || 'Project';
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: `Chrodis - ${projectName}`,
    icon: appIcon,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, 'preload.cjs')
    }
  });
  mainWindow = win;
  await win.loadURL(rendererUrl);
}

function sendCommand(command) {
  const target = BrowserWindow.getFocusedWindow() || mainWindow;
  target?.webContents.send('chrodis-menu-command', command);
}

function menuItem(label, command, accelerator) {
  return { label, accelerator, click: () => sendCommand(command) };
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Chrodis',
      submenu: [
        { label: '关于 Chrodis', click: () => app.showAboutPanel() },
        menuItem('偏好设置...', 'preferences', 'CommandOrControl+,'),
        { type: 'separator' },
        { role: 'hide', label: '隐藏 Chrodis' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 Chrodis' }
      ]
    },
    {
      label: '文件',
      submenu: [
        menuItem('新建工程', 'new-project', 'CommandOrControl+N'),
        menuItem('保存', 'save', 'CommandOrControl+S'),
        { type: 'separator' },
        menuItem('导出 MIDI', 'export-midi', 'CommandOrControl+E'),
        menuItem('导出 WAV', 'export-wav', 'CommandOrControl+Shift+E'),
        { type: 'separator' },
        { role: 'close', label: '关闭窗口', accelerator: 'CommandOrControl+W' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        menuItem('撤销', 'undo', 'CommandOrControl+Z'),
        menuItem('重做', 'redo', 'CommandOrControl+Shift+Z'),
        { type: 'separator' },
        menuItem('复制', 'copy', 'CommandOrControl+C'),
        menuItem('粘贴', 'paste', 'CommandOrControl+V'),
        menuItem('复制一份', 'duplicate', 'CommandOrControl+D'),
        menuItem('全选', 'select-all', 'CommandOrControl+A'),
        { type: 'separator' },
        menuItem('删除', 'delete', 'Delete')
      ]
    },
    {
      label: '显示',
      submenu: [
        menuItem('放大', 'zoom-in', 'CommandOrControl+='),
        menuItem('缩小', 'zoom-out', 'CommandOrControl+-'),
        menuItem('重置缩放', 'zoom-reset', 'CommandOrControl+0'),
        { type: 'separator' },
        menuItem('指针工具', 'tool-pointer'),
        menuItem('框选工具', 'tool-marquee'),
        menuItem('剪刀工具', 'tool-scissors'),
        { type: 'separator' },
        menuItem('钢琴卷帘停靠/浮动', 'toggle-editor-mode'),
        menuItem('关闭钢琴卷帘', 'close-editor')
      ]
    },
    {
      label: '轨道',
      submenu: [
        menuItem('添加乐器轨', 'add-instrument-track', 'CommandOrControl+Shift+T'),
        menuItem('添加音频轨', 'add-audio-track'),
        menuItem('重命名轨道', 'rename-track'),
        { type: 'separator' },
        menuItem('静音轨道', 'toggle-mute'),
        menuItem('独奏轨道', 'toggle-solo'),
        menuItem('录音待命', 'toggle-record-arm'),
        { type: 'separator' },
        menuItem('删除轨道', 'delete-track')
      ]
    },
    {
      label: '片段',
      submenu: [
        menuItem('添加 MIDI 片段', 'add-midi-clip'),
        menuItem('打开钢琴卷帘', 'open-piano-roll'),
        menuItem('切分', 'split-clip', 'CommandOrControl+T'),
        { type: 'separator' },
        menuItem('片段绿色', 'clip-color-green'),
        menuItem('片段蓝色', 'clip-color-blue'),
        { type: 'separator' },
        menuItem('删除片段', 'delete')
      ]
    },
    {
      label: '传输',
      submenu: [
        menuItem('播放/暂停', 'play-pause'),
        menuItem('停止', 'stop'),
        menuItem('录音', 'record', 'CommandOrControl+R'),
        { type: 'separator' },
        menuItem('生成 Demo', 'compose-demo')
      ]
    },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { role: 'front', label: '前置全部窗口' }] },
    { label: '帮助', submenu: [menuItem('Chrodis 帮助', 'help')] }
  ]);
}

function configureAboutPanel() {
  app.setAboutPanelOptions({
    applicationName: 'Chrodis',
    applicationVersion: '0.1.0',
    version: '0.1.0',
    iconPath: appIcon,
    copyright: 'Copyright © 2026 ForgeX'
  });
}

function setDockIcon() {
  if (!app.dock) return;
  const image = nativeImage.createFromPath(appIcon);
  if (!image.isEmpty()) app.dock.setIcon(image);
}

app.whenReady().then(main).catch(error => {
  console.error(error);
  app.quit();
});
function stopBackend() {
  quitting = true;
  if (backend) backend.kill();
}

app.on('before-quit', stopBackend);
app.on('window-all-closed', () => {
  stopBackend();
  app.quit();
});
process.on('SIGINT', () => {
  stopBackend();
  app.quit();
});
process.on('SIGTERM', () => {
  stopBackend();
  app.quit();
});
