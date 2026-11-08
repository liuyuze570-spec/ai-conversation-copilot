/**
 * Electron launcher.
 *
 * WorkBuddy (and other Electron hosts) export ELECTRON_RUN_AS_NODE=1, which
 * makes `electron .` boot as plain Node and crash on `app`. This launcher
 * strips that variable before spawning the real Electron binary.
 */
const { spawn } = require('node:child_process');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const args = process.argv.slice(2);
if (!args.length) args.push('.');

const child = spawn(electronPath, args, { stdio: 'inherit', env, windowsHide: false });

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (error) => {
  console.error('[launch] failed to start electron:', error.message);
  process.exit(1);
});
