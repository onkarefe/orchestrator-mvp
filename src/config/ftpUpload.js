const SUPPORTED_PROTOCOLS = new Set(['ftp', 'ftps']);

export function normalizeFtpProtocol(value) {
  return String(value ?? 'ftp').trim().toLowerCase();
}

export function isSupportedFtpProtocol(value) {
  return SUPPORTED_PROTOCOLS.has(normalizeFtpProtocol(value));
}

export function normalizeFtpRemoteDir(value) {
  const normalized = String(value ?? '').trim().replaceAll('\\', '/');

  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.includes('://') ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    return null;
  }

  const collapsed = normalized.replace(/\/{2,}/g, '/');

  return collapsed.length > 1 ? collapsed.replace(/\/+$/g, '') : collapsed;
}

export function normalizeFtpTempSuffix(value) {
  const normalized = String(value ?? '').trim();

  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.includes('/') ||
    normalized.includes('\\')
  ) {
    return null;
  }

  return normalized;
}

export default {
  isSupportedFtpProtocol,
  normalizeFtpProtocol,
  normalizeFtpRemoteDir,
  normalizeFtpTempSuffix,
};
