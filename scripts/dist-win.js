/**
 * electron-builder wrapper for project paths containing non-ASCII characters.
 *
 * app-builder.exe (a Go binary) mangles non-ASCII paths and dies with
 * ERR_ELECTRON_BUILDER_CANNOT_EXECUTE. This script copies the project to an
 * ASCII-safe staging dir, builds there, then copies the artifacts back.
 */
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const staging = path.join(process.env.LOCALAPPDATA || path.join(__dirname, '..', '..'), 'ai-copilot-build');

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...options });
  // robocopy uses 0-7 as success codes
  if (result.status !== 0 && !(cmd === 'robocopy' && result.status < 8)) {
    console.error(`[dist] command failed: ${cmd} ${args.join(' ')} (exit ${result.status})`);
    process.exit(result.status || 1);
  }
}

/** robocopy exits 1 when files were copied — that is success. */
function robocopy(args) {
  const result = spawnSync('robocopy', args, { stdio: 'ignore' });
  if (result.status === null || result.status >= 8) {
    console.error(`[dist] robocopy failed (exit ${result.status})`);
    process.exit(result.status || 1);
  }
}

function cleanStaging() {
  if (!fs.existsSync(staging)) return;
  // Deleting node_modules recursively from Node trips bulk-delete guards in
  // some hosts; let the OS command do it.
  const result = spawnSync('cmd', ['/c', 'rd', '/s', '/q', staging], { stdio: 'ignore' });
  if (result.status !== 0 && fs.existsSync(staging)) {
    console.warn('[dist] could not reset staging dir, continuing with incremental copy');
  }
}

console.log(`[dist] staging: ${staging}`);
cleanStaging();
fs.mkdirSync(staging, { recursive: true });

console.log('[dist] copying project (robocopy /MIR)...');
// /XD with absolute paths: bare names would exclude EVERY dir called "dist",
// including dist/ folders inside node_modules packages.
robocopy([
  projectRoot,
  staging,
  '/MIR',
  '/XD',
  path.join(projectRoot, '.dev'),
  path.join(projectRoot, 'release'),
  path.join(projectRoot, '.workbuddy'),
  path.join(projectRoot, '.git'),
  path.join(projectRoot, 'dist'),
  '/NFL',
  '/NDL',
  '/NJH',
  '/NJS',
  '/NP',
  '/R:1',
  '/W:1',
]);

console.log('[dist] copying build outputs (dist)...');
robocopy([
  path.join(projectRoot, 'dist'),
  path.join(staging, 'dist'),
  '/MIR',
  '/NFL',
  '/NDL',
  '/NJH',
  '/NJS',
  '/NP',
]);

console.log('[dist] running electron-builder...');
const buildResult = spawnSync(
  process.execPath,
  [
    path.join(staging, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    '--win',
    '--x64',
  ],
  {
    cwd: staging,
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  },
);

const setupExe = path.join(staging, 'release', `AI-Conversation-Copilot-Setup-${require(path.join(staging, 'package.json')).version}.exe`);
const unpackedExe = path.join(staging, 'release', 'win-unpacked');
const hasArtifacts =
  fs.existsSync(setupExe) ||
  (fs.existsSync(unpackedExe) && fs.readdirSync(unpackedExe).some((f) => f.endsWith('.exe')));

if (buildResult.status !== 0 && !hasArtifacts) {
  console.error('[dist] electron-builder failed without artifacts');
  process.exit(buildResult.status || 1);
}
if (buildResult.status !== 0 && hasArtifacts) {
  console.warn('[dist] electron-builder exited non-zero but artifacts exist (cleanup-only failure); continuing');
}

const releaseSrc = path.join(staging, 'release');
const releaseDest = path.join(projectRoot, 'release');
console.log('[dist] copying artifacts back...');
robocopy([releaseSrc, releaseDest, '/E', '/XF', 'builder-debug.yml', '/NFL', '/NDL', '/NJH', '/NJS', '/NP']);

console.log(`[dist] done. Artifacts: ${releaseDest}`);
