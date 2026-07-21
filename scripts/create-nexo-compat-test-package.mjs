import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { rootDir, tmpDir } from '../src/config/paths.js';
import { JOB_STATUSES } from '../src/constants/statuses.js';
import pool from '../src/db/connection.js';
import { listArtifacts } from '../src/models/ArtifactModel.js';
import { findJobById } from '../src/models/JobModel.js';
import { findOrderById } from '../src/models/OrderModel.js';
import { isPathInside, sanitizePathSegment } from '../src/processing/jobWorkspace.js';
import { xmlEscape } from '../src/processing/xml.js';
import { buildFactoryReference } from '../src/utils/factoryReference.js';

const DEFAULT_SKU = '1.14-1.3.10';
const ARTIFACT_PAGE_SIZE = 100;

function usageError(message) {
  return new Error(
    `${message}\nUsage: node scripts/create-nexo-compat-test-package.mjs --job-id=28`
  );
}

function parseJobId(args) {
  let jobId = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument.startsWith('--job-id=')) {
      if (jobId !== null) {
        throw usageError('--job-id may only be provided once');
      }

      jobId = argument.slice('--job-id='.length);
      continue;
    }

    if (argument === '--job-id') {
      if (jobId !== null) {
        throw usageError('--job-id may only be provided once');
      }

      index += 1;
      jobId = args[index] ?? '';
      continue;
    }

    throw usageError(`Unknown argument: ${argument}`);
  }

  if (!/^[1-9][0-9]*$/.test(jobId ?? '')) {
    throw usageError('--job-id must be a positive integer');
  }

  return jobId;
}

async function findLatestPassedArtifact(jobId) {
  let offset = 0;

  while (true) {
    const artifacts = await listArtifacts({
      jobId,
      limit: ARTIFACT_PAGE_SIZE,
      offset,
    });
    const passedArtifact = artifacts.find(
      (artifact) => artifact.validation_status === 'passed'
    );

    if (passedArtifact) {
      return passedArtifact;
    }

    if (artifacts.length < ARTIFACT_PAGE_SIZE) {
      return null;
    }

    offset += ARTIFACT_PAGE_SIZE;
  }
}

function resolveStoredPath(storedPath, label) {
  const normalizedPath = String(storedPath ?? '').trim();

  if (!normalizedPath) {
    throw new Error(`${label} is missing`);
  }

  return path.isAbsolute(normalizedPath)
    ? path.normalize(normalizedPath)
    : path.resolve(rootDir, normalizedPath);
}

async function readManifest(manifestPath) {
  let contents;

  try {
    contents = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    throw new Error(`Artifact manifest cannot be read: ${manifestPath}`, {
      cause: error,
    });
  }

  try {
    const manifest = JSON.parse(contents);

    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('manifest root must be an object');
    }

    return manifest;
  } catch (error) {
    throw new Error(`Artifact manifest is not valid JSON: ${manifestPath}`, {
      cause: error,
    });
  }
}

function getFileName(entry) {
  if (typeof entry === 'string') {
    return path.basename(entry);
  }

  const fileName = entry?.name ?? entry?.file_name ?? entry?.fileName;

  return fileName ? String(fileName) : null;
}

function isPdfFileName(fileName) {
  return typeof fileName === 'string' && /\.pdf$/i.test(fileName);
}

function findFirstPdf(manifest) {
  const files = Array.isArray(manifest?.contents?.files)
    ? manifest.contents.files
    : [];
  const pdfEntry = files.find((entry) => isPdfFileName(getFileName(entry)));

  if (!pdfEntry) {
    throw new Error('No PDF entry was found in the artifact manifest');
  }

  const fileName = getFileName(pdfEntry);
  const panels = Array.isArray(manifest?.contents?.panels)
    ? manifest.contents.panels
    : [];
  const panel =
    panels.find((candidate) => getFileName(candidate) === fileName) ??
    panels.find((candidate) => isPdfFileName(getFileName(candidate))) ??
    null;

  return {
    entry: pdfEntry,
    fileName,
    panel,
  };
}

