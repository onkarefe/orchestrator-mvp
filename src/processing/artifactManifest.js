import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ARTIFACT_MANIFEST_SCHEMA = 'wandini.artifact-manifest.v1';
export const CHECKSUM_ALGORITHM = 'sha256';

function parseJsonIfNeeded(value) {
  if (value === null || value === undefined || typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function relativePathFromCwd(filePath) {
  return path.relative(process.cwd(), filePath) || path.basename(filePath);
}

export async function calculateFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(CHECKSUM_ALGORITHM);
    const stream = createReadStream(filePath);

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

export async function getFileSizeBytes(filePath) {
  const stat = await fs.stat(filePath);

  return stat.size;
}

export function buildArtifactManifest({
  order,
  job,
  workspace,
  shopifyOrderId,
  zipFileName,
  zipPath,
  zipChecksum,
  zipSizeBytes,
  panelFiles,
  panelInfo,
  xmlFileName,
  fileEntries,
  widthMm,
  heightMm,
  cropRatio,
  validationResult = null,
}) {
  return {
    schema: ARTIFACT_MANIFEST_SCHEMA,
    version: 1,
    generated_at: new Date().toISOString(),
    order: {
      id: order?.id ?? null,
      shopify_order_id: order?.shopify_order_id ?? shopifyOrderId ?? null,
      shopify_order_number: order?.shopify_order_number ?? null,
    },
    job: {
      id: job?.id ?? null,
      shopify_order_id: job?.shopify_order_id ?? shopifyOrderId ?? null,
      shopify_line_item_id: job?.shopify_line_item_id ?? null,
      source_master_asset_id: job?.master_asset_id ?? null,
      output_width_mm: widthMm,
      output_height_mm: heightMm,
      crop_ratio: parseJsonIfNeeded(cropRatio),
    },
    run: {
      run_id: workspace.runId,
      work_dir: workspace.workDir,
      final_dir: workspace.finalDir,
    },
    artifact: {
      zip_file_name: zipFileName,
      zip_path: zipPath,
      zip_relative_path: relativePathFromCwd(zipPath),
      checksum_algorithm: CHECKSUM_ALGORITHM,
      zip_checksum_sha256: zipChecksum,
      zip_size_bytes: zipSizeBytes,
      manifest_path: workspace.manifestPath,
      manifest_relative_path: relativePathFromCwd(workspace.manifestPath),
    },
    contents: {
      file_count: fileEntries.length,
      panel_count: panelInfo.panelCount,
      panel_width_cm: panelInfo.panelWidthCm,
      panels: panelFiles.map((panelFile) => ({
        file_name: panelFile.fileName,
        width_mm: panelFile.widthMm,
        height_mm: panelFile.heightMm,
      })),
      xml_file_name: xmlFileName,
      files: fileEntries.map((entry) => ({
        name: entry.name,
        source_path: entry.filePath,
      })),
    },
    validation: validationResult,
    app: {
      node_env: process.env.NODE_ENV ?? null,
    },
  };
}

export async function writeArtifactManifest(manifestPath, manifest) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );

  return manifestPath;
}

export async function createArtifactManifest(options) {
  const zipChecksum = await calculateFileSha256(options.zipPath);
  const zipSizeBytes = await getFileSizeBytes(options.zipPath);
  const manifest = buildArtifactManifest({
    ...options,
    zipChecksum,
    zipSizeBytes,
  });

  await writeArtifactManifest(options.workspace.manifestPath, manifest);

  return {
    manifest,
    manifestPath: options.workspace.manifestPath,
    zipChecksum,
    zipSizeBytes,
  };
}

export default {
  ARTIFACT_MANIFEST_SCHEMA,
  CHECKSUM_ALGORITHM,
  calculateFileSha256,
  getFileSizeBytes,
  buildArtifactManifest,
  writeArtifactManifest,
  createArtifactManifest,
};
