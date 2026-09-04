import assert from 'node:assert/strict';

import { computePanelsFromOutputMm } from '../src/processing/panels.js';
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

function buildPanelFiles({ shopifyOrderId, panelCount, panelWidthMm, heightMm }) {
  return Array.from({ length: panelCount }, (_, index) => ({
    fileName: buildWallpaperPanelFileName({
      shopifyOrderId,
      sourcePosition: 0,
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
        quantity: 1,
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

console.log('xml smoke ok:', cases);