function positiveNumber(value) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function firstMeasurement(candidates) {
  for (const { value, multiplier = 1 } of candidates) {
    const parsed = positiveNumber(value);

    if (parsed !== null) {
      return parsed * multiplier;
    }
  }

  return null;
}

function axisMeasurementMm(value, axis) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const capitalizedAxis = `${axis[0].toUpperCase()}${axis.slice(1)}`;
  const unit = String(value.unit ?? value[`${axis}_unit`] ?? '').toLowerCase();
  const rawValue = value[axis] ?? value[`${axis}Value`];

  return firstMeasurement([
    { value: value[`${axis}_mm`] },
    { value: value[`${axis}Mm`] },
    { value: value[`panel_${axis}_mm`] },
    { value: value[`panel${capitalizedAxis}Mm`] },
    { value: value[`${axis}_cm`], multiplier: 10 },
    { value: value[`${axis}Cm`], multiplier: 10 },
    { value: value[`panel_${axis}_cm`], multiplier: 10 },
    { value: value[`panel${capitalizedAxis}Cm`], multiplier: 10 },
    { value: unit === 'mm' ? rawValue : null },
    { value: unit === 'cm' ? rawValue : null, multiplier: 10 },
  ]);
}

function panelMeasurementMm(value, axis) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const capitalizedAxis = `${axis[0].toUpperCase()}${axis.slice(1)}`;

  return firstMeasurement([
    { value: value[`panel_${axis}_mm`] },
    { value: value[`panel${capitalizedAxis}Mm`] },
    { value: value[`panel_${axis}_cm`], multiplier: 10 },
    { value: value[`panel${capitalizedAxis}Cm`], multiplier: 10 },
  ]);
}

function resolvePanelDimensions(manifest, selectedPdf) {
  const panel = selectedPdf.panel;
  const entry = selectedPdf.entry;
  const contents = manifest?.contents ?? {};
  const manifestDimensions = manifest?.dimensions ?? {};
  const jobDimensions = manifest?.job ?? {};
  const widthMm = firstMeasurement([
    { value: axisMeasurementMm(panel, 'width') },
    { value: axisMeasurementMm(panel?.dimensions, 'width') },
    { value: axisMeasurementMm(entry, 'width') },
    { value: axisMeasurementMm(entry?.dimensions, 'width') },
    { value: panelMeasurementMm(contents, 'width') },
    { value: panelMeasurementMm(contents?.dimensions, 'width') },
    { value: panelMeasurementMm(manifestDimensions, 'width') },
  ]);
  const heightMm = firstMeasurement([
    { value: axisMeasurementMm(panel, 'height') },
    { value: axisMeasurementMm(panel?.dimensions, 'height') },
    { value: axisMeasurementMm(entry, 'height') },
    { value: axisMeasurementMm(entry?.dimensions, 'height') },
    { value: panelMeasurementMm(contents, 'height') },
    { value: panelMeasurementMm(contents?.dimensions, 'height') },
    { value: panelMeasurementMm(manifestDimensions, 'height') },
    { value: jobDimensions.output_height_mm },
    { value: jobDimensions.outputHeightMm },
    { value: jobDimensions.output_height_cm, multiplier: 10 },
    { value: jobDimensions.outputHeightCm, multiplier: 10 },
    { value: manifestDimensions.total_height_mm },
    { value: manifestDimensions.totalHeightMm },
    { value: manifestDimensions.total_height_cm, multiplier: 10 },
    { value: manifestDimensions.totalHeightCm, multiplier: 10 },
  ]);

  if (widthMm === null || heightMm === null) {
    throw new Error(
      `Selected panel dimensions could not be resolved from the artifact manifest: ${selectedPdf.fileName}`
    );
  }

  return { widthMm, heightMm };
}

