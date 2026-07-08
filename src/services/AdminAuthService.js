import crypto from 'node:crypto';

import env from '../config/env.js';
import {
  createAdminSession,
  deleteAdminSessionByTokenHash,
  findValidAdminSessionByTokenHash,
} from '../models/AdminSessionModel.js';
import {
  findAdminUserByUsername,
  updateAdminUserLastLoginAt,
} from '../models/AdminUserModel.js';
import { verifyAdminPassword } from '../utils/adminPasswordHash.js';

export const ADMIN_SESSION_COOKIE_NAME = 'wandini_admin_session';

function scalarToString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return scalarToString(value[0]);
  }

  return typeof value === 'string' ? value : String(value);
}

function normalizeUsername(value) {
  return String(scalarToString(value) ?? '').trim();
}

function normalizePassword(value) {
  const normalizedValue = scalarToString(value);

  if (typeof normalizedValue !== 'string') {
    return '';
  }

  return normalizedValue.length <= 4096 ? normalizedValue : '';
}

function getSessionTtlMs() {
  return env.ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000;
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function isPlausibleSessionToken(token) {
  return (
    typeof token === 'string' &&
    token.length >= 32 &&
    token.length <= 256 &&
    /^[A-Za-z0-9_-]+$/.test(token)
  );
}

function parseCookieHeader(cookieHeader) {
  const cookies = new Map();

  for (const part of String(cookieHeader ?? '').split(';')) {
    const separatorIndex = part.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const name = part.slice(0, separatorIndex).trim();
    const rawValue = part.slice(separatorIndex + 1).trim();

    if (!name) {
      continue;
    }

    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      cookies.set(name, rawValue);
    }
  }

  return cookies;
}

export function getAdminSessionCookieOptions(expiresAt = null) {
  const options = {
    httpOnly: true,
    secure: env.ADMIN_COOKIE_SECURE,
    sameSite: 'lax',
    path: '/admin',
    maxAge: getSessionTtlMs(),
  };

  if (expiresAt) {
    options.expires = expiresAt;
  }

  return options;
}

export function getAdminSessionClearCookieOptions() {
  return {
    httpOnly: true,
    secure: env.ADMIN_COOKIE_SECURE,
    sameSite: 'lax',
    path: '/admin',
  };
}

export function getAdminSessionTokenFromRequest(req) {
  const cookies = parseCookieHeader(req.headers?.cookie);
  const token = cookies.get(ADMIN_SESSION_COOKIE_NAME);

  return isPlausibleSessionToken(token) ? token : null;
}

export async function authenticateAdminSessionRequest(req) {
  const token = getAdminSessionTokenFromRequest(req);

  if (!token) {
    return null;
  }

  const tokenHash = hashSessionToken(token);

  return findValidAdminSessionByTokenHash(tokenHash);
}

export async function loginAdminUser({ username, password }) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedPassword = normalizePassword(password);
  const user = normalizedUsername && normalizedUsername.length <= 191
    ? await findAdminUserByUsername(normalizedUsername)
    : null;
  const passwordMatches = await verifyAdminPassword(
    normalizedPassword,
    user?.password_hash
  );

  if (!user || !user.is_active || !passwordMatches) {
    return { ok: false };
  }

  const sessionToken = generateSessionToken();
  const tokenHash = hashSessionToken(sessionToken);
  const expiresAt = new Date(Date.now() + getSessionTtlMs());

  await createAdminSession({
    adminUserId: user.id,
    tokenHash,
    expiresAt,
  });
  await updateAdminUserLastLoginAt(user.id);

  return {
    ok: true,
    sessionToken,
    expiresAt,
    user,
  };
}

export async function logoutAdminSessionRequest(req) {
  const token = getAdminSessionTokenFromRequest(req);

  if (!token) {
    return;
  }

  await deleteAdminSessionByTokenHash(hashSessionToken(token));
}

export default {
  ADMIN_SESSION_COOKIE_NAME,
  authenticateAdminSessionRequest,
  getAdminSessionClearCookieOptions,
  getAdminSessionCookieOptions,
  getAdminSessionTokenFromRequest,
  loginAdminUser,
  logoutAdminSessionRequest,
};
