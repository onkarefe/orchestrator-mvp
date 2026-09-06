import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  LINE_ITEM_CLASSIFICATIONS,
  LINE_ITEM_ROUTING_STATES,
} from '../src/constants/lineItemRouting.js';
import {
  assembleOrderFactoryPackage,
  inspectOrderFactoryReadiness,
} from '../src/processing/OrderFactoryPackageAssembler.js';
import { buildWallpaperPanelFileName } from '../src/processing/factoryFileNames.js';
import { resolveFactoryUploadFiles } from '../src/services/FactoryUploadService.js';
import { ensureOrderFactoryPackage } from '../src/services/OrderFactoryPackageService.js';
import { ensureOrderFactoryUploadTask } from '../src/services/FactoryUploadTaskService.js';

const tempRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'orchestrator-order-factory-')
);
const artifactsRoot = path.join(tempRoot, 'artifacts');
await fs.mkdir(artifactsRoot, { recursive: true });

function sourceItem(id, sku, quantity = 1) {
  return { id, sku, title: sku, quantity };
}

function orderFixture(id, sourceItems) {
  return {
    id,
    shopify_order_id: String(8000 + id),
    raw_payload_json: {
      id: String(8000 + id),
      line_items: sourceItems,
      shipping_lines: [{ title: 'Unsafe arbitrary shipping value' }],
      shipping_address: {
        name: 'Factory Test',
        address1: 'Test Street 1',
        zip: '12345',
        city: 'Berlin',
        country_code: 'DE',
        phone: null,
      },
      phone: '555-0100',
    },
  };
}

function persistedLine(order, source, sourcePosition, classification = 'WALLPAPER') {
  return {
    id: sourcePosition + 1,
    order_id: order.id,
    shopify_order_id: order.shopify_order_id,
    shopify_line_item_id: String(source.id),
    source_position: sourcePosition,
    sku: source.sku,
    quantity: source.quantity,
    classification,
    routing_state:
      classification === LINE_ITEM_CLASSIFICATIONS.WALLPAPER
        ? LINE_ITEM_ROUTING_STATES.PRODUCTION_READY
        : LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED,
  };
}

