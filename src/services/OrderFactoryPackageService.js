import env from '../config/env.js';
import { ORDER_STATUSES } from '../constants/statuses.js';
import pool from '../db/connection.js';
import {
  createArtifact,
  findArtifactById,
  listArtifactsByOrderId,
} from '../models/ArtifactModel.js';
import { listJobsByOrderId } from '../models/JobModel.js';
import {
  createOrderFactoryPackage,
  findOrderFactoryPackageByOrderId,
} from '../models/OrderFactoryPackageModel.js';
import { listOrderLineItemsByOrderId } from '../models/OrderLineItemModel.js';
import { findOrderByIdForUpdate, updateOrderStatus } from '../models/OrderModel.js';
import {
  assembleOrderFactoryPackage,
  inspectOrderFactoryReadiness,
  removeAssembledOrderFactoryPackage,
} from '../processing/OrderFactoryPackageAssembler.js';
import { ensureOrderFactoryUploadTask } from './FactoryUploadTaskService.js';
import { logInfo, logWarning } from './LogService.js';
import { safeErrorForLog } from '../utils/redact.js';

function canCompleteFactoryPackageOrder(status) {
  return [
    ORDER_STATUSES.RECEIVED,
    ORDER_STATUSES.VALIDATED,
    'queued',
    ORDER_STATUSES.PROCESSING,
    ORDER_STATUSES.ARTIFACT_READY,
  ].includes(status);
}

