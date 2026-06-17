import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(1);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function getImageMetadata(imagePath) {
  return sharp(imagePath, {
    sequentialRead: true,
    limitInputPixels: false,
  }).metadata();
}

export function calculateSafeCrop(metadata, cropRatio) {
  const imageWidth = Math.floor(metadata?.width ?? 0);
  const imageHeight = Math.floor(metadata?.height ?? 0);

  if (imageWidth < 1 || imageHeight < 1) {
    throw new Error('Image metadata must include positive width and height');
  }

  const left = clamp(Math.round(cropRatio.x * imageWidth), 0, imageWidth - 1);
  const top = clamp(Math.round(cropRatio.y * imageHeight), 0, imageHeight - 1);
  const maxWidth = imageWidth - left;
  const maxHeight = imageHeight - top;
  const width = clamp(Math.round(cropRatio.w * imageWidth), 1, maxWidth);
  const height = clamp(Math.round(cropRatio.h * imageHeight), 1, maxHeight);

  return {
    left,
    top,
    width,
    height,
  };
}

export default {
  getImageMetadata,
  calculateSafeCrop,
};
