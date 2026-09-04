import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import env from '../config/env.js';
import {
  isFtpUploadOrderAllowlisted,
  isSupportedFtpProtocol,
  normalizeFtpRemoteDir,
  normalizeFtpTempSuffix,
  parseFtpUploadOrderAllowlist,
} from '../config/ftpUpload.js';
import { artifactsDir } from '../config/paths.js';
import {
  FACTORY_UPLOAD_TASK_STATUSES,
} from '../constants/statuses.js';
import { findArtifactById } from '../models/ArtifactModel.js';
import {
  claimFactoryUploadTaskById,
  claimNextFactoryUploadTask,
  findFactoryUploadTaskById,
  markFactoryUploadTaskDisposition,
  markFactoryUploadTaskFailed,
  markFactoryUploadTaskUploaded,
  releaseFactoryUploadTaskClaimToPending,
  releaseStaleFactoryUploadTaskClaims,
  requeueEligibleTemporarilySuppressedFactoryUploadTasks,
  requeueTemporarilySuppressedFactoryUploadTask,
  updateFactoryUploadTaskProgress,
} from '../models/FactoryUploadTaskModel.js';
import { findOrderById } from '../models/OrderModel.js';
import { findOrderFactoryPackageById } from '../models/OrderFactoryPackageModel.js';
import { listOrderLineItemsByOrderId } from '../models/OrderLineItemModel.js';
import { calculateFileSha256 } from '../processing/artifactManifest.js';
import { isPathInside } from '../processing/jobWorkspace.js';
import { ORDER_FACTORY_PACKAGE_SCHEMA } from '../processing/OrderFactoryPackageAssembler.js';
import {
  redactSensitiveText,
  safeErrorForLog,
} from '../utils/redact.js';
import FactoryFtpClient, { FactoryFtpError } from './FactoryFtpClient.js';
import { evaluateFactoryDispatchGate } from './FactoryDispatchGateService.js';
import { logError, logInfo, logWarning } from './LogService.js';

class FactoryUploadSafetyError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'FactoryUploadSafetyError';
    this.code = code;
    this.retryable = false;
  }
}

function assertSafeFileName(value, { extension } = {}) {
  const fileName = String(value ?? '').trim();

  if (
    !fileName ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('\0') ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    path.posix.basename(fileName) !== fileName ||
    path.win32.basename(fileName) !== fileName ||
    (extension && !fileName.toLowerCase().endsWith(extension))
  ) {
    throw new FactoryUploadSafetyError(
      'invalid_artifact_file_name',
      'Artifact filename is not a safe basename'
    );
  }

  return fileName;
}

function resolveManifestSourcePath(sourcePath, localRoot, artifactsRoot) {
  const candidate = String(sourcePath ?? '').trim();

  if (!candidate) {
    throw new FactoryUploadSafetyError(
      'artifact_source_path_missing',
      'Artifact manifest source path is missing'
    );
  }

  const resolvedPath = path.resolve(
    path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate)
  );

  if (
    !isPathInside(resolvedPath, localRoot) ||
    !isPathInside(resolvedPath, artifactsRoot)
  ) {
    throw new FactoryUploadSafetyError(
      'artifact_source_path_escaped',
      'Artifact source path escaped the job artifact directory'
    );
  }

  return resolvedPath;
}

async function assertLocalFile(filePath, missingCode, allowedRoots = []) {
  try {
    const realPath = await fs.realpath(filePath);
    const stat = await fs.stat(realPath);

    if (
      !stat.isFile() ||
      allowedRoots.some((root) => !isPathInside(realPath, root))
    ) {
      throw new FactoryUploadSafetyError(
        missingCode,
        'Required artifact path is not a safe file'
      );
    }

    return realPath;
  } catch (error) {
    if (error instanceof FactoryUploadSafetyError) {
      throw error;
    }

    throw new FactoryUploadSafetyError(
      missingCode,
      'Required artifact file is missing'
    );
  }
}

