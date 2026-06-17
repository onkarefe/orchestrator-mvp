import fs from 'node:fs';
import path from 'node:path';

import { artifactsDir } from '../../config/paths.js';
import {
  findArtifactById,
  incrementDownloadCount,
} from '../../models/ArtifactModel.js';

export async function download(req, res, next) {
  try {
    const artifact = await findArtifactById(req.params.id);

    if (!artifact) {
      res.status(404).send('Artifact not found');
      return;
    }

    if (artifact.status !== 'available') {
      res.status(404).send('Artifact not available');
      return;
    }

    const resolvedFilePath = path.resolve(artifact.file_path);
    const resolvedArtifactsDir = path.resolve(artifactsDir);
    const isInsideArtifactsDir =
      resolvedFilePath === resolvedArtifactsDir ||
      resolvedFilePath.startsWith(`${resolvedArtifactsDir}${path.sep}`);

    if (!isInsideArtifactsDir) {
      res.status(403).send('Invalid artifact path');
      return;
    }

    if (!fs.existsSync(resolvedFilePath)) {
      res.status(404).send('Artifact file missing');
      return;
    }

    await incrementDownloadCount(artifact.id);

    res.download(
      resolvedFilePath,
      artifact.file_name || path.basename(resolvedFilePath)
    );
  } catch (error) {
    next(error);
  }
}

export default {
  download,
};
