/**
 * Opens the app as a detached process so it survives after the launching
 * shell / agent turn ends, then reports where the window actually landed.
 *
 * Prefers the packaged build (no console window); falls back to running the
 * production build through the Electron launcher.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packaged = path.join(root, 'release', 'win-unpacked', 'AI Conversation Copilot.exe');
const launcher = path.join(root, 'scripts', 'start-electron.js');
const logFile = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'ai-conversation-copilot',
  'logs',
  'app.log',
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const hasPackaged = fs.existsSync(packaged);

/**
 * Snapshot the log size BEFORE spawning. Capturing it afterwards raced with
 * a fast cold start: the "overlay ready" line could already be on disk, the
 * poller then looked in the wrong slice and reported a scary (and false)
 * "未看到窗口就绪日志" while the window was in fact on screen.
 */
let baseline = 0;
try {
  baseline = fs.statSync(logFile).size;
} catch {
  /* log file may not exist yet */
}

if (hasPackaged) {
  spawn(packaged, [], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(packaged),
    env,
    windowsHide: false,
  }).unref();
  console.log('[open] 已启动打包版：release/win-unpacked/AI Conversation Copilot.exe');
} else {
  spawn(process.execPath, [launcher, '.'], {
    detached: true,
    stdio: 'ignore',
    cwd: root,
    env,
    windowsHide: false,
  }).unref();
  console.log('[open] 未找到打包产物，已改用生产构建启动（先 npm run build）');
}

/** Wait for the new "overlay ready" line so we can tell the user where it is. */
function waitForWindow(timeoutMs = 20000) {
  const started = Date.now();

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      let content = '';
      try {
        content = fs.readFileSync(logFile, 'utf8');
      } catch {
        return;
      }
      // Look slightly behind the baseline too, so lines written between
      // spawning and this first poll are never missed.
      const fresh = content.slice(Math.max(0, baseline - 4000));
      const line = fresh.split('\n').reverse().find((l) => l.includes('overlay ready at'));
      if (line) {
        clearInterval(timer);
        resolve(line.trim());
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        // Never claim "no window" when a stale-but-real line exists — that
        // message sent people hunting for a bug that was not there.
        const anywhere = content
          .split('\n')
          .reverse()
          .find((l) => l.includes('overlay ready at'));
        resolve(anywhere ? `(历史记录) ${anywhere.trim()}` : null);
      }
    }, 700);
  });
}

waitForWindow().then((line) => {
  if (line) {
    console.log('[open] ' + line.replace(/^\S+ \[INFO\] /, ''));
    console.log('[open] 窗口已显示。若仍看不到：点击系统托盘图标 →「显示 / 置前」。');
  } else {
    console.log('[open] 未看到窗口就绪日志，请查看日志：' + logFile);
  }
  process.exit(0);
});