function decodeXmlText(value) {
  return String(value ?? '').replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (match, entity) => {
      const normalized = entity.toLowerCase();
      const named = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
      };

      if (named[normalized]) {
        return named[normalized];
      }

      const codePoint = normalized.startsWith('#x')
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);

      return Number.isSafeInteger(codePoint) &&
        codePoint >= 0 &&
        codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
  );
}

export function extractPdfFileNamesFromXml(xml) {
  const fileNames = [];
  const seen = new Set();
  const filePattern = /<file\b([^>]*)>([\s\S]*?)<\/file>/gi;
  let match;

  while ((match = filePattern.exec(String(xml ?? ''))) !== null) {
    const attributes = match[1];
    const typeMatch = attributes.match(
      /\btype\s*=\s*(?:"([^"]*)"|'([^']*)')/i
    );
    const type = String(typeMatch?.[1] ?? typeMatch?.[2] ?? '')
      .trim()
      .toLowerCase();

    if (type !== 'ftp') {
      continue;
    }

    const fileName = assertSafeFileName(decodeXmlText(match[2]).trim(), {
      extension: '.pdf',
    });

    if (seen.has(fileName)) {
      throw new FactoryUploadSafetyError(
        'duplicate_pdf_reference',
        'Production XML contains a duplicate PDF reference'
      );
    }

    seen.add(fileName);
    fileNames.push(fileName);
  }

  if (fileNames.length === 0) {
    throw new FactoryUploadSafetyError(
      'xml_pdf_references_missing',
      'Production XML does not reference any FTP PDF files'
    );
  }

  return fileNames;
}

