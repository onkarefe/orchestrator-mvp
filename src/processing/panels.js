export const MAX_PANEL_CM = 70;
export const NATHLOS_SINGLE_PIECE_SKU = '20-331.1-3';

export function computePanelsFromOutputMm(outputWidthMm) {
  if (typeof outputWidthMm !== 'number' || !Number.isFinite(outputWidthMm) || outputWidthMm <= 0) {
    throw new Error('outputWidthMm must be a positive finite number');
  }

  const widthCm = outputWidthMm / 10;
  const panelCount = Math.max(1, Math.ceil(widthCm / MAX_PANEL_CM));
  const panelWidthCm = widthCm / panelCount;

  return {
    widthCm,
    panelCount,
    panelWidthCm,
  };
}

export function buildPanelPixelWidths(totalWidthPx, panelCount) {
  if (!Number.isInteger(totalWidthPx) || totalWidthPx < 1) {
    throw new Error('totalWidthPx must be a positive integer');
  }

  if (!Number.isInteger(panelCount) || panelCount < 1) {
    throw new Error('panelCount must be a positive integer');
  }

  if (panelCount > totalWidthPx) {
    throw new Error('panelCount cannot exceed totalWidthPx');
  }

  const baseWidth = Math.floor(totalWidthPx / panelCount);
  const remainder = totalWidthPx % panelCount;

  return Array.from({ length: panelCount }, (_, index) =>
    baseWidth + (index < remainder ? 1 : 0)
  );
}

export function buildWallpaperRenderPlan({
  sku,
  outputWidthMm,
  outputHeightMm,
  crop,
}) {
  let panelInfo;
  let pageWidthMm;

  if (sku === NATHLOS_SINGLE_PIECE_SKU) {
    if (
      typeof outputWidthMm !== 'number' ||
      !Number.isFinite(outputWidthMm) ||
      outputWidthMm <= 0
    ) {
      throw new Error('outputWidthMm must be a positive finite number');
    }

    const widthCm = outputWidthMm / 10;
    panelInfo = {
      widthCm,
      panelCount: 1,
      panelWidthCm: widthCm,
    };
    pageWidthMm = outputWidthMm;
  } else {
    panelInfo = computePanelsFromOutputMm(outputWidthMm);
    pageWidthMm = panelInfo.panelWidthCm * 10;
  }

  const panelPixelWidths = buildPanelPixelWidths(
    crop.width,
    panelInfo.panelCount
  );
  let panelLeft = crop.left;
  const segments = panelPixelWidths.map((panelWidthPx) => {
    const segment = {
      crop: {
        left: panelLeft,
        top: crop.top,
        width: panelWidthPx,
        height: crop.height,
      },
      pageWidthMm,
      pageHeightMm: outputHeightMm,
    };

    panelLeft += panelWidthPx;

    return segment;
  });

  return {
    panelInfo,
    pageWidthMm,
    pageHeightMm: outputHeightMm,
    segments,
  };
}

export default {
  MAX_PANEL_CM,
  NATHLOS_SINGLE_PIECE_SKU,
  computePanelsFromOutputMm,
  buildPanelPixelWidths,
  buildWallpaperRenderPlan,
};
