import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { artifactsDir } from '../config/paths.js';
import { JOB_STATUSES } from '../constants/statuses.js';
import { calculateFileSha256 } from './artifactManifest.js';
import {
  buildOrderFactoryIdentity,
  buildWallpaperPanelFileName,
} from './factoryFileNames.js';
import { isPathInside, sanitizePathSegment } from './jobWorkspace.js';
import { buildOrderXml } from './xml.js';
import { evaluateFactoryDispatchGate } from '../services/FactoryDispatchGateService.js';

export const ORDER_FACTORY_PACKAGE_SCHEMA =
  'wandini.order-factory-package.v1';

function blocked(reason, details = {}) {
  return { ready: false, reason, details };
}

function normalizeIdentity(value) {
  return value === null || value === undefined || String(value).trim() === ''
    ? null
    : String(value).trim();
}

function assertSafePdfName(value) {
  const fileName = String(value ?? '').trim();

  if (
    !fileName ||
    path.basename(fileName) !== fileName ||
    !fileName.toLowerCase().endsWith('.pdf')
  ) {
    throw new Error('render_panel_file_name_invalid');
  }

  return fileName;
}

async function readRenderPosition({
  order,
  lineItem,
  job,
  artifact,
  artifactsRoot,
}) {
  const manifestPath = path.resolve(String(artifact.manifest_path ?? ''));

  if (!isPathInside(manifestPath, artifactsRoot)) {
    throw new Error('render_manifest_path_escaped');
  }

  const realManifestPath = await fs.realpath(manifestPath);
  const manifestStat = await fs.stat(realManifestPath);

  if (!manifestStat.isFile() || !isPathInside(realManifestPath, artifactsRoot)) {
    throw new Error('render_manifest_missing');
  }

  let manifest;

  try {
    manifest = JSON.parse(await fs.readFile(realManifestPath, 'utf8'));
  } catch {
    throw new Error('render_manifest_invalid_json');
  }

  if (
    String(manifest?.order?.id) !== String(order.id) ||
    String(manifest?.job?.id) !== String(job.id) ||
    normalizeIdentity(manifest?.job?.shopify_line_item_id) !==
      normalizeIdentity(lineItem.shopify_line_item_id) ||
    manifest?.validation?.ok !== true ||
    manifest?.validation?.validationStatus !== 'passed'
  ) {
    throw new Error('render_manifest_identity_or_validation_mismatch');
  }

  const panels = Array.isArray(manifest?.contents?.panels)
    ? manifest.contents.panels
    : [];
  const entries = Array.isArray(manifest?.contents?.files)
    ? manifest.contents.files
    : [];

  if (
    panels.length === 0 ||
    Number(manifest?.contents?.panel_count) !== panels.length ||
    new Set(panels.map((panel) => String(panel?.file_name ?? ''))).size !==
      panels.length
  ) {
    throw new Error('render_panel_count_invalid');
  }

  const localRoot = path.dirname(realManifestPath);
  const panelFiles = [];

  for (const [index, panel] of panels.entries()) {
    const sourceName = assertSafePdfName(panel?.file_name);
    const matchingEntries = entries.filter(
      (entry) => String(entry?.name) === sourceName
    );

    if (matchingEntries.length !== 1) {
      throw new Error('render_panel_manifest_entry_invalid');
    }

    const candidatePath = path.resolve(
      path.isAbsolute(String(matchingEntries[0].source_path ?? ''))
        ? String(matchingEntries[0].source_path)
        : path.resolve(process.cwd(), String(matchingEntries[0].source_path ?? ''))
    );

    if (
      !isPathInside(candidatePath, localRoot) ||
      !isPathInside(candidatePath, artifactsRoot)
    ) {
      throw new Error('render_panel_path_escaped');
    }

    const sourcePath = await fs.realpath(candidatePath);
    const stat = await fs.stat(sourcePath);

    if (
      !stat.isFile() ||
      !isPathInside(sourcePath, localRoot) ||
      !isPathInside(sourcePath, artifactsRoot) ||
      path.basename(sourcePath) !== sourceName
    ) {
      throw new Error('render_panel_missing_or_unsafe');
    }

    const widthMm = Number(panel?.width_mm);
    const heightMm = Number(panel?.height_mm);

    if (
      !Number.isFinite(widthMm) ||
      widthMm <= 0 ||
      !Number.isFinite(heightMm) ||
      heightMm <= 0
    ) {
      throw new Error('render_panel_dimensions_invalid');
    }

    panelFiles.push({
      fileName: buildWallpaperPanelFileName({
        shopifyOrderId: order.shopify_order_id,
        sourcePosition: lineItem.source_position,
        panelNumber: index + 1,
      }),
      sourcePath,
      widthMm,
      heightMm,
    });
  }

  return {
    sourcePosition: Number(lineItem.source_position),
    shopifyLineItemId: String(lineItem.shopify_line_item_id),
    sku: String(lineItem.sku).trim(),
    quantity: Number(lineItem.quantity),
    jobId: job.id,
    artifactId: artifact.id,
    panelFiles,
  };
}