export async function resolveFactoryUploadFiles({
  artifact,
  orderPackage,
  artifactsRoot = artifactsDir,
} = {}) {
  if (!artifact?.manifest_path) {
    throw new FactoryUploadSafetyError(
      'artifact_manifest_missing',
      'Artifact manifest is required for factory upload'
    );
  }

  let manifestPath = path.resolve(artifact.manifest_path);

  if (!isPathInside(manifestPath, artifactsRoot)) {
    throw new FactoryUploadSafetyError(
      'artifact_manifest_path_escaped',
      'Artifact manifest escaped artifact storage'
    );
  }

  manifestPath = await assertLocalFile(
    manifestPath,
    'artifact_manifest_missing',
    [artifactsRoot]
  );

  let manifest;

  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error instanceof FactoryUploadSafetyError) {
      throw error;
    }

    throw new FactoryUploadSafetyError(
      'artifact_manifest_invalid',
      'Artifact manifest is not valid JSON'
    );
  }

  if (manifest?.schema !== ORDER_FACTORY_PACKAGE_SCHEMA) {
    throw new FactoryUploadSafetyError(
      'factory_package_manifest_schema_invalid',
      'Artifact manifest is not an order-level factory package'
    );
  }

  const entries = Array.isArray(manifest?.contents?.files)
    ? manifest.contents.files
    : [];
  const entryNames = entries.map((entry) => String(entry?.name ?? ''));

  if (
    Number(manifest?.contents?.file_count) !== entries.length ||
    new Set(entryNames).size !== entryNames.length
  ) {
    throw new FactoryUploadSafetyError(
      'factory_package_manifest_file_set_invalid',
      'Factory package manifest file set is inconsistent'
    );
  }
  const xmlEntries = entries.filter((entry) =>
    String(entry?.name ?? '').toLowerCase().endsWith('.xml')
  );
  const configuredXmlFileName = assertSafeFileName(
    manifest?.contents?.xml_file_name,
    { extension: '.xml' }
  );

  if (
    xmlEntries.length !== 1 ||
    String(xmlEntries[0]?.name) !== configuredXmlFileName
  ) {
    throw new FactoryUploadSafetyError(
      'xml_file_count_invalid',
      'Artifact manifest must contain exactly one production XML file'
    );
  }

  const localRoot = path.dirname(manifestPath);
  let xmlPath = resolveManifestSourcePath(
    xmlEntries[0].source_path,
    localRoot,
    artifactsRoot
  );

  xmlPath = await assertLocalFile(xmlPath, 'xml_missing', [
    localRoot,
    artifactsRoot,
  ]);

  if (path.basename(xmlPath) !== configuredXmlFileName) {
    throw new FactoryUploadSafetyError(
      'xml_source_name_mismatch',
      'Production XML source path does not match its filename'
    );
  }

  const xmlChecksum = await calculateFileSha256(xmlPath);

  if (
    xmlChecksum !== String(xmlEntries[0]?.checksum_sha256 ?? '') ||
    xmlChecksum !== String(artifact.checksum ?? '')
  ) {
    throw new FactoryUploadSafetyError(
      'factory_package_xml_checksum_mismatch',
      'Production XML checksum does not match durable package metadata'
    );
  }

  let xml;

  try {
    xml = await fs.readFile(xmlPath, 'utf8');
  } catch {
    throw new FactoryUploadSafetyError(
      'xml_missing',
      'Production XML could not be read'
    );
  }

  const pdfFileNames = extractPdfFileNamesFromXml(xml);
  const pdfFiles = [];

  for (const fileName of pdfFileNames) {
    const matchingEntries = entries.filter(
      (entry) => String(entry?.name) === fileName
    );

    if (matchingEntries.length !== 1) {
      throw new FactoryUploadSafetyError(
        'pdf_manifest_entry_missing',
        `PDF referenced by XML is not uniquely present in the manifest: ${fileName}`
      );
    }

    let filePath = resolveManifestSourcePath(
      matchingEntries[0].source_path,
      localRoot,
      artifactsRoot
    );

    filePath = await assertLocalFile(filePath, 'pdf_missing', [
      localRoot,
      artifactsRoot,
    ]);

    if (path.basename(filePath) !== fileName) {
      throw new FactoryUploadSafetyError(
        'pdf_source_name_mismatch',
        'PDF source path does not match the filename referenced by XML'
      );
    }

    const fileChecksum = await calculateFileSha256(filePath);

    if (fileChecksum !== String(matchingEntries[0]?.checksum_sha256 ?? '')) {
      throw new FactoryUploadSafetyError(
        'factory_package_pdf_checksum_mismatch',
        'Production PDF checksum does not match the package manifest'
      );
    }

    if (path.dirname(filePath) !== path.dirname(xmlPath)) {
      throw new FactoryUploadSafetyError(
        'factory_files_not_side_by_side',
        'Factory XML and PDF files must share one local output directory'
      );
    }

    pdfFiles.push({
      type: 'pdf',
      fileName,
      filePath,
    });
  }

  const selectedNames = new Set([
    ...pdfFiles.map((file) => file.fileName),
    configuredXmlFileName,
  ]);

  if (
    entries.length !== selectedNames.size ||
    entries.some((entry) => !selectedNames.has(String(entry?.name ?? '')))
  ) {
    throw new FactoryUploadSafetyError(
      'factory_package_unreferenced_file',
      'Factory package contains a file not referenced by its XML'
    );
  }

  const contentChecksum = crypto
    .createHash('sha256')
    .update(
      entries
        .map((entry) => `${entry.name}:${entry.checksum_sha256}`)
        .join('\n')
    )
    .digest('hex');

  if (
    contentChecksum !==
      String(manifest?.package?.content_checksum_sha256 ?? '') ||
    (orderPackage &&
      contentChecksum !== String(orderPackage.content_checksum ?? ''))
  ) {
    throw new FactoryUploadSafetyError(
      'factory_package_content_checksum_mismatch',
      'Factory package content checksum is invalid'
    );
  }

  return {
    localRoot,
    xmlFile: {
      type: 'xml',
      fileName: configuredXmlFileName,
      filePath: xmlPath,
    },
    pdfFiles,
  };
}

function getFtpConfigurationReadinessReason(config) {
  if (config.FTP_UPLOAD_MODE !== 'files') {
    return 'unsupported_upload_mode';
  }

  if (!isSupportedFtpProtocol(config.FTP_PROTOCOL)) {
    return 'unsupported_protocol';
  }

  if (
    !normalizeFtpRemoteDir(config.FTP_REMOTE_DIR) ||
    !normalizeFtpTempSuffix(config.FTP_TEMP_SUFFIX) ||
    !config.FTP_HOST ||
    !config.FTP_USERNAME ||
    !config.FTP_PASSWORD ||
    config.FTP_PASSIVE !== true
  ) {
    return 'invalid_ftp_configuration';
  }

  return null;
}