export async function ensureOrderFactoryPackage({
  orderId,
  config = env,
  runtime = {},
} = {}) {
  const getConnection = runtime.getConnection ?? (() => pool.getConnection());
  const findOrder = runtime.findOrderByIdForUpdate ?? findOrderByIdForUpdate;
  const updateStatus = runtime.updateOrderStatus ?? updateOrderStatus;
  const findPackage =
    runtime.findOrderFactoryPackageByOrderId ??
    findOrderFactoryPackageByOrderId;
  const findArtifact = runtime.findArtifactById ?? findArtifactById;
  const listLineItems =
    runtime.listOrderLineItemsByOrderId ?? listOrderLineItemsByOrderId;
  const listJobs = runtime.listJobsByOrderId ?? listJobsByOrderId;
  const listArtifacts =
    runtime.listArtifactsByOrderId ?? listArtifactsByOrderId;
  const inspectReadiness =
    runtime.inspectOrderFactoryReadiness ?? inspectOrderFactoryReadiness;
  const assemblePackage =
    runtime.assembleOrderFactoryPackage ?? assembleOrderFactoryPackage;
  const createArtifactRecord = runtime.createArtifact ?? createArtifact;
  const createPackageRecord =
    runtime.createOrderFactoryPackage ?? createOrderFactoryPackage;
  const ensureTask =
    runtime.ensureOrderFactoryUploadTask ?? ensureOrderFactoryUploadTask;
  const removePackage =
    runtime.removeAssembledOrderFactoryPackage ??
    removeAssembledOrderFactoryPackage;
  const writeInfoLog = (data) => Promise.resolve()
    .then(() => (runtime.logInfo ?? logInfo)(data)).catch(() => null);
  const writeWarningLog = (data) => Promise.resolve()
    .then(() => (runtime.logWarning ?? logWarning)(data)).catch(() => null);
  const connection = await getConnection();
  let transactionStarted = false;
  let connectionReleased = false;
  const releaseConnection = () => {
    if (!connectionReleased) {
      connection.release();
      connectionReleased = true;
    }
  };
  let assembled = null;
  let packageCommitted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;
    let order = await findOrder(orderId, connection);

    if (!order) {
      throw new Error(`Order not found for factory package: ${orderId}`);
    }

    if (order.status === ORDER_STATUSES.SECURITY_HOLD) {
      await connection.commit();
      transactionStarted = false;
      return { disposition: 'not_ready', created: false, reason: 'checkout_security_hold',
        order, orderPackage: null, artifact: null, task: null };
    }

    const lineItems = await listLineItems(order.id, connection);
    const existingPackage = await findPackage(order.id, connection, {
      forUpdate: true,
    });

    if (existingPackage) {
      const artifact = await findArtifact(
        existingPackage.artifact_id,
        connection
      );
      const taskResult = await ensureTask({
        order,
        orderPackage: existingPackage,
        artifact,
        orderLineItems: lineItems,
        config,
        db: connection,
        runtime,
      });

      if (!taskResult.task) {
        throw new Error(
          taskResult.reason || 'existing_order_factory_task_not_ready'
        );
      }

      // The order is locked; publish callback readiness with the package/task.
      if (canCompleteFactoryPackageOrder(order.status)) {
        order = await updateStatus(order.id, ORDER_STATUSES.COMPLETED, connection);
      }

      await connection.commit();
      transactionStarted = false;
      releaseConnection();
      await writeInfoLog({
        scopeType: 'order',
        orderId: order.id,
        step: 'factory_package.reused',
        message: 'Existing order-level factory package reused',
        detailsJson: {
          packageId: existingPackage.id,
          artifactId: artifact.id,
          taskId: taskResult.task.id,
        },
      });

      return {
        disposition: 'ready',
        created: false,
        order,
        orderPackage: existingPackage,
        artifact,
        task: taskResult.task,
        taskCreated: taskResult.created,
      };
    }

    const jobs = await listJobs(order.id, connection);
    const artifacts = await listArtifacts(order.id, connection);
    const readiness = await inspectReadiness({
      order,
      lineItems,
      jobs,
      artifacts,
    });

    if (!readiness.ready) {
      await connection.commit();
      transactionStarted = false;
      releaseConnection();
      await writeWarningLog({
        scopeType: 'order',
        orderId: order.id,
        step: 'factory_package.not_ready',
        message: 'Order-level factory package is not ready',
        detailsJson: {
          reason: readiness.reason,
          ...readiness.details,
        },
      });

      return {
        disposition: 'not_ready',
        created: false,
        reason: readiness.reason,
        order,
        orderPackage: null,
        artifact: null,
        task: null,
      };
    }

    try {
      assembled = await assemblePackage({
        order,
        positions: readiness.positions,
      });
    } catch (error) {
      await connection.commit();
      transactionStarted = false;
      releaseConnection();
      await writeWarningLog({
        scopeType: 'order',
        orderId: order.id,
        step: 'factory_package.assembly_not_ready',
        message: 'Order-level factory package assembly was blocked safely',
        detailsJson: {
          reason: String(error?.message ?? '').startsWith(
            'order_factory_package_orphan_'
          )
            ? error.message
            : 'order_factory_package_assembly_failed',
          error: safeErrorForLog(error),
        },
      });

      return {
        disposition: 'not_ready',
        created: false,
        reason: String(error?.message ?? '').startsWith(
          'order_factory_package_orphan_'
        )
          ? error.message
          : 'order_factory_package_assembly_failed',
        order,
        orderPackage: null,
        artifact: null,
        task: null,
      };
    }
    const artifact = await createArtifactRecord(
      {
        orderId: order.id,
        jobId: null,
        type: 'factory_package',
        fileName: assembled.xmlFileName,
        filePath: assembled.xmlPath,
        manifestPath: assembled.manifestPath,
        checksum: assembled.xmlChecksum,
        fileCount: assembled.fileCount,
        totalSizeBytes: assembled.totalSizeBytes,
        fileSize: assembled.xmlSizeBytes,
        status: 'available',
        validationStatus: 'passed',
      },
      connection
    );
    const orderPackage = await createPackageRecord(
      {
        orderId: order.id,
        shopifyOrderId: order.shopify_order_id,
        artifactId: artifact.id,
        orderNumber: assembled.orderNumber,
        status: 'ready',
        packageDir: assembled.packageDir,
        manifestPath: assembled.manifestPath,
        xmlFileName: assembled.xmlFileName,
        fileCount: assembled.fileCount,
        contentChecksum: assembled.contentChecksum,
      },
      connection
    );
    const taskResult = await ensureTask({
      order,
      orderPackage,
      artifact,
      orderLineItems: lineItems,
      config,
      db: connection,
      runtime,
    });

    if (!taskResult.task) {
      throw new Error(taskResult.reason || 'order_factory_task_not_created');
    }

    if (canCompleteFactoryPackageOrder(order.status)) {
      order = await updateStatus(order.id, ORDER_STATUSES.COMPLETED, connection);
    }

    await connection.commit();
    transactionStarted = false;
    packageCommitted = true;
    releaseConnection();
    await writeInfoLog({
      scopeType: 'order',
      orderId: order.id,
      step: 'factory_package.created',
      message: 'Order-level factory package and upload task created',
      detailsJson: {
        packageId: orderPackage.id,
        artifactId: artifact.id,
        taskId: taskResult.task.id,
        positionCount: readiness.positions.length,
        fileCount: assembled.fileCount,
        contentChecksum: assembled.contentChecksum,
      },
    });

    return {
      disposition: 'ready',
      created: true,
      order,
      orderPackage,
      artifact,
      task: taskResult.task,
      taskCreated: taskResult.created,
    };
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
      transactionStarted = false;
      releaseConnection();
    }

    if (
      assembled?.packageDir &&
      assembled.recoveredExisting !== true &&
      !packageCommitted
    ) {
      await removePackage(assembled.packageDir);
    }

    throw error;
  } finally {
    releaseConnection();
  }
}

export default {
  ensureOrderFactoryPackage,
};
