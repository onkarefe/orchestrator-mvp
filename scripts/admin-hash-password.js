#!/usr/bin/env node

import readline from 'node:readline';

import {
  hashAdminPassword,
  validateAdminPasswordStrength,
} from '../src/utils/adminPasswordHash.js';

function readHiddenLine(promptText) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Password prompt requires an interactive terminal.'));
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      historySize: 0,
      terminal: true,
    });

    rl.stdoutMuted = false;
    rl._writeToOutput = function writeToOutput(value) {
      if (!rl.stdoutMuted) {
        rl.output.write(value);
      }
    };

    rl.on('SIGINT', () => {
      rl.close();
      process.stderr.write('\n');
      reject(new Error('Password prompt cancelled.'));
    });

    rl.question(promptText, (answer) => {
      rl.history = [];
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });

    rl.stdoutMuted = true;
  });
}

try {
  if (process.argv.length > 2) {
    process.stderr.write(
      'This command prompts interactively; do not pass passwords as arguments.\n'
    );
    process.exitCode = 1;
  } else {
    const password = await readHiddenLine('Admin password: ');
    const validation = validateAdminPasswordStrength(password);

    if (!validation.ok) {
      process.stderr.write(`${validation.reason}\n`);
      process.exitCode = 1;
    } else {
      const passwordHash = await hashAdminPassword(password);
      process.stdout.write(`${passwordHash}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