function getTaskReadinessReason({ task, config }) {
  if (!config.FTP_UPLOAD_ENABLED) {
    return 'ftp_upload_disabled';
  }

  if (
    !isFtpUploadOrderAllowlisted(
      task.shopify_order_id,
      config.FTP_UPLOAD_ORDER_ALLOWLIST
    )
  ) {
    return 'order_not_allowlisted';
  }

  return getFtpConfigurationReadinessReason(config);
}

function getTaskSafetyDisposition({
  task,
  order,
  artifact,
  orderPackage,
  orderLineItems,
}) {
  if (!task.order_factory_package_id) {
    return {
      status: FACTORY_UPLOAD_TASK_STATUSES.SKIPPED,
      reason: 'legacy_job_level_factory_task_blocked',
    };
  }

  if (!order || !artifact || !orderPackage) {
    return {
      status: FACTORY_UPLOAD_TASK_STATUSES.SKIPPED,
      reason: 'factory_upload_related_record_missing',
    };
  }

  if (
    String(order.id) !== String(task.order_id) ||
    String(artifact.id) !== String(task.artifact_id) ||
    String(orderPackage.id) !== String(task.order_factory_package_id) ||
    String(orderPackage.order_id) !== String(order.id) ||
    String(orderPackage.artifact_id) !== String(artifact.id) ||
    String(order.shopify_order_id) !== String(task.shopify_order_id) ||
    orderPackage.order_number !== task.factory_reference ||
    path.resolve(String(orderPackage.manifest_path ?? '')) !==
      path.resolve(String(artifact.manifest_path ?? '')) ||
    path.resolve(String(orderPackage.package_dir ?? '')) !==
      path.dirname(path.resolve(String(artifact.manifest_path ?? ''))) ||
    orderPackage.xml_file_name !== artifact.file_name ||
    task.job_id !== null ||
    artifact.job_id !== null ||
    artifact.type !== 'factory_package' ||
    artifact.status !== 'available'
  ) {
    return {
      status: FACTORY_UPLOAD_TASK_STATUSES.SKIPPED,
      reason: 'factory_upload_identity_mismatch',
    };
  }

  const dispatchGate = evaluateFactoryDispatchGate({
    order,
    lineItems: orderLineItems,
  });

  if (!dispatchGate.allowed) {
    return {
      status: FACTORY_UPLOAD_TASK_STATUSES.SKIPPED,
      reason: dispatchGate.reason,
    };
  }

  if (orderPackage.status !== 'ready') {
    return {
      status: FACTORY_UPLOAD_TASK_STATUSES.SKIPPED,
      reason: 'order_factory_package_not_ready',
    };
  }

  if (artifact.validation_status !== 'passed') {
    return {
      status: FACTORY_UPLOAD_TASK_STATUSES.SKIPPED,
      reason: 'artifact_validation_not_passed',
    };
  }

  if (task.upload_mode !== 'files') {
    return {
      status: FACTORY_UPLOAD_TASK_STATUSES.SKIPPED,
      reason: 'unsupported_upload_mode',
    };
  }

  return null;
}

function normalizeProgress(task, selectedFiles) {
  const selectedIdentities = new Set(
    selectedFiles.map((file) => `${file.type}:${file.fileName}`)
  );

  return (
    Array.isArray(task.uploaded_files_json) ? task.uploaded_files_json : []
  ).filter(
    (item) =>
      item &&
      item.status === 'renamed' &&
      selectedIdentities.has(`${item.type}:${item.file_name}`)
  );
}

function findProgress(progress, file) {
  return progress.find(
    (item) =>
      item.type === file.type &&
      item.file_name === file.fileName &&
      item.status === 'renamed'
  );
}

function setProgress(progress, file, remotePath) {
  const nextProgress = progress.filter(
    (item) =>
      !(
        item.type === file.type &&
        item.file_name === file.fileName
      )
  );

  nextProgress.push({
    type: file.type,
    file_name: file.fileName,
    remote_path: remotePath,
    status: 'renamed',
  });

  return nextProgress;
}

