import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

export function mmToPt(mm) {
  return (Number(mm) * 72) / 25.4;
}

export async function createPanelPdfBuffer({ masterPath, crop, pageWidthMm, pageHeightMm }) {
  const imageBuffer = await sharp(masterPath, {
    sequentialRead: true,
    limitInputPixels: false,
  })
    .extract(crop)
    .png()
    .toBuffer();

  const pdfDocument = await PDFDocument.create();
  const pageWidthPt = mmToPt(pageWidthMm);
  const pageHeightPt = mmToPt(pageHeightMm);
  const page = pdfDocument.addPage([pageWidthPt, pageHeightPt]);
  const embeddedImage = await pdfDocument.embedPng(imageBuffer);

  page.drawImage(embeddedImage, {
    x: 0,
    y: 0,
    width: pageWidthPt,
    height: pageHeightPt,
  });

  return Buffer.from(await pdfDocument.save());
}

export async function createPanelPdfFile({
  masterPath,
  crop,
  pageWidthMm,
  pageHeightMm,
  outputPath,
}) {
  const pdfBuffer = await createPanelPdfBuffer({
    masterPath,
    crop,
    pageWidthMm,
    pageHeightMm,
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, pdfBuffer);

  return outputPath;
}

export default {
  mmToPt,
  createPanelPdfBuffer,
  createPanelPdfFile,
};