async function renderFixture({ order, lineItem, jobId, status = 'completed' }) {
  const renderDir = path.join(
    artifactsRoot,
    'orders',
    `order-${order.id}`,
    'jobs',
    `job-${jobId}`,
    'factory-files',
    'run-1'
  );
  await fs.mkdir(renderDir, { recursive: true });
  const sourcePdfName = `legacy-render-${jobId}-01.pdf`;
  const sourcePdfPath = path.join(renderDir, sourcePdfName);
  await fs.writeFile(sourcePdfPath, `%PDF test job ${jobId}`, 'utf8');
  const manifestPath = path.join(
    artifactsRoot,
    'orders',
    `order-${order.id}`,
    'jobs',
    `job-${jobId}`,
    'manifest.json'
  );
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      order: { id: order.id, shopify_order_id: order.shopify_order_id },
      job: {
        id: jobId,
        shopify_line_item_id: lineItem.shopify_line_item_id,
      },
      contents: {
        panel_count: 1,
        panels: [
          { file_name: sourcePdfName, width_mm: 625, height_mm: 2400 },
        ],
        files: [{ name: sourcePdfName, source_path: sourcePdfPath }],
      },
      validation: { ok: true, validationStatus: 'passed' },
    })}\n`,
    'utf8'
  );
  const job = {
    id: jobId,
    order_id: order.id,
    shopify_order_id: order.shopify_order_id,
    shopify_line_item_id: lineItem.shopify_line_item_id,
    sku: lineItem.sku,
    status,
    artifact_manifest_path: manifestPath,
  };
  const artifact = {
    id: jobId + 100,
    order_id: order.id,
    job_id: jobId,
    type: 'zip',
    status: 'available',
    validation_status: 'passed',
    manifest_path: manifestPath,
  };

  return { job, artifact };
}

function xmlReferences(xml) {
  return [...xml.matchAll(/<file type="ftp">([^<]+)<\/file>/g)].map(
    (match) => match[1]
  );
}

try {
  const oneSource = sourceItem(101, 'WALLPAPER-A');
  const oneOrder = orderFixture(1, [oneSource]);
  const oneLine = persistedLine(oneOrder, oneSource, 0);
  const oneRender = await renderFixture({
    order: oneOrder,
    lineItem: oneLine,
    jobId: 11,
  });
  const oneReady = await inspectOrderFactoryReadiness({
    order: oneOrder,
    lineItems: [oneLine],
    jobs: [oneRender.job],
    artifacts: [oneRender.artifact],
    artifactsRoot,
  });
  assert.equal(oneReady.ready, true);
  assert.equal(oneReady.positions.length, 1);
  const invalidQuantityReadiness = await inspectOrderFactoryReadiness({
    order: oneOrder,
    lineItems: [{ ...oneLine, quantity: 2 }],
    jobs: [oneRender.job],
    artifacts: [oneRender.artifact],
    artifactsRoot,
  });
  assert.equal(invalidQuantityReadiness.ready, false);
  assert.equal(
    invalidQuantityReadiness.reason,
    'wallpaper_quantity_invalid'
  );
  const oneAssembly = await assembleOrderFactoryPackage({
    order: oneOrder,
    positions: oneReady.positions,
    artifactsRoot,
  });
  const oneXml = await fs.readFile(oneAssembly.xmlPath, 'utf8');
  assert.equal((oneXml.match(/<position>/g) ?? []).length, 1);
  assert.equal(oneAssembly.orderNumber, `WANDINI-S${oneOrder.shopify_order_id}`);
  let taskCreateCount = 0;
  const oneTask = await ensureOrderFactoryUploadTask({
    order: oneOrder,
    orderPackage: {
      id: 501,
      order_id: oneOrder.id,
      artifact_id: 601,
      order_number: oneAssembly.orderNumber,
      status: 'ready',
      manifest_path: oneAssembly.manifestPath,
      xml_file_name: oneAssembly.xmlFileName,
    },
    artifact: {
      id: 601,
      order_id: oneOrder.id,
      job_id: null,
      type: 'factory_package',
      status: 'available',
      validation_status: 'passed',
      manifest_path: oneAssembly.manifestPath,
      file_name: oneAssembly.xmlFileName,
    },
    orderLineItems: [oneLine],
    config: { FTP_REMOTE_DIR: '/factory', FTP_UPLOAD_TASK_MAX_ATTEMPTS: 3 },
    runtime: {
      findFactoryUploadTaskByOrderPackageId: async () => null,
      createFactoryUploadTask: async (data) => {
        taskCreateCount += 1;
        return {
          id: 701,
          order_id: data.orderId,
          job_id: null,
          artifact_id: data.artifactId,
          order_factory_package_id: data.orderFactoryPackageId,
          shopify_order_id: String(data.shopifyOrderId),
          factory_reference: data.factoryReference,
          upload_mode: data.uploadMode,
          status: data.status,
        };
      },
    },
  });
  assert.equal(oneTask.created, true);
  assert.equal(taskCreateCount, 1);

  const twoSources = [
    sourceItem(201, 'WALLPAPER-FIRST', 1),
    sourceItem(202, 'WALLPAPER-SECOND', 1),
  ];
  const twoOrder = orderFixture(2, twoSources);
  const twoLines = twoSources.map((source, index) =>
    persistedLine(twoOrder, source, index)
  );
  const twoRenders = await Promise.all(
    twoLines.map((lineItem, index) =>
      renderFixture({ order: twoOrder, lineItem, jobId: 21 + index })
    )
  );
  const twoReady = await inspectOrderFactoryReadiness({
    order: twoOrder,
    lineItems: [...twoLines].reverse(),
    jobs: twoRenders.map((item) => item.job),
    artifacts: twoRenders.map((item) => item.artifact),
    artifactsRoot,
  });
  assert.equal(twoReady.ready, true);
  assert.deepEqual(
    twoReady.positions.map((position) => position.sourcePosition),
    [0, 1]
  );
  const twoAssembly = await assembleOrderFactoryPackage({
    order: twoOrder,
    positions: twoReady.positions,
    artifactsRoot,
  });
  const twoXml = await fs.readFile(twoAssembly.xmlPath, 'utf8');
  assert.equal((twoXml.match(/<position>/g) ?? []).length, 2);
  assert.equal((twoXml.match(/<\?xml/g) ?? []).length, 1);
  assert.ok(twoXml.includes('<sku>WALLPAPER-FIRST</sku>'));
  assert.ok(twoXml.includes('<sku>WALLPAPER-SECOND</sku>'));
  assert.ok(twoXml.indexOf('WALLPAPER-FIRST') < twoXml.indexOf('WALLPAPER-SECOND'));
  assert.equal(
    (twoXml.match(/<copies_per_variant>1<\/copies_per_variant>/g) ?? [])
      .length,
    2
  );
  assert.ok(
    twoXml.includes(
      `<order_number>WANDINI-S${twoOrder.shopify_order_id}</order_number>`
    )
  );
  assert.ok(!twoXml.includes('<reference>'));
  assert.ok(!twoXml.includes('<delivery_note>'));
  assert.ok(twoXml.includes('<shipping_type>Standard</shipping_type>'));
  assert.ok(twoXml.includes('<company>Wandini</company>'));
  assert.ok(twoXml.includes('<contact_person>Wandini</contact_person>'));
  assert.ok(twoXml.includes('<street>Rheinstrasse 12</street>'));
  assert.ok(twoXml.includes('<postcode>41836</postcode>'));
  assert.ok(twoXml.includes('<city>Hückelhoven</city>'));
  assert.ok(twoXml.includes('<country>DE</country>'));
  assert.ok(twoXml.includes('<phone>555-0100</phone>'));
  const expectedPdfNames = [
    buildWallpaperPanelFileName({
      shopifyOrderId: twoOrder.shopify_order_id,
      sourcePosition: 0,
      panelNumber: 1,
    }),
    buildWallpaperPanelFileName({
      shopifyOrderId: twoOrder.shopify_order_id,
      sourcePosition: 1,
      panelNumber: 1,
    }),
  ];
  assert.deepEqual(xmlReferences(twoXml), expectedPdfNames);
  assert.equal(new Set(expectedPdfNames).size, expectedPdfNames.length);
  const packageEntries = await fs.readdir(twoAssembly.packageDir);
  assert.equal(packageEntries.filter((name) => name.endsWith('.xml')).length, 1);
  assert.equal(packageEntries.filter((name) => name.endsWith('.pdf')).length, 2);
  assert.deepEqual(
    packageEntries.filter((name) => name.endsWith('.pdf')).sort(),
    [...expectedPdfNames].sort()
  );
  const resolvedUpload = await resolveFactoryUploadFiles({
    artifact: {
      id: 901,
      manifest_path: twoAssembly.manifestPath,
      checksum: twoAssembly.xmlChecksum,
    },
    orderPackage: {
      content_checksum: twoAssembly.contentChecksum,
    },
    artifactsRoot,
  });
  assert.deepEqual(
    resolvedUpload.pdfFiles.map((file) => file.fileName),
    expectedPdfNames
  );
  assert.equal(resolvedUpload.xmlFile.fileName, twoAssembly.xmlFileName);

  const pendingRenders = [
    twoRenders[0],
    {
      ...twoRenders[1],
      job: { ...twoRenders[1].job, status: 'pending' },
    },
  ];
  const pendingReadiness = await inspectOrderFactoryReadiness({
    order: twoOrder,
    lineItems: twoLines,
    jobs: pendingRenders.map((item) => item.job),
    artifacts: pendingRenders.map((item) => item.artifact),
    artifactsRoot,
  });
  assert.equal(pendingReadiness.ready, false);
  assert.equal(pendingReadiness.reason, 'wallpaper_job_not_completed');
  let prematureAssemblyCount = 0;
  let prematureTaskCount = 0;
  const notReadyResult = await ensureOrderFactoryPackage({
    orderId: twoOrder.id,
    runtime: {
      getConnection: async () => ({
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
      }),
      findOrderByIdForUpdate: async () => twoOrder,
      listOrderLineItemsByOrderId: async () => twoLines,
      findOrderFactoryPackageByOrderId: async () => null,
      listJobsByOrderId: async () => pendingRenders.map((item) => item.job),
      listArtifactsByOrderId: async () =>
        pendingRenders.map((item) => item.artifact),
      inspectOrderFactoryReadiness: async () => pendingReadiness,
      assembleOrderFactoryPackage: async () => {
        prematureAssemblyCount += 1;
      },
      ensureOrderFactoryUploadTask: async () => {
        prematureTaskCount += 1;
      },
      logInfo: async () => null,
      logWarning: async () => null,
    },
  });
  assert.equal(notReadyResult.disposition, 'not_ready');
  assert.equal(notReadyResult.task, null);
  assert.equal(prematureAssemblyCount, 0);
  assert.equal(prematureTaskCount, 0);

  for (const classification of [
    LINE_ITEM_CLASSIFICATIONS.ACCESSORY,
    LINE_ITEM_CLASSIFICATIONS.UNKNOWN,
  ]) {
    const blockedLine = persistedLine(
      oneOrder,
      oneSource,
      0,
      classification
    );
    const blocked = await inspectOrderFactoryReadiness({
      order: oneOrder,
      lineItems: [blockedLine],
      jobs: [oneRender.job],
      artifacts: [oneRender.artifact],
      artifactsRoot,
    });
    assert.equal(blocked.ready, false);
  }

  let lockTail = Promise.resolve();
  const state = { artifact: null, package: null, task: null };
  const counts = { assemble: 0, artifact: 0, package: 0, task: 0 };
  function connection() {
    let unlock;

    return {
      async beginTransaction() {
        const previous = lockTail;
        lockTail = new Promise((resolve) => {
          unlock = resolve;
        });
        await previous;
      },
      async commit() {
        unlock();
      },
      async rollback() {
        unlock();
      },
      release() {},
    };
  }
  const raceRuntime = {
    getConnection: async () => connection(),
    findOrderByIdForUpdate: async () => twoOrder,
    listOrderLineItemsByOrderId: async () => twoLines,
    findOrderFactoryPackageByOrderId: async () => state.package,
    findArtifactById: async () => state.artifact,
    listJobsByOrderId: async () => twoRenders.map((item) => item.job),
    listArtifactsByOrderId: async () =>
      twoRenders.map((item) => item.artifact),
    inspectOrderFactoryReadiness: async () => ({
      ready: true,
      positions: twoReady.positions,
    }),
    assembleOrderFactoryPackage: async () => {
      counts.assemble += 1;
      return {
        orderNumber: `WANDINI-S${twoOrder.shopify_order_id}`,
        packageDir: twoAssembly.packageDir,
        manifestPath: twoAssembly.manifestPath,
        xmlFileName: twoAssembly.xmlFileName,
        xmlPath: twoAssembly.xmlPath,
        xmlChecksum: twoAssembly.xmlChecksum,
        xmlSizeBytes: twoAssembly.xmlSizeBytes,
        contentChecksum: twoAssembly.contentChecksum,
        fileCount: twoAssembly.fileCount,
        totalSizeBytes: twoAssembly.totalSizeBytes,
      };
    },
    createArtifact: async (data) => {
      counts.artifact += 1;
      state.artifact = {
        id: 1001,
        order_id: data.orderId,
        job_id: null,
        validation_status: data.validationStatus,
      };
      return state.artifact;
    },
    createOrderFactoryPackage: async (data) => {
      counts.package += 1;
      state.package = {
        id: 1101,
        order_id: data.orderId,
        artifact_id: data.artifactId,
        order_number: data.orderNumber,
        status: data.status,
      };
      return state.package;
    },
    ensureOrderFactoryUploadTask: async () => {
      if (!state.task) {
        counts.task += 1;
        state.task = { id: 1201, status: 'pending' };
        return { task: state.task, created: true };
      }

      return { task: state.task, created: false };
    },
    removeAssembledOrderFactoryPackage: async () => null,
    logInfo: async () => null,
    logWarning: async () => null,
  };
  const raced = await Promise.all([
    ensureOrderFactoryPackage({ orderId: twoOrder.id, runtime: raceRuntime }),
    ensureOrderFactoryPackage({ orderId: twoOrder.id, runtime: raceRuntime }),
  ]);
  assert.equal(raced.filter((result) => result.created).length, 1);
  assert.equal(new Set(raced.map((result) => result.orderPackage.id)).size, 1);
  assert.equal(new Set(raced.map((result) => result.task.id)).size, 1);
  assert.deepEqual(counts, { assemble: 1, artifact: 1, package: 1, task: 1 });
  const repeated = await ensureOrderFactoryPackage({
    orderId: twoOrder.id,
    runtime: raceRuntime,
  });
  assert.equal(repeated.created, false);
  assert.equal(repeated.orderPackage.id, state.package.id);
  assert.equal(repeated.task.id, state.task.id);

  const migration = await fs.readFile(
    path.resolve('src/db/migrations/008_order_level_factory_packages.sql'),
    'utf8'
  );
  assert.ok(migration.includes('uq_order_factory_packages_order_id'));
  assert.ok(migration.includes('uq_factory_upload_tasks_order_package'));

  console.log('order-level factory package safety smoke ok');
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