async function recordDisposition(task, disposition, workerId) {
  const result = await markFactoryUploadTaskDisposition(task.id, {
    ...disposition,
    workerId,
  });

  if (!result.updated) {
    throw new FactoryFtpError(
      'factory_upload_task_claim_lost',
      'Factory upload task claim was lost before safety disposition'
    );
  }

  await logWarning({
    scopeType: 'job',
    orderId: task.order_id,
    jobId: task.job_id,
    step:
      disposition.status === FACTORY_UPLOAD_TASK_STATUSES.SUPPRESSED
        ? 'factory_upload.suppressed'
        : 'factory_upload.skipped',
    message:
      disposition.status === FACTORY_UPLOAD_TASK_STATUSES.SUPPRESSED
        ? 'Factory upload suppressed by safety controls'
        : 'Factory upload skipped by artifact safety gate',
    detailsJson: {
      taskId: task.id,
      artifactId: task.artifact_id,
      reason: disposition.reason,
    },
  });

  return {
    task: result.task,
    disposition: disposition.status,
    reason: disposition.reason,
  };
}

async function recordNotReady(task, reason, workerId) {
  const released = await releaseFactoryUploadTaskClaimToPending(task.id, {
    workerId,
  });

  if (!released.updated) {
    throw new FactoryFtpError(
      'factory_upload_task_claim_lost',
      'Factory upload task claim was lost before returning to pending'
    );
  }

  await logInfo({
    scopeType: 'job',
    orderId: task.order_id,
    jobId: task.job_id,
    step: 'factory_upload.waiting',
    message: 'Factory upload task is pending a temporary readiness gate',
    detailsJson: {
      taskId: task.id,
      artifactId: task.artifact_id,
      reason,
    },
  });

  return {
    task: released.task,
    disposition: 'not_ready',
    reason,
  };
}

async function logNotReady(task, reason) {
  await logInfo({
    scopeType: 'job',
    orderId: task.order_id,
    jobId: task.job_id,
    step: 'factory_upload.waiting',
    message: 'Factory upload task is pending a temporary readiness gate',
    detailsJson: {
      taskId: task.id,
      artifactId: task.artifact_id,
      reason,
    },
  });

  return {
    task,
    disposition: 'not_ready',
    reason,
  };
}

async function uploadFile({
  ftpClient,
  file,
  task,
  workerId,
  progress,
}) {
  const recorded = findProgress(progress, file);
  const finalExists = await ftpClient.fileExists(file.fileName);

  if (recorded && finalExists) {
    return progress;
  }

  if (finalExists) {
    throw new FactoryFtpError(
      'remote_file_exists',
      `Factory FTP file already exists: ${file.fileName}`
    );
  }

  const temporary = await ftpClient.uploadTemporary(
    file.filePath,
    file.fileName
  );

  await logInfo({
    scopeType: 'job',
    orderId: task.order_id,
    jobId: task.job_id,
    step: 'factory_upload.file_uploaded_temp',
    message: 'Factory file uploaded with temporary filename',
    detailsJson: {
      taskId: task.id,
      artifactId: task.artifact_id,
      fileType: file.type,
      remotePath: ftpClient.remotePath(temporary.temporaryFileName),
    },
  });

  await ftpClient.renameTemporary(
    temporary.temporaryFileName,
    temporary.finalFileName
  );

  const nextProgress = setProgress(
    progress,
    file,
    ftpClient.remotePath(file.fileName)
  );
  const progressUpdated = await updateFactoryUploadTaskProgress(task.id, {
    workerId,
    uploadedFiles: nextProgress,
  });

  if (!progressUpdated) {
    throw new FactoryFtpError(
      'factory_upload_task_claim_lost',
      'Factory upload task claim was lost while recording progress'
    );
  }

  await logInfo({
    scopeType: 'job',
    orderId: task.order_id,
    jobId: task.job_id,
    step: 'factory_upload.file_renamed_final',
    message: 'Factory file renamed to final filename',
    detailsJson: {
      taskId: task.id,
      artifactId: task.artifact_id,
      fileType: file.type,
      remotePath: ftpClient.remotePath(file.fileName),
    },
  });

  return nextProgress;
}

