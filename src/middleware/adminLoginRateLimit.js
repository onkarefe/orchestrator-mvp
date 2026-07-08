import env from '../config/env.js';

const MAX_TRACKED_KEYS = 1000;
const attemptsByIp = new Map();

function getWindowMs() {
  return env.ADMIN_LOGIN_WINDOW_MINUTES * 60 * 1000;
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function pruneAttempts(now = Date.now()) {
  for (const [key, state] of attemptsByIp.entries()) {
    if (state.expiresAt <= now) {
      attemptsByIp.delete(key);
    }
  }

  if (attemptsByIp.size <= MAX_TRACKED_KEYS) {
    return;
  }

  const sortedEntries = [...attemptsByIp.entries()].sort(
    (left, right) => left[1].expiresAt - right[1].expiresAt
  );
  const deleteCount = attemptsByIp.size - MAX_TRACKED_KEYS;

  for (const [key] of sortedEntries.slice(0, deleteCount)) {
    attemptsByIp.delete(key);
  }
}

export function getAdminLoginRateLimitState(req) {
  const now = Date.now();

  pruneAttempts(now);

  const state = attemptsByIp.get(getClientIp(req));

  if (!state || state.expiresAt <= now) {
    return {
      limited: false,
      retryAfterSeconds: 0,
    };
  }

  if (state.count < env.ADMIN_LOGIN_MAX_ATTEMPTS) {
    return {
      limited: false,
      retryAfterSeconds: 0,
    };
  }

  return {
    limited: true,
    retryAfterSeconds: Math.max(1, Math.ceil((state.expiresAt - now) / 1000)),
  };
}

export function recordAdminLoginFailure(req) {
  const now = Date.now();
  const key = getClientIp(req);
  const existing = attemptsByIp.get(key);

  pruneAttempts(now);

  if (!existing || existing.expiresAt <= now) {
    attemptsByIp.set(key, {
      count: 1,
      expiresAt: now + getWindowMs(),
    });
    pruneAttempts(now);
    return;
  }

  existing.count += 1;
}

export function clearAdminLoginFailures(req) {
  attemptsByIp.delete(getClientIp(req));
}

export default {
  clearAdminLoginFailures,
  getAdminLoginRateLimitState,
  recordAdminLoginFailure,
};
