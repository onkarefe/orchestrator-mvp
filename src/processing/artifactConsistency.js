import fs from 'node:fs/promises';

export const ARTIFACT_VALIDATION_STATUSES = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
});

const MM_TOLERANCE = 0.001;

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sameMm(left, right) {
  return Math.abs(Number(left) - Number(right)) <= MM_TOLERANCE;
}

function pushError(errors, code, details = {}) {
  errors.push({
    code,
    ...details,
  });
}

export async function validateArtifactConsistency({
  xmlFileName,
  xmlFilePath,
  panelFiles,
  fileEntries,
  panelInfo,
  pageWidthMm,
  pageHeightMm,
  manifest = null,
}) {
  const errors = [];
  const warnings = [];
  const checkedAt = new Date().toISOString();
  const safePanelFiles = Array.isArray(panelFiles) ? panelFiles : [];
  const safeFileEntries = Array.isArray(fileEntries) ? fileEntries : [];
  const panelFileNames = new Set(
    safePanelFiles.map((panelFile) => panelFile.fileName)
  );
  const fileEntryNames = new Set(safeFileEntries.map((entry) => entry.name));
  const expectedPanelCount = Number(panelInfo?.panelCount);
  const expectedFileCount = Number.isFinite(expectedPanelCount)
    ? expectedPanelCount + 1
    : null;
  const generatedPdfEntryCount = safeFileEntries.filter((entry) =>
    panelFileNames.has(entry.name)
  ).length;

  if (!xmlFileName) {
    pushError(errors, 'missing_xml_file_name');
  }

  if (!xmlFilePath || !(await fileExists(xmlFilePath))) {
    pushError(errors, 'missing_xml_file', {
      fileName: xmlFileName ?? null,
      filePath: xmlFilePath ?? null,
    });
  }

  if (!fileEntryNames.has(xmlFileName)) {
    pushError(errors, 'xml_missing_from_zip_entries', {
      fileName: xmlFileName ?? null,
    });
  }

  if (!Number.isFinite(expectedPanelCount)) {
    pushError(errors, 'invalid_expected_panel_count', {
      panelCount: panelInfo?.panelCount ?? null,
    });
  } else if (safePanelFiles.length !== expectedPanelCount) {
    pushError(errors, 'panel_count_mismatch', {
      expected: expectedPanelCount,
      actual: safePanelFiles.length,
    });
  }

  if (generatedPdfEntryCount !== safePanelFiles.length) {
    pushError(errors, 'generated_pdf_entry_count_mismatch', {
      expected: safePanelFiles.length,
      actual: generatedPdfEntryCount,
    });
  }

  if (expectedFileCount !== null && safeFileEntries.length !== expectedFileCount) {
    pushError(errors, 'file_entry_count_mismatch', {
      expected: expectedFileCount,
      actual: safeFileEntries.length,
    });
  }

  for (const panelFile of safePanelFiles) {
    const panelEntry = safeFileEntries.find(
      (entry) => entry.name === panelFile.fileName
    );

    if (!panelEntry) {
      pushError(errors, 'panel_missing_from_zip_entries', {
        fileName: panelFile.fileName,
      });
      continue;
    }

    if (!(await fileExists(panelEntry.filePath))) {
      pushError(errors, 'missing_panel_file', {
        fileName: panelFile.fileName,
        filePath: panelEntry.filePath,
      });
    }

    if (!sameMm(panelFile.widthMm, pageWidthMm)) {
      pushError(errors, 'panel_width_mismatch', {
        fileName: panelFile.fileName,
        expected: pageWidthMm,
        actual: panelFile.widthMm,
      });
    }

    if (!sameMm(panelFile.heightMm, pageHeightMm)) {
      pushError(errors, 'panel_height_mismatch', {
        fileName: panelFile.fileName,
        expected: pageHeightMm,
        actual: panelFile.heightMm,
      });
    }
  }

  if (manifest?.contents) {
    if (
      manifest.contents.file_count !== undefined &&
      manifest.contents.file_count !== safeFileEntries.length
    ) {
      pushError(errors, 'manifest_file_count_mismatch', {
        expected: safeFileEntries.length,
        actual: manifest.contents.file_count,
      });
    }

    if (
      manifest.contents.panel_count !== undefined &&
      manifest.contents.panel_count !== safePanelFiles.length
    ) {
      pushError(errors, 'manifest_panel_count_mismatch', {
        expected: safePanelFiles.length,
        actual: manifest.contents.panel_count,
      });
    }
  }

  return {
    ok: errors.length === 0,
    validationStatus:
      errors.length === 0
        ? ARTIFACT_VALIDATION_STATUSES.PASSED
        : ARTIFACT_VALIDATION_STATUSES.FAILED,
    errors,
    warnings,
    checkedAt,
  };
}

export function assertArtifactConsistency(validationResult) {
  if (!validationResult?.ok) {
    const errorCodes = Array.isArray(validationResult?.errors)
      ? validationResult.errors.map((error) => error.code).join(', ')
      : 'unknown_error';
    const error = new Error(
      `Artifact consistency validation failed: ${errorCodes}`
    );

    error.validationResult = validationResult;
    throw error;
  }

  return validationResult;
}

export default {
  ARTIFACT_VALIDATION_STATUSES,
  validateArtifactConsistency,
  assertArtifactConsistency,
};
