#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const argv = process.argv.slice(2);
if (argv[0] === 'install' || argv[0] === 'uninstall' || argv[0] === '--uninstall') {
  try { require('./install.js').main(argv); } catch (e) { console.error(`swaphat: ${e.message}`); process.exitCode = 1; }
} else {
  const app = process.env.SWAPHAT_HOME || path.join(os.homedir(), '.swaphat');
  const js = path.join(app, 'swap.js');
  if (!fs.existsSync(js)) {
    console.error('swaphat is not installed yet. Run: swaphat install');
    process.exitCode = 1;
  } else {
    process.exitCode = cp.spawnSync(process.execPath, [js, ...argv], { stdio: 'inherit' }).status ?? 1;
  }
}
