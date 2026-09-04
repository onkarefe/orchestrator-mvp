import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertArtifactConsistency,
  validateArtifactConsistency,
} from './artifactConsistency.js';
import { createArtifactManifest } from './artifactManifest.js';
import { calculateSafeCrop, getImageMetadata } from './image.js';
import {
  createJobWorkspace,
  isPathInside,
} from './jobWorkspace.js';
import { buildWallpaperPanelFileName } from './factoryFileNames.js';
import { resolveMasterPath } from './masterResolver.js';
import { buildPanelPixelWidths, computePanelsFromOutputMm } from './panels.js';
import { createPanelPdfFile } from './pdf.js';
import { isValidCropRatio } from './validation.js';
import { createZipFromFileEntries } from './zip.js';
import {
  LINE_ITEM_CLASSIFICATIONS,
  LINE_ITEM_ROUTING_STATES,
} from '../constants/lineItemRouting.js';

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

async function persistValidatedFactoryFiles({ workspace, fileEntries }) {
  await fs.mkdir(workspace.factoryFilesDir, { recursive: true });

  const persistedEntries = [];

  for (const entry of fileEntries) {
    const fileName = String(entry?.name ?? '').trim();

    if (
      !fileName ||
      path.basename(fileName) !== fileName ||
      !workspace.factoryFilesDir ||
      !entry.filePath ||
      !path.isAbsolute(entry.filePath)
    ) {
      throw new Error('Factory upload source entry is invalid');
    }

    const sourcePath = path.resolve(entry.filePath);
    const destinationPath = path.resolve(workspace.factoryFilesDir, fileName);

    if (
      !isPathInside(sourcePath, workspace.workDir) ||
      !isPathInside(destinationPath, workspace.factoryFilesDir) ||
      !isPathInside(destinationPath, workspace.finalDir)
    ) {
      throw new Error('Factory upload source entry escaped job directories');
    }

    await fs.copyFile(
      sourcePath,
      destinationPath,
      fsConstants.COPYFILE_EXCL
    );
    persistedEntries.push({
      name: fileName,
      filePath: destinationPath,
    });
  }

  return persistedEntries;
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

function validateOrderLineItem(order, job, lineItem) {
  if (
    !lineItem ||
    String(lineItem.order_id) !== String(order?.id) ||
    String(lineItem.shopify_line_item_id) !==
      String(job?.shopify_line_item_id) ||
    lineItem.classification !== LINE_ITEM_CLASSIFICATIONS.WALLPAPER ||
    lineItem.routing_state !== LINE_ITEM_ROUTING_STATES.PRODUCTION_READY
  ) {
    throw new Error('A production-ready persisted wallpaper line item is required');
  }

  const sourcePosition = Number(lineItem.source_position);

  if (!Number.isSafeInteger(sourcePosition) || sourcePosition < 0) {
    throw new Error('Persisted wallpaper source position is invalid');
  }

  return sourcePosition;
}

export async function processJobToZip({ order, job, lineItem }) {
  const { widthMm, heightMm, cropRatio } = validateJob(job);
  const sourcePosition = validateOrderLineItem(order, job, lineItem);
  const shopifyOrderId = getShopifyOrderId(order);
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
    const panelFileName = buildWallpaperPanelFileName({
      shopifyOrderId,
      sourcePosition,
      panelNumber: index + 1,
    });
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

  const validationResult = await validateArtifactConsistency({
    xmlFileName: null,
    xmlFilePath: null,
    panelFiles,
    fileEntries,
    panelInfo,
    pageWidthMm,
    pageHeightMm: heightMm,
    xmlRequired: false,
  });

  assertArtifactConsistency(validationResult);

  await createZipFromFileEntries(workspace.workZipPath, fileEntries);
  await moveFileWithoutOverwrite(workspace.workZipPath, workspace.finalZipPath);
  const persistedFileEntries = await persistValidatedFactoryFiles({
    workspace,
    fileEntries,
  });
  const manifestResult = await createArtifactManifest({
    order,
    job,
    workspace,
    shopifyOrderId,
    zipFileName: workspace.zipFileName,
    zipPath: workspace.finalZipPath,
    panelFiles,
    panelInfo,
    xmlFileName: null,
    fileEntries: persistedFileEntries,
    widthMm,
    heightMm,
    cropRatio,
    validationResult,
  });
  return {
    zipPath: workspace.finalZipPath,
    zipFileName: workspace.zipFileName,
    zipChecksum: manifestResult.zipChecksum,
    zipSizeBytes: manifestResult.zipSizeBytes,
    manifestPath: manifestResult.manifestPath,
    manifest: manifestResult.manifest,
    validationResult,
    panelFiles,
    panelInfo,
    fileCount: persistedFileEntries.length,
    artifactDir: workspace.finalDir,
    factoryFilesDir: workspace.factoryFilesDir,
    xmlFileName: null,
    xmlPath: null,
    factoryFileEntries: persistedFileEntries,
    workDir: workspace.workDir,
    runId: workspace.runId,
  };
}

export default {
  processJobToZip,
};