export async function processClaimedFactoryUploadTask({
  task,
  workerId,
  config = env,
  ftpClientFactory,
} = {}) {
  if (
    !task ||
    task.status !== FACTORY_UPLOAD_TASK_STATUSES.UPLOADING ||
    task.locked_by !== workerId
  ) {
    return {
      task,
      disposition: 'not_claimed',
      reason: 'factory_upload_task_not_claimed',
    };
  }

  const readinessReason = getTaskReadinessReason({ task, config });

  if (readinessReason) {
    return recordNotReady(task, readinessReason, workerId);
  }

  const [order, artifact, orderPackage, orderLineItems] = await Promise.all([
    findOrderById(task.order_id),
    findArtifactById(task.artifact_id),
    task.order_factory_package_id
      ? findOrderFactoryPackageById(task.order_factory_package_id)
      : Promise.resolve(null),
    listOrderLineItemsByOrderId(task.order_id),
  ]);
  const safetyDisposition = getTaskSafetyDisposition({
    task,
    order,
    artifact,
    orderPackage,
    orderLineItems,
  });

  if (safetyDisposition) {
    return recordDisposition(task, safetyDisposition, workerId);
  }

  let selectedFiles;

  try {
    const resolvedFiles = await resolveFactoryUploadFiles({
      artifact,
      orderPackage,
    });
    selectedFiles = [...resolvedFiles.pdfFiles, resolvedFiles.xmlFile];
  } catch (error) {
    if (error instanceof FactoryUploadSafetyError) {
      return recordDisposition(
        task,
        {
          status: FACTORY_UPLOAD_TASK_STATUSES.SKIPPED,
          reason: error.code,
        },
        workerId
      );
    }

    throw error;
  }

  await logInfo({
    scopeType: 'job',
    orderId: task.order_id,
    jobId: task.job_id,
    step: 'factory_upload.started',
    message: 'Factory FTP upload started',
    detailsJson: {
      taskId: task.id,
      artifactId: task.artifact_id,
      pdfCount: selectedFiles.length - 1,
      xmlCount: 1,
      attemptCount: task.attempt_count,
    },
  });

  const ftpClient = ftpClientFactory
    ? await ftpClientFactory({ config, task })
    : new FactoryFtpClient({ config });
  let progress = normalizeProgress(task, selectedFiles);

  try {
    await ftpClient.connect();

    for (const file of selectedFiles) {
      progress = await uploadFile({
        ftpClient,
        file,
        task,
        workerId,
        progress,
      });
    }

    const completed = await markFactoryUploadTaskUploaded(task.id, {
      workerId,
      uploadedFiles: progress,
      remoteDir: normalizeFtpRemoteDir(config.FTP_REMOTE_DIR),
    });

    if (!completed.updated) {
      throw new FactoryFtpError(
        'factory_upload_task_claim_lost',
        'Factory upload task claim was lost before completion'
      );
    }

    await logInfo({
      scopeType: 'job',
      orderId: task.order_id,
      jobId: task.job_id,
      step: 'factory_upload.completed',
      message: 'Factory FTP upload completed',
      detailsJson: {
        taskId: task.id,
        artifactId: task.artifact_id,
        uploadedFileCount: progress.length,
        xmlFinalizedLast: true,
      },
    });

    return {
      task: completed.task,
      disposition: 'uploaded',
      uploadedFileCount: progress.length,
    };
  } catch (error) {
    const errorCode = String(
      error?.code ?? 'factory_upload_unexpected_failure'
    ).slice(0, 255);
    const safeMessage = redactSensitiveText(
      String(error?.message ?? errorCode)
    ).slice(0, 2000);
    const lastError =
      safeMessage === errorCode ? errorCode : `${errorCode}: ${safeMessage}`;
    const failed = await markFactoryUploadTaskFailed(task.id, {
      workerId,
      lastError,
      retryable: error?.retryable === true,
    });

    await logError({
      scopeType: 'job',
      orderId: task.order_id,
      jobId: task.job_id,
      step: 'factory_upload.failed',
      message: 'Factory FTP upload failed safely',
      detailsJson: {
        taskId: task.id,
        artifactId: task.artifact_id,
        errorCode,
        retryable: error?.retryable === true,
        error: safeErrorForLog(error),
      },
    });

    return {
      task: failed.task,
      disposition: 'failed',
      reason: errorCode,
    };
  } finally {
    try {
      ftpClient.close();
    } catch {
      // The task disposition is already durable; a close error must not
      // change a completed or failed upload result.
    }
  }
}

