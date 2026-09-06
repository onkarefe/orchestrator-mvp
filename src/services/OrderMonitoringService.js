import { getOrderLifecycle } from './ShopifyLifecycleService.js';

function anomaly(code, message, severity = 'warning') {
  return { code, message, severity };
}

function isStale(timestamp, staleMinutes, now) {
  const time = new Date(timestamp).getTime();

  return (
    Number.isFinite(time) &&
    now.getTime() - time > Number(staleMinutes || 30) * 60 * 1000
  );
}

export function buildOrderMonitoring({
  order,
  webhooks = [],
  lineItems = [],
  jobs = [],
  artifacts = [],
  orderPackage = null,
  uploadTask = null,
  factoryCallbacks = [],
  shopifyUpdateTasks = [],
  logs = [],
  staleMinutes = 30,
  now = new Date(),
} = {}) {
  const anomalies = [];
  const lifecycle = getOrderLifecycle(order);
  const wallpaperLines = lineItems.filter(
    (lineItem) => lineItem.classification === 'WALLPAPER'
  );
  const completedJobs = jobs.filter((job) => job.status === 'completed');

  if (lineItems.length > 0 && wallpaperLines.length > 0 && jobs.length === 0) {
    anomalies.push(
      anomaly(
        'order_received_job_missing',
        'Wallpaper order was received but no render job exists.',
        'critical'
      )
    );
  } else if (
    jobs.some(
      (job) =>
        job.status === 'pending' &&
        isStale(job.created_at, staleMinutes, now)
    )
  ) {
    anomalies.push(
      anomaly(
        'render_job_not_started',
        'A render job has remained pending beyond the worker stale threshold.'
      )
    );
  }

  if (
    jobs.length > 0 &&
    completedJobs.length === jobs.length &&
    !orderPackage &&
    !lifecycle
  ) {
    anomalies.push(
      anomaly(
        'render_complete_package_missing',
        'All render jobs completed but the order-level factory package is missing.',
        'critical'
      )
    );
  }

  if (orderPackage?.status === 'ready' && !uploadTask && !lifecycle) {
    anomalies.push(
      anomaly(
        'package_ready_ftp_task_missing',
        'Factory package is ready but its FTP task is missing.',
        'critical'
      )
    );
  } else if (uploadTask?.status === 'failed') {
    anomalies.push(
      anomaly(
        'ftp_upload_failed',
        `Factory FTP upload failed: ${uploadTask.last_error || 'unknown error'}`,
        'critical'
      )
    );
  } else if (
    uploadTask?.status === 'uploading' &&
    isStale(uploadTask.locked_at, staleMinutes, now)
  ) {
    anomalies.push(
      anomaly(
        'ftp_upload_stuck',
        'Factory FTP task is still uploading beyond the stale-lock threshold.',
        'critical'
      )
    );
  } else if (
    uploadTask?.status === 'pending' &&
    isStale(uploadTask.created_at, staleMinutes, now)
  ) {
    anomalies.push(
      anomaly(
        'ftp_upload_pending',
        'Factory FTP task has remained pending beyond the worker stale threshold.'
      )
    );
  }

  if (
    uploadTask?.status === 'uploaded' &&
    !orderPackage?.nexo_order_id &&
    !orderPackage?.factory_status &&
    factoryCallbacks.length === 0
  ) {
    anomalies.push(
      anomaly(
        'nexo_progression_missing',
        'FTP upload completed but no NEXO identity, status, or callback is recorded.'
      )
    );
  }

  const nexoShipped =
    String(orderPackage?.factory_status ?? order?.factory_status ?? '')
      .trim()
      .toLowerCase() === 'shipped';
  const completedShopifyUpdate = shopifyUpdateTasks.some(
    (task) => task.status === 'completed'
  );

  if (nexoShipped && !completedShopifyUpdate) {
    const failedTask = shopifyUpdateTasks.find(
      (task) => ['failed', 'manual_review'].includes(task.status)
    );
    anomalies.push(
      anomaly(
        failedTask
          ? 'shopify_fulfillment_failed'
          : 'shopify_fulfillment_pending',
        failedTask
          ? `NEXO is shipped but Shopify fulfillment requires attention: ${
              failedTask.last_error || failedTask.status
            }`
          : 'NEXO is shipped but Shopify fulfillment has not completed.',
        failedTask ? 'critical' : 'warning'
      )
    );
  }

  if (lifecycle) {
    anomalies.push(
      anomaly(
        'shopify_lifecycle_conflict',
        lifecycle.state === 'factory_lifecycle_attention_required'
          ? `Factory-side lifecycle resolution required: ${lifecycle.reason}`
          : `Factory dispatch blocked by Shopify lifecycle: ${lifecycle.reason}`,
        'critical'
      )
    );
  }

  const reconciliationLog = logs.find(
    (log) =>
      log.step === 'factory_package.assembly_not_ready' &&
      String(log.details_json?.reason ?? '').startsWith(
        'order_factory_package_orphan_'
      )
  );

  if (reconciliationLog) {
    anomalies.push(
      anomaly(
        'factory_package_reconciliation_ambiguous',
        `Package filesystem reconciliation is blocked: ${reconciliationLog.details_json.reason}`,
        'critical'
      )
    );
  }

  return {
    lifecycle,
    anomalies,
    stages: [
      { name: 'Shopify intake', count: webhooks.length, status: webhooks[0]?.processing_status ?? order?.status },
      { name: 'Line-item routing', count: lineItems.length, status: lineItems.every((item) => item.routing_state === 'production_ready') ? 'ready' : 'blocked' },
      { name: 'Render jobs', count: jobs.length, status: jobs.length ? jobs.map((job) => job.status).join(', ') : 'missing' },
      { name: 'Artifacts', count: artifacts.length, status: artifacts.length ? 'recorded' : 'missing' },
      { name: 'Factory package', count: orderPackage ? 1 : 0, status: orderPackage?.status ?? 'missing' },
      { name: 'FTP dispatch', count: uploadTask ? 1 : 0, status: uploadTask?.status ?? 'missing' },
      { name: 'NEXO', count: factoryCallbacks.length, status: orderPackage?.factory_status ?? order?.factory_status ?? 'awaiting' },
      { name: 'Shopify fulfillment', count: shopifyUpdateTasks.length, status: shopifyUpdateTasks[0]?.status ?? 'awaiting' },
    ],
  };
}

export default { buildOrderMonitoring };
