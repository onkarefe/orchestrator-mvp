import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

import { calculateSafeCrop } from '../src/processing/image.js';
import {
  NATHLOS_SINGLE_PIECE_SKU,
  buildWallpaperRenderPlan,
  computePanelsFromOutputMm,
} from '../src/processing/panels.js';
import { createPanelPdfBuffer, mmToPt } from '../src/processing/pdf.js';
import { buildWallpaperPanelFileName } from '../src/processing/factoryFileNames.js';
import { buildOrderXml } from '../src/processing/xml.js';

const order = {
  raw_payload_json: JSON.stringify({
    id: 7217548394776,
    name: '#TEST',
    shipping_lines: [{ code: 'Standard', title: 'Standard' }],
    shipping_address: {
      name: 'Test User',
      address1: 'Test Street 1',
      address2: '',
      zip: '12345',
      city: 'Berlin',
      country_code: 'DE',
      phone: '123456',
    },
    customer: {
      first_name: 'Test',
      last_name: 'User',
      phone: null,
    },
    line_items: [
      {
        id: 111,
        sku: 'wandini-prod1-b',
      },
    ],
  }),
};

function buildPanelFiles({
  shopifyOrderId,
  sourcePosition = 0,
  panelCount,
  panelWidthMm,
  heightMm,
}) {
  return Array.from({ length: panelCount }, (_, index) => ({
    fileName: buildWallpaperPanelFileName({
      shopifyOrderId,
      sourcePosition,
      panelNumber: index + 1,
    }),
    widthMm: panelWidthMm,
    heightMm,
  }));
}

function assertPanelCase({
  widthMm,
  expectedPanelCount,
  expectedPanelWidthMm,
}) {
  const shopifyOrderId = '7217548394776';
  const orderNumber = `WANDINI-S${shopifyOrderId}`;
  const heightMm = 2000;
  const panelInfo = computePanelsFromOutputMm(widthMm);
  const panelWidthMm = panelInfo.panelWidthCm * 10;
  const panelFiles = buildPanelFiles({
    shopifyOrderId,
    panelCount: panelInfo.panelCount,
    panelWidthMm,
    heightMm,
  });
  const xml = buildOrderXml({
    order,
    shopifyOrderId,
    positions: [
      {
        sku: 'wandini-prod1-b',
        quantity: 27,
        panelFiles,
      },
    ],
  });

  assert.equal(panelInfo.panelCount, expectedPanelCount);
  assert.equal(panelWidthMm, expectedPanelWidthMm);
  assert.equal(panelFiles.length, expectedPanelCount);
  assert.equal((xml.match(/<position>/g) ?? []).length, 1);
  assert.equal((xml.match(/<file type="ftp">/g) ?? []).length, expectedPanelCount);
  assert.ok(
    xml.includes(`<order_number>${orderNumber}</order_number>`)
  );
  assert.ok(!xml.includes('<reference>'));
  assert.ok(xml.includes('<shipping_type>Standard</shipping_type>'));
  assert.ok(xml.includes('<company>Wandini</company>'));
  assert.ok(xml.includes('<street>Rheinstrasse 12</street>'));
  assert.ok(xml.includes('<postcode>41836</postcode>'));
  assert.ok(xml.includes('<city>Hückelhoven</city>'));
  assert.match(xml, new RegExp(`<width unit="mm">${expectedPanelWidthMm}</width>`));
  assert.match(xml, new RegExp(`<height unit="mm">${heightMm}</height>`));
  assert.match(xml, new RegExp(`<variants>${expectedPanelCount}</variants>`));
  assert.equal(
    (xml.match(/<copies_per_variant>1<\/copies_per_variant>/g) ?? []).length,
    1
  );
  assert.ok(!xml.includes('<copies_per_variant>27</copies_per_variant>'));

  return { widthMm, panelCount: panelInfo.panelCount, panelWidthMm };
}

const cases = [
  assertPanelCase({
    widthMm: 5000,
    expectedPanelCount: 8,
    expectedPanelWidthMm: 625,
  }),
  assertPanelCase({
    widthMm: 4725,
    expectedPanelCount: 7,
    expectedPanelWidthMm: 675,
  }),
];

const outputWidthMm = 3000;
const outputHeightMm = 2500;
const cropRatio = { x: 0.13, y: 0.2, w: 0.61, h: 0.55 };
const safeCrop = calculateSafeCrop(
  { width: 1000, height: 800 },
  cropRatio
);
assert.deepEqual(safeCrop, {
  left: 130,
  top: 160,
  width: 610,
  height: 440,
});

const nathlosPlan = buildWallpaperRenderPlan({
  sku: NATHLOS_SINGLE_PIECE_SKU,
  outputWidthMm,
  outputHeightMm,
  crop: safeCrop,
});
assert.equal(nathlosPlan.panelInfo.panelCount, 1);
assert.equal(nathlosPlan.panelInfo.panelWidthCm, 300);
assert.equal(nathlosPlan.segments.length, 1);
assert.deepEqual(nathlosPlan.segments[0], {
  crop: safeCrop,
  pageWidthMm: 3000,
  pageHeightMm: 2500,
});

