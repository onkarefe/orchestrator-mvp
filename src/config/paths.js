import path from 'node:path';
import { fileURLToPath } from 'node:url';

import env from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const rootDir = path.resolve(__dirname, '..', '..');
export const storageDir = path.join(rootDir, 'storage');
export const tmpDir = path.join(storageDir, 'tmp');
export const artifactsDir = path.join(storageDir, 'artifacts');
export const mastersDir = path.isAbsolute(env.MASTER_STORAGE_DIR)
  ? env.MASTER_STORAGE_DIR
  : path.resolve(rootDir, env.MASTER_STORAGE_DIR);

export default {
  rootDir,
  storageDir,
  tmpDir,
  artifactsDir,
  mastersDir,
};
