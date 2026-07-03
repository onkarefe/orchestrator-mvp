import crypto from 'node:crypto';

import env from '../config/env.js';

function scalarToString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return scalarToString(value[0]);
  }

  const normalized = String(value).trim();

  return normalized || null;
}

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.from(String(right ?? ''), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getBearerToken(authorizationHeader) {
  const authorization = scalarToString(authorizationHeader);
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);

  return bearerMatch ? bearerMatch[1].trim() || null : null;
}

function getPresentedAdminToken(req) {
  return (
    scalarToString(req.get('x-admin-access-token')) ||
    getBearerToken(req.get('authorization'))
  );
}

export function requireAdminAccess(req, res, next) {
  if (!env.ADMIN_ACCESS_ENABLED) {
    next();
    return;
  }

  const configuredToken = String(env.ADMIN_ACCESS_TOKEN ?? '').trim();

  if (!configuredToken) {
    res.status(503).send('Admin access is not configured');
    return;
  }

  const presentedToken = getPresentedAdminToken(req);

  if (!presentedToken) {
    res.set('WWW-Authenticate', 'Bearer realm="Wandini Admin"');
    res.status(401).send('Admin access token required');
    return;
  }

  if (!secureEquals(presentedToken, configuredToken)) {
    res.status(403).send('Admin access denied');
    return;
  }

  next();
}

export default requireAdminAccess;