const normalPlan = buildWallpaperRenderPlan({
  sku: '20-140.1-3',
  outputWidthMm,
  outputHeightMm,
  crop: safeCrop,
});
assert.deepEqual(normalPlan.panelInfo, {
  widthCm: 300,
  panelCount: 5,
  panelWidthCm: 60,
});
assert.equal(normalPlan.segments.length, 5);
assert.deepEqual(normalPlan.segments.map((segment) => segment.pageWidthMm), [
  600,
  600,
  600,
  600,
  600,
]);

for (const fixture of [
  { sku: '20-331.1-30' },
  { sku: '20-331.1' },
  { sku: '331.1-3' },
  { sku: '20-140.1-3', title: 'Nathlos' },
]) {
  const plan = buildWallpaperRenderPlan({
    sku: fixture.sku,
    outputWidthMm,
    outputHeightMm,
    crop: safeCrop,
  });
  assert.equal(plan.panelInfo.panelCount, 5);
  assert.equal(plan.pageWidthMm, 600);
}

const mixedOrderPlans = [
  { sku: NATHLOS_SINGLE_PIECE_SKU, title: 'Nathlos' },
  { sku: '20-140.1-3', title: 'Normal wallpaper' },
].map((lineItem) => ({
  lineItem,
  plan: buildWallpaperRenderPlan({
    sku: lineItem.sku,
    outputWidthMm,
    outputHeightMm,
    crop: safeCrop,
  }),
}));
assert.equal(mixedOrderPlans[0].plan.segments.length, 1);
assert.equal(mixedOrderPlans[1].plan.segments.length, 5);

const mixedOrderXml = buildOrderXml({
  order,
  shopifyOrderId: '7217548394776',
  positions: mixedOrderPlans.map(({ lineItem, plan }, sourcePosition) => ({
    sku: lineItem.sku,
    quantity: 1,
    panelFiles: buildPanelFiles({
      shopifyOrderId: '7217548394776',
      sourcePosition,
      panelCount: plan.panelInfo.panelCount,
      panelWidthMm: plan.pageWidthMm,
      heightMm: plan.pageHeightMm,
    }),
  })),
});
assert.equal((mixedOrderXml.match(/<order>/g) ?? []).length, 1);
assert.equal((mixedOrderXml.match(/<position>/g) ?? []).length, 2);
assert.equal(
  (mixedOrderXml.match(/<file type=\x22ftp\x22>/g) ?? []).length,
  6
);

const masterBuffer = await sharp({
  create: {
    width: 1000,
    height: 800,
    channels: 3,
    background: { r: 20, g: 40, b: 60 },
  },
})
  .png()
  .toBuffer();
const nathlosPdf = await createPanelPdfBuffer({
  masterPath: masterBuffer,
  crop: nathlosPlan.segments[0].crop,
  pageWidthMm: nathlosPlan.segments[0].pageWidthMm,
  pageHeightMm: nathlosPlan.segments[0].pageHeightMm,
});
const nathlosPdfDocument = await PDFDocument.load(nathlosPdf);
assert.equal(nathlosPdfDocument.getPageCount(), 1);
const nathlosPage = nathlosPdfDocument.getPage(0);
assert.ok(Math.abs(nathlosPage.getWidth() - mmToPt(3000)) < 0.001);
assert.ok(Math.abs(nathlosPage.getHeight() - mmToPt(2500)) < 0.001);

const fallbackOnlyOrder = {
  raw_payload_json: {
    id: 7217548394776,
    billing_address:
      JSON.parse(order.raw_payload_json).shipping_address,
  },
};
assert.throws(
  () =>
    buildOrderXml({
      order: fallbackOnlyOrder,
      shopifyOrderId: '7217548394776',
      positions: [
        {
          sku: 'wandini-prod1-b',
          quantity: 1,
          panelFiles: buildPanelFiles({
            shopifyOrderId: '7217548394776',
            panelCount: 1,
            panelWidthMm: 500,
            heightMm: 2000,
          }),
        },
      ],
    }),
  /missing_shipping_address/
);

const quantityOneXml = buildOrderXml({
  order,
  shopifyOrderId: '7217548394776',
  positions: [
    {
      sku: 'wandini-prod1-b',
      quantity: 1,
      panelFiles: buildPanelFiles({
        shopifyOrderId: '7217548394776',
        panelCount: 1,
        panelWidthMm: 500,
        heightMm: 2000,
      }),
    },
  ],
});
const quantityChangedXml = buildOrderXml({
  order,
  shopifyOrderId: '7217548394776',
  positions: [
    {
      sku: 'wandini-prod1-b',
      quantity: 99,
      panelFiles: buildPanelFiles({
        shopifyOrderId: '7217548394776',
        panelCount: 1,
        panelWidthMm: 500,
        heightMm: 2000,
      }),
    },
  ],
});
assert.match(
  quantityChangedXml,
  /<order_number>WANDINI-S7217548394776<\/order_number>/
);
assert.equal(quantityChangedXml, quantityOneXml);

console.log('xml smoke ok:', cases);
