import crypto from 'node:crypto';

import env from '../config/env.js';
import { authenticateAdminSessionRequest } from '../services/AdminAuthService.js';

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

function isHtmlNavigationRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }

  if (getPresentedAdminToken(req)) {
    return false;
  }

  const acceptHeader = scalarToString(req.get('accept'))?.toLowerCase() ?? '';

  return acceptHeader.includes('text/html');
}

function requireTokenForProgrammaticRequest(res) {
  res.set('WWW-Authenticate', 'Bearer realm="Wandini Admin"');
  res.status(401).send('Admin access token or session required');
}

export async function requireAdminAccess(req, res, next) {
  if (!env.ADMIN_ACCESS_ENABLED) {
    next();
    return;
  }

  const configuredToken = String(env.ADMIN_ACCESS_TOKEN ?? '').trim();
  const presentedToken = getPresentedAdminToken(req);
  let bearerFailureStatus = null;

  if (presentedToken && configuredToken && secureEquals(presentedToken, configuredToken)) {
    req.adminAccess = { method: 'bearer' };
    next();
    return;
  }

  if (presentedToken) {
    bearerFailureStatus = configuredToken ? 403 : 503;
  }

  try {
    const session = await authenticateAdminSessionRequest(req);

    if (session) {
      req.adminAccess = {
        method: 'session',
        session,
        user: session.user,
      };
      next();
      return;
    }
  } catch (error) {
    next(error);
    return;
  }

  if (bearerFailureStatus === 503) {
    res.status(503).send('Admin access token is not configured');
    return;
  }

  if (bearerFailureStatus === 403) {
    res.status(403).send('Admin access denied');
    return;
  }

  if (isHtmlNavigationRequest(req)) {
    res.redirect('/admin/login');
    return;
  }

  requireTokenForProgrammaticRequest(res);
}

export default requireAdminAccess;
