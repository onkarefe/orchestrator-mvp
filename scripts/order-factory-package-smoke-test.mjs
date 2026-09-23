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
import { buildWallpaperRenderPlan } from '../src/processing/panels.js';
import { reconcileFactoryOrders } from '../src/services/PipelineRecoveryService.js';
import { extractPdfFileNamesFromXml, resolveFactoryUploadFiles } from '../src/services/FactoryUploadService.js';
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
      ['WALLPAPER', 'ACCESSORY'].includes(classification)
        ? LINE_ITEM_ROUTING_STATES.PRODUCTION_READY
        : LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED,
  };
}

async function renderFixture({ order, lineItem, jobId, status = 'completed', plan }) {
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

  const panels = [];
  const files = [];
  for (let index = 0; index < (plan?.segments.length ?? 1); index += 1) {
    const name = 'legacy-render-' + jobId + '-' + index + '.pdf';
    const sourcePath = path.join(renderDir, name);
    await fs.writeFile(sourcePath, '%PDF test job ' + jobId, 'utf8');
    panels.push({
      file_name: name,
      width_mm: plan?.segments[index].pageWidthMm ?? 625,
      height_mm: plan?.segments[index].pageHeightMm ?? 2400,
    });
    files.push({ name, source_path: sourcePath });
  }
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
        panel_count: panels.length,
        panels,
        files,
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
  // A historical partial render is evidence, not the completed job's output.
  const historicalArtifact = {
    ...oneRender.artifact, id: 9999,
    manifest_path: path.join(artifactsRoot, 'previous-attempt-manifest.json'),
  };
  const recoveredRender = await inspectOrderFactoryReadiness({
    order: oneOrder, lineItems: [oneLine], jobs: [oneRender.job],
    artifacts: [historicalArtifact, oneRender.artifact], artifactsRoot,
  });
  assert.equal(recoveredRender.ready, true);
  assert.equal(recoveredRender.positions[0].artifactId, oneRender.artifact.id);
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
  const recoveredOrphan = await assembleOrderFactoryPackage({
    order: oneOrder,
    positions: oneReady.positions,
    artifactsRoot,
  });
  assert.equal(recoveredOrphan.recoveredExisting, true);
  assert.equal(recoveredOrphan.contentChecksum, oneAssembly.contentChecksum);
  await assert.rejects(
    assembleOrderFactoryPackage({
      order: oneOrder,
      positions: [
        { ...oneReady.positions[0], sku: 'MISMATCHED-ORPHAN-SKU' },
      ],
      artifactsRoot,
    }),
    /order_factory_package_orphan_identity_mismatch/
  );
  assert.equal(
    (await fs.stat(oneAssembly.packageDir)).isDirectory(),
    true
  );
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
      findOrderByIdForUpdate: async () => ({ ...twoOrder, status: 'processing' }),
      updateOrderStatus: async () => assert.fail('Not-ready orders must not change status'),
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
  assert.equal(notReadyResult.order.status, 'processing');
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

  const addonCases = [
    { id: 10, sources: [
      sourceItem(1001, '20-140.1-3'), sourceItem(1002, '283-391.0'),
      sourceItem(1003, '283-394.0'),
    ], wallpaper: [0], pdfs: 5, positions: 3 },
    { id: 11, sources: [
      sourceItem(1101, '283-391.0', 3),
    ], wallpaper: [], pdfs: 0, positions: 3 },
    { id: 12, sources: [
      sourceItem(1201, '283-391.0', 2), sourceItem(1202, '283-388.0'),
    ], wallpaper: [], pdfs: 0, positions: 3 },
    { id: 13, sources: [
      sourceItem(1301, '283-391.0', 2), sourceItem(1302, '20-140.1-3'),
      sourceItem(1303, '283-394.0'), sourceItem(1304, '20-331.1-3'),
    ], wallpaper: [1, 3], pdfs: 6, positions: 5 },
    { id: 14, sources: [
      sourceItem(1401, '20-331.1-3'), sourceItem(1402, '283-391.0'),
    ], wallpaper: [0], pdfs: 1, positions: 2 },
  ];
  for (const fixture of addonCases) {
    const order = orderFixture(fixture.id, fixture.sources);
    order.status = fixture.wallpaper.length ? 'processing' : 'received';
    const lines = fixture.sources.map((source, index) => persistedLine(
      order, source, index, fixture.wallpaper.includes(index) ? 'WALLPAPER' : 'ACCESSORY'
    ));
    const renders = await Promise.all(fixture.wallpaper.map((index) => renderFixture({
      order, lineItem: lines[index], jobId: fixture.id * 100 + index,
      plan: buildWallpaperRenderPlan({
        sku: lines[index].sku, outputWidthMm: 3000, outputHeightMm: 2500,
        crop: { left: 0, top: 0, width: 1000, height: 800 },
      }),
    })));
    const input = {
      order, lineItems: [...lines].reverse(),
      jobs: renders.map((render) => render.job),
      artifacts: renders.map((render) => render.artifact), artifactsRoot,
    };
    const ready = await inspectOrderFactoryReadiness(input);
    assert.equal(ready.ready, true, ready.reason);
    assert.equal(input.jobs.length, fixture.wallpaper.length);
    assert.equal(ready.positions.length, fixture.positions);
    assert.deepEqual(ready.positions.map((position) => position.sku),
      lines.flatMap((line) => Array(line.quantity).fill(line.sku)));
    for (const position of ready.positions.filter((p) => p.classification === 'ACCESSORY')) {
      assert.deepEqual(position.panelFiles, []);
      assert.equal(position.jobId, undefined);
      assert.equal(position.artifactId, undefined);
      assert.equal(position.quantity, 1);
    }
    const assembly = await assembleOrderFactoryPackage({
      order, positions: ready.positions, artifactsRoot,
    });
    const xml = await fs.readFile(assembly.xmlPath, 'utf8');
    const xmlPositions = [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)];
    assert.equal(xmlPositions.length, fixture.positions);
    assert.equal(assembly.fileCount, fixture.pdfs + 1);
    assert.equal(assembly.manifest.contents.position_count, fixture.positions);
    assert.equal(assembly.manifest.contents.pdf_count, fixture.pdfs);
    assert.equal(xmlReferences(xml).length, fixture.pdfs);
    for (const [index, position] of ready.positions.entries()) {
      if (position.classification === 'ACCESSORY') {
        assert.equal(xmlPositions[index][1].trim(), '<sku>' + position.sku + '</sku>');
      }
    }
    const files = await resolveFactoryUploadFiles({
      artifact: { manifest_path: assembly.manifestPath, checksum: assembly.xmlChecksum },
      orderPackage: { content_checksum: assembly.contentChecksum }, artifactsRoot,
    });
    assert.equal(files.pdfFiles.length, fixture.pdfs);
    assert.equal(files.xmlFile.fileName, assembly.xmlFileName);
    assert.equal((await assembleOrderFactoryPackage({
      order, positions: ready.positions, artifactsRoot,
    })).recoveredExisting, true);

    const accessoryLine = lines.find((line) => line.classification === 'ACCESSORY');
    assert.equal((await inspectOrderFactoryReadiness({
      ...input, jobs: [...input.jobs, {
        id: 99999, shopify_line_item_id: accessoryLine.shopify_line_item_id,
        sku: accessoryLine.sku, status: 'completed',
      }],
    })).reason, 'accessory_render_job_unexpected');
    assert.equal((await inspectOrderFactoryReadiness({
      ...input, jobs: [...input.jobs, { id: 99998, shopify_line_item_id: 'unmatched' }],
    })).reason, 'order_wallpaper_job_count_mismatch');
    assert.equal((await inspectOrderFactoryReadiness({
      ...input, lineItems: lines.map((line) => ({
        ...line, routing_state: 'factory_blocked',
      })),
    })).ready, false);
    if (renders.length) {
      assert.equal((await inspectOrderFactoryReadiness({
        ...input, jobs: input.jobs.slice(1),
      })).ready, false);
      assert.equal((await inspectOrderFactoryReadiness({
        ...input, jobs: input.jobs.map((job) => ({ ...job, status: 'pending' })),
      })).ready, false);
      assert.equal((await inspectOrderFactoryReadiness({
        ...input, artifacts: [],
      })).ready, false);
    }

    // Exercise actual readiness, assembly, and task creation through recovery.
    // Persistence is stubbed; no DB or FTP connection is made.
    const state = { artifact: null, package: null, task: null };
    let pending;
    let activeConnection;
    let failurePoint;
    let statusWrites = 0;
    let rollbacks = 0;
    function assertTransaction(db) {
      assert.equal(db, activeConnection);
      assert.ok(pending, 'Writes must run before commit');
    }
    const runtime = {
      getConnection: async () => {
        activeConnection = {
          async beginTransaction() {
            pending = structuredClone({ ...state, order });
          },
          async commit() {
            if (failurePoint === 'commit') throw new Error('injected_commit_failure');
            Object.assign(state, {
              artifact: pending.artifact, package: pending.package, task: pending.task,
            });
            Object.assign(order, pending.order);
            pending = null;
          },
          async rollback() { rollbacks += 1; pending = null; },
          release() {},
        };
        return activeConnection;
      },
      findOrderByIdForUpdate: async (id, db) => {
        assertTransaction(db);
        assert.equal(id, order.id);
        return { ...pending.order };
      },
      updateOrderStatus: async (id, status, db) => {
        assertTransaction(db);
        assert.equal(id, order.id);
        assert.equal(status, 'completed');
        assert.ok(pending.package && pending.artifact && pending.task);
        assert.notEqual(order.status, 'completed', 'No status repair is visible before commit');
        pending.order.status = status;
        statusWrites += 1;
        if (failurePoint === 'status') throw new Error('injected_status_failure');
        return { ...pending.order };
      },
      listOrderLineItemsByOrderId: async () => lines,
      listJobsByOrderId: async () => input.jobs,
      listArtifactsByOrderId: async () => input.artifacts,
      findOrderFactoryPackageByOrderId: async () => pending.package,
      findArtifactById: async () => pending.artifact,
      inspectOrderFactoryReadiness: (data) => inspectOrderFactoryReadiness({ ...data, artifactsRoot }),
      assembleOrderFactoryPackage: (data) => assembleOrderFactoryPackage({ ...data, artifactsRoot }),
      createArtifact: async (data, db) => {
        assertTransaction(db);
        return (pending.artifact = {
          id: 5000 + fixture.id, order_id: data.orderId, job_id: data.jobId,
          type: data.type, status: data.status, validation_status: data.validationStatus,
          manifest_path: data.manifestPath, file_name: data.fileName,
        });
      },
      createOrderFactoryPackage: async (data, db) => {
        assertTransaction(db);
        return (pending.package = {
          id: 6000 + fixture.id, order_id: data.orderId, artifact_id: data.artifactId,
          order_number: data.orderNumber, status: data.status,
          manifest_path: data.manifestPath, xml_file_name: data.xmlFileName,
        });
      },
      findFactoryUploadTaskByOrderPackageId: async () => pending.task,
      createFactoryUploadTask: async (data, db) => {
        assertTransaction(db);
        if (failurePoint === 'task') throw new Error('injected_task_failure');
        return (pending.task = {
          id: 7000 + fixture.id, order_id: data.orderId, job_id: data.jobId,
          artifact_id: data.artifactId, order_factory_package_id: data.orderFactoryPackageId,
          shopify_order_id: data.shopifyOrderId, factory_reference: data.factoryReference,
          upload_mode: data.uploadMode, status: data.status,
        });
      },
      logInfo: async () => {}, logWarning: async () => {},
    };
    const config = { FTP_REMOTE_DIR: '/factory', FTP_UPLOAD_TASK_MAX_ATTEMPTS: 3 };
    const recoveryRuntime = {
      listOrdersMissingFactoryPackage: async () => [order.id],
      listOrdersWithPackageMissingFactoryTask: async () => [],
      ensureOrderFactoryPackage: ({ orderId }) => ensureOrderFactoryPackage({ orderId, config, runtime }),
      logInfo: async () => {}, logWarning: async () => {},
      logError: async (entry) => assert.fail(JSON.stringify(entry)),
    };
    const recovery = await reconcileFactoryOrders({ config, runtime: recoveryRuntime });
    assert.equal(recovery.packagesReconciled, 1);
    assert.equal(recovery.tasksReconciled, 1);
    assert.equal(state.task.status, 'pending');
    assert.equal(state.task.job_id, null);
    assert.equal(order.status, 'completed');
    assert.equal(statusWrites, 1);
    const repeatedRecovery = await reconcileFactoryOrders({ config, runtime: recoveryRuntime });
    assert.equal(repeatedRecovery.packagesReconciled, 0);
    assert.equal(repeatedRecovery.tasksReconciled, 0);
    assert.equal(order.status, 'completed');
    assert.equal(statusWrites, 1, 'Already-completed orders need no status write');

    // Reuse repairs the legacy stale status without creating another package/task.
    const savedState = structuredClone(state);
    order.status = fixture.wallpaper.length ? 'processing' : 'received';
    const reused = await ensureOrderFactoryPackage({ orderId: order.id, config, runtime });
    assert.equal(reused.created, false);
    assert.equal(reused.taskCreated, false);
    assert.equal(reused.order.status, 'completed');
    assert.equal(order.status, 'completed');
    assert.deepEqual(state, savedState);

    if (fixture.id === 11) {
      for (const reuse of [false, true]) {
        for (const status of [
          'received', 'validated', 'queued', 'processing', 'artifact_ready',
          'completed', 'manual_review', 'failed', 'factory_received',
          'production_started', 'production_completed', 'ready_for_shipping',
          'shipped', 'cancelled', 'unknown_future_state', null, undefined,
        ]) {
          Object.assign(state, reuse ? structuredClone(savedState) : {
            artifact: null, package: null, task: null,
          });
          order.status = status;
          const writesBefore = statusWrites;
          const run = () => ensureOrderFactoryPackage({ orderId: order.id, config, runtime });
          if (status === 'manual_review') {
            // The existing dispatch gate must still block this order.
            if (reuse) {
              await assert.rejects(run, /manual_review/);
            } else {
              const blocked = await run();
              assert.equal(blocked.disposition, 'not_ready');
              assert.equal(blocked.reason, 'order_requires_manual_review');
            }
          } else {
            const result = await run();
            assert.equal(result.created, !reuse);
            assert.equal(result.order.status, order.status);
          }
          const repairable = ['received', 'validated', 'queued', 'processing', 'artifact_ready'].includes(status);
          assert.equal(order.status, repairable ? 'completed' : status);
          assert.equal(statusWrites - writesBefore, repairable ? 1 : 0);
        }

        // Fail before status repair, during the write, and at commit. Both
        // creation and reuse must roll back the status and all related records.
        for (const point of ['task', 'status', 'commit']) {
          Object.assign(state, reuse ? structuredClone(savedState) : {
            artifact: null, package: null, task: null,
          });
          if (point === 'task') state.task = null;
          order.status = 'received';
          const before = structuredClone({ ...state, order });
          const writesBefore = statusWrites;
          const rollbacksBefore = rollbacks;
          failurePoint = point;
          await assert.rejects(
            ensureOrderFactoryPackage({ orderId: order.id, config, runtime }),
            new RegExp('injected_' + point + '_failure')
          );
          failurePoint = undefined;
          assert.deepEqual({ ...state, order }, before);
          assert.equal(statusWrites - writesBefore, point === 'task' ? 0 : 1);
          assert.equal(rollbacks, rollbacksBefore + 1);
        }
      }
    }
  }
  for (const xml of [
    '<positions></positions>',
    '<positions><position><sku>283-391.0</sku></position><position/></positions>',
    '<positions><position><sku>283-391.0</sku></position><files/></positions>',
    '<positions><position><sku>wallpaper</sku><width>600</width></position></positions>',
    '<positions><position><sku> </sku></position></positions>',
  ]) {
    assert.throws(() => extractPdfFileNamesFromXml(xml), /does not reference any FTP PDF/);
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