export async function processFactoryUploadTaskById(
  taskId,
  { workerId, config = env, ftpClientFactory } = {}
) {
  let existingTask = await findFactoryUploadTaskById(taskId);

  if (!existingTask) {
    throw new Error(`Factory upload task not found: ${taskId}`);
  }

  if (
    [
      FACTORY_UPLOAD_TASK_STATUSES.UPLOADED,
      FACTORY_UPLOAD_TASK_STATUSES.SKIPPED,
    ].includes(existingTask.status)
  ) {
    return {
      task: existingTask,
      disposition: existingTask.status,
      reason: existingTask.suppressed_reason,
    };
  }

  if (
    existingTask.status === FACTORY_UPLOAD_TASK_STATUSES.SUPPRESSED &&
    ['ftp_upload_disabled', 'order_not_allowlisted'].includes(
      existingTask.suppressed_reason
    )
  ) {
    const requeued = await requeueTemporarilySuppressedFactoryUploadTask(
      existingTask.id
    );
    existingTask = requeued.task;
  }

  if (existingTask.status === FACTORY_UPLOAD_TASK_STATUSES.SUPPRESSED) {
    return {
      task: existingTask,
      disposition: existingTask.status,
      reason: existingTask.suppressed_reason,
    };
  }

  const readinessReason = getTaskReadinessReason({
    task: existingTask,
    config,
  });

  if (readinessReason) {
    return existingTask.status === FACTORY_UPLOAD_TASK_STATUSES.UPLOADING &&
      existingTask.locked_by === workerId
      ? recordNotReady(existingTask, readinessReason, workerId)
      : logNotReady(existingTask, readinessReason);
  }

  const task = await claimFactoryUploadTaskById(taskId, {
    workerId,
    maxAttempts: config.FTP_UPLOAD_TASK_MAX_ATTEMPTS,
  });

  if (!task) {
    return {
      task: await findFactoryUploadTaskById(taskId),
      disposition: 'not_claimed',
      reason: 'factory_upload_task_not_claimed',
    };
  }

  return processClaimedFactoryUploadTask({
    task,
    workerId,
    config,
    ftpClientFactory,
  });
}

export async function processNextFactoryUploadTask({
  workerId,
  config = env,
  ftpClientFactory,
} = {}) {
  if (!config.FTP_UPLOAD_ENABLED) {
    return null;
  }

  const allowlist = parseFtpUploadOrderAllowlist(
    config.FTP_UPLOAD_ORDER_ALLOWLIST
  );

  if (allowlist.orderIds.length === 0) {
    return null;
  }

  if (getFtpConfigurationReadinessReason(config)) {
    return null;
  }

  await requeueEligibleTemporarilySuppressedFactoryUploadTasks({
    shopifyOrderIds: allowlist.orderIds,
  });
  await releaseStaleFactoryUploadTaskClaims({
    staleLockMinutes: config.PROCESSING_STALE_LOCK_MINUTES,
  });
  const task = await claimNextFactoryUploadTask({
    workerId,
    maxAttempts: config.FTP_UPLOAD_TASK_MAX_ATTEMPTS,
    shopifyOrderIds: allowlist.orderIds,
  });

  if (!task) {
    return null;
  }

  return processClaimedFactoryUploadTask({
    task,
    workerId,
    config,
    ftpClientFactory,
  });
}

export default {
  extractPdfFileNamesFromXml,
  processClaimedFactoryUploadTask,
  processFactoryUploadTaskById,
  processNextFactoryUploadTask,
  resolveFactoryUploadFiles,
};
