import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { calculateSafeCrop, getImageMetadata } from './image.js';
import { createJobWorkspace, sanitizePathSegment } from './jobWorkspace.js';
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

function getShopifyOrderId(order) {
  const rawPayload = parseJsonIfNeeded(order?.raw_payload_json);
  const shopifyOrderId = rawPayload?.id ?? order?.shopify_order_id;

  if (
    shopifyOrderId === null ||
    shopifyOrderId === undefined ||
    shopifyOrderId === ''
  ) {
    throw new Error('Shopify order id is required');
  }

  return String(shopifyOrderId);
}

async function moveFileWithoutOverwrite(sourcePath, destinationPath) {
  try {
    await fs.copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Artifact already exists: ${destinationPath}`);
    }

    throw error;
  }

  await fs.unlink(sourcePath);
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
  const shopifyOrderId = getShopifyOrderId(order);
  const safeShopifyOrderId = sanitizePathSegment(
    shopifyOrderId,
    'shopify-order'
  );
  const masterPath = resolveMasterPath(job.master_asset_id);
  const panelInfo = computePanelsFromOutputMm(widthMm);
  const metadata = await getImageMetadata(masterPath);
  const safeCrop = calculateSafeCrop(metadata, cropRatio);
  const panelPixelWidths = buildPanelPixelWidths(safeCrop.width, panelInfo.panelCount);
  const panelFiles = [];
  const fileEntries = [];
  const pageWidthMm = panelInfo.panelWidthCm * 10;
  const workspace = await createJobWorkspace({
    orderId: order.id,
    jobId: job.id,
    shopifyOrderId,
    attemptCount: job.attempt_count,
  });
  let panelLeft = safeCrop.left;

  for (let index = 0; index < panelPixelWidths.length; index += 1) {
    const panelNumber = String(index + 1).padStart(2, '0');
    const panelFileName = `w-${safeShopifyOrderId}-${panelNumber}.pdf`;
    const tempPanelPath = path.join(workspace.panelsDir, panelFileName);
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

    panelFiles.push({
      fileName: panelFileName,
      widthMm: pageWidthMm,
      heightMm,
    });

    fileEntries.push({
      name: panelFileName,
      filePath: tempPanelPath,
    });

    panelLeft += panelPixelWidths[index];
  }

  const xmlFileName = `w-${safeShopifyOrderId}.xml`;
  const xmlTempPath = path.join(workspace.workDir, xmlFileName);

  await fs.writeFile(
    xmlTempPath,
    buildOrderXml({
      order,
      job: {
        ...job,
        width_mm: widthMm,
        height_mm: heightMm,
      },
      shopifyOrderId,
      panelFiles,
    }),
    'utf8'
  );

  fileEntries.unshift({
    name: xmlFileName,
    filePath: xmlTempPath,
  });

  await createZipFromFileEntries(workspace.workZipPath, fileEntries);
  await moveFileWithoutOverwrite(workspace.workZipPath, workspace.finalZipPath);

  return {
    zipPath: workspace.finalZipPath,
    zipFileName: workspace.zipFileName,
    panelFiles,
    panelInfo,
    artifactDir: workspace.finalDir,
    workDir: workspace.workDir,
    runId: workspace.runId,
  };
}

export default {
  processJobToZip,
};
