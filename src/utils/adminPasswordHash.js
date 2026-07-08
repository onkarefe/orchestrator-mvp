import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

const HASH_ALGORITHM = 'scrypt';
const HASH_VERSION = 'v1';
const KEY_LENGTH = 64;
const SALT_LENGTH = 32;
const SCRYPT_PARAMS = Object.freeze({
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});
const DUMMY_SALT = Buffer.alloc(SALT_LENGTH, 0);

function normalizePasswordInput(password) {
  return typeof password === 'string' ? password : '';
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  try {
    return Buffer.from(String(value), 'base64url');
  } catch {
    return null;
  }
}

function encodeParams(params) {
  return `N=${params.N},r=${params.r},p=${params.p},keylen=${KEY_LENGTH}`;
}

function parseParams(value) {
  const params = {};

  for (const part of String(value).split(',')) {
    const [key, rawValue] = part.split('=');
    const parsed = Number.parseInt(rawValue, 10);

    if (!key || !Number.isFinite(parsed)) {
      return null;
    }

    params[key] = parsed;
  }

  if (
    params.N !== SCRYPT_PARAMS.N ||
    params.r !== SCRYPT_PARAMS.r ||
    params.p !== SCRYPT_PARAMS.p ||
    params.keylen !== KEY_LENGTH
  ) {
    return null;
  }

  return {
    N: params.N,
    r: params.r,
    p: params.p,
    keylen: params.keylen,
    maxmem: SCRYPT_PARAMS.maxmem,
  };
}

function parseStoredHash(storedHash) {
  if (typeof storedHash !== 'string') {
    return null;
  }

  const parts = storedHash.split('$');

  if (
    parts.length !== 5 ||
    parts[0] !== HASH_ALGORITHM ||
    parts[1] !== HASH_VERSION
  ) {
    return null;
  }

  const params = parseParams(parts[2]);
  const salt = decodeBase64Url(parts[3]);
  const digest = decodeBase64Url(parts[4]);

  if (
    !params ||
    !salt ||
    salt.length !== SALT_LENGTH ||
    !digest ||
    digest.length !== KEY_LENGTH
  ) {
    return null;
  }

  return {
    params,
    salt,
    digest,
  };
}

async function derivePasswordHash(password, salt, params = SCRYPT_PARAMS) {
  return scryptAsync(
    normalizePasswordInput(password),
    salt,
    params.keylen ?? KEY_LENGTH,
    {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: params.maxmem,
    }
  );
}

async function runDummyVerification(password) {
  await derivePasswordHash(password, DUMMY_SALT);
  return false;
}

export function validateAdminPasswordStrength(password) {
  const normalizedPassword = normalizePasswordInput(password);

  if (normalizedPassword.length < 12) {
    return {
      ok: false,
      reason: 'Password must be at least 12 characters long.',
    };
  }

  if (normalizedPassword.length > 256) {
    return {
      ok: false,
      reason: 'Password must be 256 characters or fewer.',
    };
  }

  const hasLowercase = /[a-z]/.test(normalizedPassword);
  const hasUppercase = /[A-Z]/.test(normalizedPassword);
  const hasNumber = /\d/.test(normalizedPassword);
  const hasSymbol = /[^A-Za-z0-9]/.test(normalizedPassword);

  if (!hasLowercase || !hasUppercase || !hasNumber || !hasSymbol) {
    return {
      ok: false,
      reason:
        'Password must include lowercase, uppercase, number, and symbol characters.',
    };
  }

  return { ok: true };
}

export async function hashAdminPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const digest = await derivePasswordHash(password, salt);

  return [
    HASH_ALGORITHM,
    HASH_VERSION,
    encodeParams(SCRYPT_PARAMS),
    encodeBase64Url(salt),
    encodeBase64Url(digest),
  ].join('$');
}

export async function verifyAdminPassword(password, storedHash) {
  const parsedHash = parseStoredHash(storedHash);

  if (!parsedHash) {
    return runDummyVerification(password);
  }

  const candidateDigest = await derivePasswordHash(
    password,
    parsedHash.salt,
    parsedHash.params
  );

  if (candidateDigest.length !== parsedHash.digest.length) {
    crypto.timingSafeEqual(candidateDigest, Buffer.alloc(candidateDigest.length));
    return false;
  }

  return crypto.timingSafeEqual(candidateDigest, parsedHash.digest);
}

export default {
  hashAdminPassword,
  validateAdminPasswordStrength,
  verifyAdminPassword,
};
