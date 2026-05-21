import { app, BrowserWindow, nativeImage } from 'electron';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let backend: ChildProcess | null = null;
const appIcon = path.join(__dirname, '../assets/chrodis-icon.iconset/icon_512x512@2x.png');

function parseArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function defaultRendererUrl(): string {
  if (app.isPackaged) return pathToFileURL(path.join(__dirname, '../dist/index.html')).toString();
  return 'http://127.0.0.1:5173/';
}

function defaultProjectPath(): string {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'projects', 'mandopop-3min.chrodis');
    if (existsSync(bundled)) return bundled;
  }
  return 'projects/mandopop-3min.chrodis';
}

function backendSpawn(project: string, port: string) {
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
    cwd: path.resolve('..'),
    env: { ...env, PYTHONPATH: 'src' }
  };
}

async function createWindow() {
  const project = parseArg('--project', defaultProjectPath());
  const port = parseArg('--port', '8765');
  const rendererUrl = parseArg('--renderer-url', defaultRendererUrl());
  app.name = 'Chrodis';
  app.setName('Chrodis');
  app.setAboutPanelOptions({
    applicationName: 'Chrodis',
    applicationVersion: '0.1.0',
    version: '0.1.0',
    iconPath: appIcon,
    copyright: 'Copyright © 2026 ForgeX'
  });
  setDockIcon();
  const backendCommand = backendSpawn(project, port);
  backend = spawn(backendCommand.command, backendCommand.args, {
    cwd: backendCommand.cwd,
    env: backendCommand.env,
    stdio: 'inherit'
  });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Chrodis',
    icon: appIcon,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });
  await win.loadURL(rendererUrl);
}

function setDockIcon() {
  if (!app.dock) return;
  const image = nativeImage.createFromPath(appIcon);
  if (!image.isEmpty()) app.dock.setIcon(image);
}

app.whenReady().then(createWindow).catch(error => {
  console.error(error);
  app.quit();
});
app.on('window-all-closed', () => {
  backend?.kill();
  app.quit();
});