async function resolvePdfSourcePath(selectedPdf) {
  const sourcePath =
    selectedPdf.entry?.source_path ??
    selectedPdf.entry?.sourcePath ??
    selectedPdf.entry?.file_path ??
    selectedPdf.entry?.filePath ??
    selectedPdf.panel?.source_path ??
    selectedPdf.panel?.sourcePath ??
    null;

  if (!sourcePath) {
    throw new Error(
      `The first PDF entry has no source path in the artifact manifest: ${selectedPdf.fileName}`
    );
  }

  const resolvedPath = resolveStoredPath(sourcePath, 'PDF source path');
  let stat;

  try {
    stat = await fs.stat(resolvedPath);
  } catch (error) {
    throw new Error(`PDF source file cannot be found: ${resolvedPath}`, {
      cause: error,
    });
  }

  if (!stat.isFile()) {
    throw new Error(`PDF source path is not a file: ${resolvedPath}`);
  }

  return resolvedPath;
}

function formatMm(value) {
  const rounded = Number(Number(value).toFixed(3));

  return String(rounded);
}

function buildCompatXml({ factoryReference, pdfFileName, sku, widthMm, heightMm }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <order>
    <order_number>${xmlEscape(factoryReference)}</order_number>
    <reference>${xmlEscape(factoryReference)}</reference>
    <shipping_type>Standard</shipping_type>
    <shipping_from>
      <company>Werbeagentur XY GmbH</company>
      <contact_person></contact_person>
      <street>Musterstr. 4</street>
      <postcode>12345</postcode>
      <city>Musterstadt</city>
      <country>DE</country>
    </shipping_from>
    <shipping_to>
      <company>Musterkunde AG</company>
      <contact_person>Martina Musterfrau</contact_person>
      <street>Testweg 45</street>
      <postcode>54321</postcode>
      <city>Testhausen</city>
      <country>DE</country>
      <phone>01234-567890</phone>
    </shipping_to>
  </order>
  <positions>
    <position>
      <sku>${xmlEscape(sku)}</sku>
      <width unit="mm">${xmlEscape(formatMm(widthMm))}</width>
      <height unit="mm">${xmlEscape(formatMm(heightMm))}</height>
      <variants>1</variants>
      <copies_per_variant>1</copies_per_variant>
      <files>
        <file type="ftp">${xmlEscape(pdfFileName)}</file>
      </files>
    </position>
  </positions>
</root>`;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writePackage({ outputDir, xmlFileName, pdfFileName, xml, pdfSourcePath }) {
  const outputRoot = path.dirname(outputDir);

  if (!isPathInside(outputDir, outputRoot) || outputDir === outputRoot) {
    throw new Error('NEXO compatibility output path escaped its dedicated directory');
  }

  await fs.mkdir(outputRoot, { recursive: true });

  if (await pathExists(outputDir)) {
    throw new Error(
      `NEXO compatibility output folder already exists; remove it explicitly before regenerating: ${outputDir}`
    );
  }

  let stagingDir = await fs.mkdtemp(path.join(outputRoot, '.package-'));

  try {
    await fs.copyFile(
      pdfSourcePath,
      path.join(stagingDir, pdfFileName),
      fsConstants.COPYFILE_EXCL
    );
    await fs.writeFile(path.join(stagingDir, xmlFileName), `${xml}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.rename(stagingDir, outputDir);
    stagingDir = null;
  } finally {
    if (stagingDir) {
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  }
}

