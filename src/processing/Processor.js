import fs from 'node:fs/promises';
import path from 'node:path';

import { artifactsDir, tmpDir } from '../config/paths.js';
import { calculateSafeCrop, getImageMetadata } from './image.js';
import { resolveMasterPath } from './masterResolver.js';
import { buildPanelPixelWidths, computePanelsFromOutputMm } from './panels.js';
import { createPanelPdfBuffer } from './pdf.js';
import { isValidCropRatio } from './validation.js';
import { buildOrderXml } from './xml.js';
import { createZipFromEntries } from './zip.js';

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

function requirePositiveNumber(value, fieldName) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`${fieldName} must be a positive finite number`);
  }

  return numberValue;
}

function validateJob(job) {
  if (!job?.id) {
    throw new Error('job.id is required');
  }

  if (!job.master_asset_id) {
    throw new Error('job.master_asset_id is required');
  }

  const widthMm = requirePositiveNumber(job.width_mm, 'job.width_mm');
  const heightMm = requirePositiveNumber(job.height_mm, 'job.height_mm');
  const cropRatio = parseJsonIfNeeded(job.crop_ratio_json);

  if (!isValidCropRatio(cropRatio)) {
    throw new Error('job.crop_ratio_json is invalid');
  }

  return {
    widthMm,
    heightMm,
    cropRatio,
  };
}

export async function processJobToZip({ order, job }) {
  const { widthMm, heightMm, cropRatio } = validateJob(job);
  const masterPath = resolveMasterPath(job.master_asset_id);
  const panelInfo = computePanelsFromOutputMm(widthMm);
  const metadata = await getImageMetadata(masterPath);
  const safeCrop = calculateSafeCrop(metadata, cropRatio);
  const panelPixelWidths = buildPanelPixelWidths(safeCrop.width, panelInfo.panelCount);
  const panelFiles = [];
  const entries = [];
  const pageWidthMm = widthMm / panelInfo.panelCount;
  let panelLeft = safeCrop.left;

  for (let index = 0; index < panelPixelWidths.length; index += 1) {
    const panelFileName = `panel-${index + 1}.pdf`;
    const panelCrop = {
      left: panelLeft,
      top: safeCrop.top,
      width: panelPixelWidths[index],
      height: safeCrop.height,
    };
    const panelBuffer = await createPanelPdfBuffer({
      masterPath,
      crop: panelCrop,
      pageWidthMm,
      pageHeightMm: heightMm,
    });

    panelFiles.push(panelFileName);
    entries.push({
      name: panelFileName,
      buffer: panelBuffer,
    });

    panelLeft += panelPixelWidths[index];
  }

  const xmlBuffer = Buffer.from(
    buildOrderXml({
      order,
      job: {
        ...job,
        width_mm: widthMm,
        height_mm: heightMm,
      },
      panelInfo,
      panelFiles,
    }),
    'utf8'
  );
  const artifactDir = path.join(artifactsDir, `job-${job.id}`);
  const zipFileName = `job-${job.id}.zip`;
  const zipPath = path.join(artifactDir, zipFileName);

  entries.unshift({
    name: 'order.xml',
    buffer: xmlBuffer,
  });

  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(artifactDir, { recursive: true });
  await createZipFromEntries(zipPath, entries);

  return {
    zipPath,
    zipFileName,
    panelFiles,
    panelInfo,
    artifactDir,
  };
}

export default {
  processJobToZip,
};