export async function inspectOrderFactoryReadiness({
  order,
  lineItems,
  jobs,
  artifacts,
  artifactsRoot = artifactsDir,
} = {}) {
  const dispatchGate = evaluateFactoryDispatchGate({ order, lineItems });

  if (!dispatchGate.allowed) {
    return blocked(dispatchGate.reason);
  }

  const safeJobs = Array.isArray(jobs) ? jobs : [];
  const safeArtifacts = Array.isArray(artifacts) ? artifacts : [];
  const positions = [];

  for (const lineItem of [...lineItems].sort(
    (left, right) => Number(left.source_position) - Number(right.source_position)
  )) {
    const lineItemId = normalizeIdentity(lineItem.shopify_line_item_id);
    const matchingJobs = safeJobs.filter(
      (job) => normalizeIdentity(job.shopify_line_item_id) === lineItemId
    );

    if (!lineItemId || matchingJobs.length !== 1) {
      return blocked('wallpaper_job_cardinality_invalid', {
        shopifyLineItemId: lineItemId,
        jobCount: matchingJobs.length,
      });
    }

    const job = matchingJobs[0];

    if (job.status !== JOB_STATUSES.COMPLETED) {
      return blocked('wallpaper_job_not_completed', {
        shopifyLineItemId: lineItemId,
        jobId: job.id,
        status: job.status,
      });
    }

    const lineSku = String(lineItem.sku ?? '').trim();
    const jobSku = String(job.sku ?? '').trim();
    const quantity = Number(lineItem.quantity);

    if (!lineSku || !jobSku || lineSku !== jobSku) {
      return blocked('wallpaper_job_sku_mismatch', {
        shopifyLineItemId: lineItemId,
        jobId: job.id,
      });
    }

    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return blocked('wallpaper_quantity_invalid', {
        shopifyLineItemId: lineItemId,
      });
    }

    const matchingArtifacts = safeArtifacts.filter(
      (artifact) =>
        String(artifact.job_id) === String(job.id) &&
        artifact.type === 'zip' &&
        artifact.validation_status === 'passed' &&
        artifact.status === 'available' &&
        path.resolve(String(artifact.manifest_path ?? '')) ===
          path.resolve(String(job.artifact_manifest_path ?? ''))
    );

    if (matchingArtifacts.length !== 1) {
      return blocked('wallpaper_render_artifact_cardinality_invalid', {
        shopifyLineItemId: lineItemId,
        jobId: job.id,
        artifactCount: matchingArtifacts.length,
      });
    }

    try {
      positions.push(
        await readRenderPosition({
          order,
          lineItem,
          job,
          artifact: matchingArtifacts[0],
          artifactsRoot,
        })
      );
    } catch (error) {
      const errorMessage = String(error?.message ?? '');
      const safeReason = /^render_[a-z_]+$/.test(errorMessage)
        ? errorMessage
        : 'wallpaper_render_artifact_invalid';

      return blocked(safeReason, {
        shopifyLineItemId: lineItemId,
        jobId: job.id,
      });
    }
  }

  if (safeJobs.length !== lineItems.length) {
    return blocked('order_wallpaper_job_count_mismatch', {
      expected: lineItems.length,
      actual: safeJobs.length,
    });
  }

  const fileNames = positions.flatMap((position) =>
    position.panelFiles.map((panel) => panel.fileName)
  );

  if (new Set(fileNames).size !== fileNames.length) {
    return blocked('duplicate_factory_pdf_filename');
  }

  return { ready: true, reason: null, positions };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function assembleOrderFactoryPackage({
  order,
  positions,
  artifactsRoot = artifactsDir,
} = {}) {
  const safeOrderId = sanitizePathSegment(order?.id, 'unknown-order');
  const orderNumber = buildOrderFactoryIdentity(order?.shopify_order_id);
  const packageParent = path.resolve(
    artifactsRoot,
    'orders',
    `order-${safeOrderId}`,
    'factory-packages'
  );
  const finalDir = path.resolve(packageParent, orderNumber);

  if (
    !isPathInside(packageParent, artifactsRoot) ||
    !isPathInside(finalDir, packageParent)
  ) {
    throw new Error('order_factory_package_path_escaped');
  }

  await fs.mkdir(packageParent, { recursive: true });
  const realArtifactsRoot = await fs.realpath(artifactsRoot);
  const realPackageParent = await fs.realpath(packageParent);

  if (!isPathInside(realPackageParent, realArtifactsRoot)) {
    throw new Error('order_factory_package_real_path_escaped');
  }

  if (await pathExists(finalDir)) {
    throw new Error('order_factory_package_path_already_exists');
  }

  const stagingDir = await fs.mkdtemp(path.join(packageParent, '.staging-'));
  const xmlFileName = `${orderNumber}.xml`;
  const finalXmlPath = path.join(finalDir, xmlFileName);
  const finalManifestPath = path.join(finalDir, 'manifest.json');
  const manifestFiles = [];
  let totalSizeBytes = 0;

  try {
    for (const position of positions) {
      for (const panel of position.panelFiles) {
        const destinationPath = path.resolve(stagingDir, panel.fileName);

        if (!isPathInside(destinationPath, stagingDir)) {
          throw new Error('order_factory_pdf_path_escaped');
        }

        await fs.copyFile(
          panel.sourcePath,
          destinationPath,
          fsConstants.COPYFILE_EXCL
        );
        const checksum = await calculateFileSha256(destinationPath);
        const stat = await fs.stat(destinationPath);
        totalSizeBytes += stat.size;
        manifestFiles.push({
          name: panel.fileName,
          source_path: path.join(finalDir, panel.fileName),
          checksum_sha256: checksum,
          size_bytes: stat.size,
        });
      }
    }

    const xml = buildOrderXml({
      order,
      shopifyOrderId: order.shopify_order_id,
      positions: positions.map((position) => ({
        sku: position.sku,
        quantity: position.quantity,
        panelFiles: position.panelFiles,
      })),
    });
    const stagingXmlPath = path.join(stagingDir, xmlFileName);
    await fs.writeFile(stagingXmlPath, `${xml}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    const xmlChecksum = await calculateFileSha256(stagingXmlPath);
    const xmlStat = await fs.stat(stagingXmlPath);
    totalSizeBytes += xmlStat.size;
    manifestFiles.push({
      name: xmlFileName,
      source_path: finalXmlPath,
      checksum_sha256: xmlChecksum,
      size_bytes: xmlStat.size,
    });

    const contentChecksum = crypto
      .createHash('sha256')
      .update(
        manifestFiles
          .map((file) => `${file.name}:${file.checksum_sha256}`)
          .join('\n')
      )
      .digest('hex');
    const manifest = {
      schema: ORDER_FACTORY_PACKAGE_SCHEMA,
      version: 1,
      order: {
        id: order.id,
        shopify_order_id: String(order.shopify_order_id),
        order_number: orderNumber,
      },
      package: {
        content_checksum_sha256: contentChecksum,
      },
      contents: {
        file_count: manifestFiles.length,
        pdf_count: manifestFiles.length - 1,
        position_count: positions.length,
        xml_file_name: xmlFileName,
        files: manifestFiles,
        positions: positions.map((position) => ({
          source_position: position.sourcePosition,
          shopify_line_item_id: position.shopifyLineItemId,
          sku: position.sku,
          quantity: position.quantity,
          job_id: position.jobId,
          artifact_id: position.artifactId,
          panels: position.panelFiles.map((panel) => ({
            file_name: panel.fileName,
            width_mm: panel.widthMm,
            height_mm: panel.heightMm,
          })),
        })),
      },
      validation: { ok: true, validationStatus: 'passed' },
    };
    await fs.writeFile(
      path.join(stagingDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );
    await fs.rename(stagingDir, finalDir);

    return {
      orderNumber,
      packageDir: finalDir,
      manifestPath: finalManifestPath,
      xmlFileName,
      xmlPath: finalXmlPath,
      xmlChecksum,
      xmlSizeBytes: xmlStat.size,
      contentChecksum,
      fileCount: manifestFiles.length,
      totalSizeBytes,
      manifest,
    };
  } catch (error) {
    if (isPathInside(stagingDir, packageParent)) {
      await fs.rm(stagingDir, { recursive: true, force: true });
    }

    throw error;
  }
}

export async function removeAssembledOrderFactoryPackage(
  packageDir,
  artifactsRoot = artifactsDir
) {
  const resolvedPath = path.resolve(String(packageDir ?? ''));

  if (
    !isPathInside(resolvedPath, artifactsRoot) ||
    path.basename(path.dirname(resolvedPath)) !== 'factory-packages'
  ) {
    throw new Error('Refusing to remove an unsafe factory package path');
  }

  await fs.rm(resolvedPath, { recursive: true, force: true });
}

export default {
  ORDER_FACTORY_PACKAGE_SCHEMA,
  assembleOrderFactoryPackage,
  inspectOrderFactoryReadiness,
  removeAssembledOrderFactoryPackage,
};
