import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';
const viteBin = join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
const electronBin = join(appDir, 'node_modules', '.bin', isWindows ? 'electron.cmd' : 'electron');

let electronStarted = false;
let electronProcess = null;
let shuttingDown = false;

const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1'], {
  cwd: appDir,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe']
});

function startElectron(rendererUrl = 'http://127.0.0.1:5173/') {
  if (electronStarted) return;
  electronStarted = true;
  console.log(`Chrodis UI: ${rendererUrl}`);
  electronProcess = spawn(electronBin, ['.', ...process.argv.slice(2), '--renderer-url', rendererUrl], {
    cwd: appDir,
    stdio: 'inherit'
  });
  electronProcess.on('exit', code => {
    shutdown(code ?? 0);
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electronProcess && !electronProcess.killed) electronProcess.kill();
  if (!vite.killed) vite.kill();
  setTimeout(() => process.exit(code), 100);
}

vite.stdout.on('data', chunk => {
  const text = chunk.toString();
  const match = text.match(/http:\/\/127\.0\.0\.1:\d+\//);
  if (match) startElectron(match[0]);
  if (!match && !text.includes('VITE') && !text.includes('Local:') && text.trim()) {
    process.stdout.write(text);
  }
});

vite.stderr.on('data', chunk => {
  process.stderr.write(chunk);
});

vite.on('exit', code => {
  if (!electronStarted) process.exit(code ?? 1);
});

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
process.on('SIGHUP', () => shutdown(129));
process.on('exit', () => {
  if (electronProcess && !electronProcess.killed) electronProcess.kill();
  if (!vite.killed) vite.kill();
});

setTimeout(() => startElectron(), 2500);
