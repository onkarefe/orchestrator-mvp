import fs from 'node:fs/promises';
import path from 'node:path';

import { artifactsDir, tmpDir } from '../config/paths.js';
import { calculateSafeCrop, getImageMetadata } from './image.js';
import { resolveMasterPath } from './masterResolver.js';
import { buildPanelPixelWidths, computePanelsFromOutputMm } from './panels.js';
import { createPanelPdfFile } from './pdf.js';
import { isValidCropRatio } from './validation.js';
import { buildOrderXml } from './xml.js';
import { createZipFromFileEntries } from './zip.js';

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
  const fileEntries = [];
  const pageWidthMm = widthMm / panelInfo.panelCount;
  const tempJobDir = path.join(tmpDir, `job-${job.id}`);
  const artifactDir = path.join(artifactsDir, `job-${job.id}`);
  const zipFileName = `job-${job.id}.zip`;
  const zipPath = path.join(artifactDir, zipFileName);
  let panelLeft = safeCrop.left;

  await fs.mkdir(tempJobDir, { recursive: true });

  for (let index = 0; index < panelPixelWidths.length; index += 1) {
    const panelFileName = `panel-${index + 1}.pdf`;
    const tempPanelPath = path.join(tempJobDir, panelFileName);
    const panelCrop = {
      left: panelLeft,
      top: safeCrop.top,
      width: panelPixelWidths[index],
      height: safeCrop.height,
    };

    await createPanelPdfFile({
      masterPath,
      crop: panelCrop,
      pageWidthMm,
      pageHeightMm: heightMm,
      outputPath: tempPanelPath,
    });

    panelFiles.push(panelFileName);
    fileEntries.push({
      name: panelFileName,
      filePath: tempPanelPath,
    });

    panelLeft += panelPixelWidths[index];
  }

  const xmlTempPath = path.join(tempJobDir, 'order.xml');
  await fs.writeFile(
    xmlTempPath,
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

  fileEntries.unshift({
    name: 'order.xml',
    filePath: xmlTempPath,
  });

  await createZipFromFileEntries(zipPath, fileEntries);
  await fs.rm(tempJobDir, { recursive: true, force: true });

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
