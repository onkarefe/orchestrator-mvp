function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isValidCropRatio(cropRatio) {
  if (!cropRatio || typeof cropRatio !== 'object' || Array.isArray(cropRatio)) {
    return false;
  }

  const { x, y, w, h } = cropRatio;

  if (![x, y, w, h].every(isFiniteNumber)) {
    return false;
  }

  return (
    x >= 0 &&
    y >= 0 &&
    w > 0 &&
    h > 0 &&
    x <= 1 &&
    y <= 1 &&
    w <= 1 &&
    h <= 1 &&
    x + w <= 1.000001 &&
    y + h <= 1.000001
  );
}

export default {
  isValidCropRatio,
};
