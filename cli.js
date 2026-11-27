#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const HOME = os.homedir();

function expandPath(p) {
  if (!p) return '';
  const raw = String(p)
    .replace(/^~(?=$|[\\/])/, HOME)
    .replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? '');
  return path.resolve(raw);
}

function getAppDir() {
  return process.env.SWAPHAT_HOME ? expandPath(process.env.SWAPHAT_HOME) : path.join(HOME, '.swaphat');
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];

  if (cmd === 'install' || cmd === 'uninstall' || cmd === '--uninstall') {
    const installerPath = path.join(__dirname, 'install.js');
    try {
      const installer = require(installerPath);
      if (typeof installer.main !== 'function') {
        throw new Error('install.js does not export main()');
      }
      installer.main(argv);
    } catch (e) {
      console.error(`swaphat: ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const appDir = getAppDir();
  const swapScript = path.join(appDir, 'swap.js');

  let hasSwap = false;
  try {
    hasSwap = fs.statSync(swapScript).isFile();
  } catch {
    hasSwap = false;
  }

  if (!hasSwap) {
    console.error('swaphat is not installed yet. Run: swaphat uninstall / swaphat install or check SWAPHAT_HOME.');
    process.exitCode = 1;
    return;
  }

  const res = cp.spawnSync(process.execPath, [swapScript, ...argv], {
    stdio: 'inherit',
    windowsHide: true,
  });

  if (res.error) {
    console.error(`swaphat: failed to run ${swapScript}: ${res.error.message}`);
    process.exitCode = 1;
    return;
  }

  if (typeof res.status === 'number') {
    process.exitCode = res.status;
  } else if (res.signal) {
    process.exitCode = 1;
  } else {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, getAppDir, expandPath };
