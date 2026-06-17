import fs from 'node:fs';
import path from 'node:path';

import { ZipArchive } from 'archiver';

export function createZipFromEntries(zipPath, entries) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });

    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    let settled = false;

    function fail(error) {
      if (!settled) {
        settled = true;
        reject(error);
      }
    }

    output.on('close', () => {
      if (!settled) {
        settled = true;
        resolve(zipPath);
      }
    });
    output.on('error', fail);
    archive.on('error', fail);
    archive.on('warning', (error) => {
      if (error.code !== 'ENOENT') {
        fail(error);
      }
    });

    archive.pipe(output);

    for (const entry of entries) {
      archive.append(entry.buffer, { name: entry.name });
    }

    const finalizeResult = archive.finalize();

    if (finalizeResult && typeof finalizeResult.catch === 'function') {
      finalizeResult.catch(fail);
    }
  });
}

export function createZipFromFileEntries(zipPath, entries) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });

    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    let settled = false;

    function fail(error) {
      if (!settled) {
        settled = true;
        reject(error);
      }
    }

    output.on('close', () => {
      if (!settled) {
        settled = true;
        resolve(zipPath);
      }
    });
    output.on('error', fail);
    archive.on('error', fail);
    archive.on('warning', (error) => {
      if (error.code !== 'ENOENT') {
        fail(error);
      }
    });

    archive.pipe(output);

    for (const entry of entries) {
      archive.file(entry.filePath, { name: entry.name });
    }

    const finalizeResult = archive.finalize();

    if (finalizeResult && typeof finalizeResult.catch === 'function') {
      finalizeResult.catch(fail);
    }
  });
}

export default {
  createZipFromEntries,
  createZipFromFileEntries,
};
