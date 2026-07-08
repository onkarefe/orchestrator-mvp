import {
  ADMIN_SESSION_COOKIE_NAME,
  authenticateAdminSessionRequest,
  getAdminSessionClearCookieOptions,
  getAdminSessionCookieOptions,
  loginAdminUser,
  logoutAdminSessionRequest,
} from '../../services/AdminAuthService.js';
import {
  clearAdminLoginFailures,
  getAdminLoginRateLimitState,
  recordAdminLoginFailure,
} from '../../middleware/adminLoginRateLimit.js';

const GENERIC_LOGIN_ERROR = 'Invalid username or password.';

function scalarToString(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (Array.isArray(value)) {
    return scalarToString(value[0]);
  }

  return typeof value === 'string' ? value : String(value);
}

function renderLogin(res, { status = 200, error = null } = {}) {
  res.status(status).render('pages/admin-login', {
    title: 'Admin login',
    error,
  });
}

const AdminAuthController = {
  async showLogin(req, res, next) {
    try {
      const session = await authenticateAdminSessionRequest(req);

      if (session) {
        res.redirect('/admin');
        return;
      }

      renderLogin(res);
    } catch (error) {
      next(error);
    }
  },

  async login(req, res, next) {
    const username = scalarToString(req.body?.username).trim();
    const password = scalarToString(req.body?.password);
    const rateLimit = getAdminLoginRateLimitState(req);

    if (rateLimit.limited) {
      res.set('Retry-After', String(rateLimit.retryAfterSeconds));
      renderLogin(res, {
        status: 429,
        error: 'Too many failed login attempts. Try again later.',
      });
      return;
    }

    try {
      const result = await loginAdminUser({ username, password });

      if (!result.ok) {
        recordAdminLoginFailure(req);
        renderLogin(res, {
          status: 401,
          error: GENERIC_LOGIN_ERROR,
        });
        return;
      }

      clearAdminLoginFailures(req);
      res.cookie(
        ADMIN_SESSION_COOKIE_NAME,
        result.sessionToken,
        getAdminSessionCookieOptions(result.expiresAt)
      );
      res.redirect('/admin');
    } catch (error) {
      next(error);
    }
  },

  async logout(req, res, next) {
    try {
      await logoutAdminSessionRequest(req);
      res.clearCookie(
        ADMIN_SESSION_COOKIE_NAME,
        getAdminSessionClearCookieOptions()
      );
      res.redirect('/admin/login');
    } catch (error) {
      next(error);
    }
  },
};

export default AdminAuthController;