async function createNexoCompatTestPackage(jobId) {
  const job = await findJobById(jobId);

  if (!job) {
    throw new Error(`Job does not exist: ${jobId}`);
  }

  if (job.status !== JOB_STATUSES.COMPLETED) {
    throw new Error(
      `Job ${job.id} is not completed (status=${job.status ?? 'null'})`
    );
  }

  if (job.order_id === null || job.order_id === undefined) {
    throw new Error(`Job ${job.id} has no related order id`);
  }

  const order = await findOrderById(job.order_id);

  if (!order) {
    throw new Error(`Related order does not exist for job ${job.id}: ${job.order_id}`);
  }

  const artifact = await findLatestPassedArtifact(job.id);

  if (!artifact) {
    throw new Error(
      `No artifact with validation_status=passed was found for job ${job.id}`
    );
  }

  if (artifact.validation_status !== 'passed') {
    throw new Error(
      `Artifact ${artifact.id} validation_status is not passed: ${artifact.validation_status ?? 'null'}`
    );
  }

  const manifestPath = resolveStoredPath(
    artifact.manifest_path,
    `Artifact ${artifact.id} manifest path`
  );
  const manifest = await readManifest(manifestPath);

  if (
    manifest?.job?.id !== null &&
    manifest?.job?.id !== undefined &&
    String(manifest.job.id) !== String(job.id)
  ) {
    throw new Error(
      `Artifact manifest job id does not match requested job ${job.id}: ${manifest.job.id}`
    );
  }

  const selectedPdf = findFirstPdf(manifest);
  const pdfSourcePath = await resolvePdfSourcePath(selectedPdf);
  const { widthMm, heightMm } = resolvePanelDimensions(manifest, selectedPdf);
  const orderShopifyId = String(order.shopify_order_id ?? '').trim();
  const jobShopifyId = String(job.shopify_order_id ?? '').trim();

  if (orderShopifyId && jobShopifyId && orderShopifyId !== jobShopifyId) {
    throw new Error(
      `Order and job Shopify order ids do not match: ${orderShopifyId} != ${jobShopifyId}`
    );
  }

  const shopifyOrderId = orderShopifyId || jobShopifyId;

  if (!shopifyOrderId) {
    throw new Error(`Shopify order id is missing for job ${job.id}`);
  }

  const factoryReference = buildFactoryReference({
    shopifyOrderId,
    jobId: job.id,
  });
  const storedFactoryReference = String(job.factory_reference ?? '').trim();

  if (storedFactoryReference && storedFactoryReference !== factoryReference) {
    throw new Error(
      `Stored factory reference does not match the stable reference: ${storedFactoryReference} != ${factoryReference}`
    );
  }

  const safeJobId = sanitizePathSegment(job.id, 'unknown-job');
  const outputRoot = path.join(tmpDir, 'nexo-compat-test');
  const outputDir = path.join(outputRoot, `job-${safeJobId}`);
  const xmlFileName = `${factoryReference}.xml`;
  const pdfFileName = `${factoryReference}.pdf`;
  const sku = String(process.env.NEXO_COMPAT_TEST_SKU ?? '').trim() || DEFAULT_SKU;
  const xml = buildCompatXml({
    factoryReference,
    pdfFileName,
    sku,
    widthMm,
    heightMm,
  });

  await writePackage({
    outputDir,
    xmlFileName,
    pdfFileName,
    xml,
    pdfSourcePath,
  });

  return {
    jobId: job.id,
    orderId: order.id,
    shopifyOrderId,
    factoryReference,
    outputDir,
    xmlFileName,
    pdfFileName,
    widthMm,
    heightMm,
    sku,
  };
}

function printSummary(summary) {
  console.log('NEXO compatibility test package created');
  console.log(`Job id: ${summary.jobId}`);
  console.log(`Order id: ${summary.orderId}`);
  console.log(`Shopify order id: ${summary.shopifyOrderId}`);
  console.log(`Factory reference: ${summary.factoryReference}`);
  console.log(`Output folder: ${summary.outputDir}`);
  console.log(`XML filename: ${summary.xmlFileName}`);
  console.log(`PDF filename: ${summary.pdfFileName}`);
  console.log(`Width mm: ${formatMm(summary.widthMm)}`);
  console.log(`Height mm: ${formatMm(summary.heightMm)}`);
  console.log(`SKU used: ${summary.sku}`);
}

try {
  const jobId = parseJobId(process.argv.slice(2));
  const summary = await createNexoCompatTestPackage(jobId);

  printSummary(summary);
} catch (error) {
  console.error(
    `NEXO compatibility test package failed: ${error?.message ?? String(error)}`
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
