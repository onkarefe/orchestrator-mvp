import fs from 'node:fs';
import path from 'node:path';

import { mastersDir } from '../config/paths.js';

export function resolveMasterPath(masterAssetId) {
  if (!masterAssetId) {
    throw new Error('masterAssetId is required');
  }

  const basename = path.basename(String(masterAssetId));
  const candidates = [
    basename,
    `${basename}.png`,
    `${basename}.jpg`,
    `${basename}.jpeg`,
    `${basename}.webp`,
  ];

  for (const candidate of candidates) {
    const candidatePath = path.join(mastersDir, candidate);

    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  throw new Error(`Master asset not found: ${basename}`);
}

export default {
  resolveMasterPath,
};
