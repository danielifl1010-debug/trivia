// סיסמת מנחה פשוטה עם עוגייה חתומה
const crypto = require('crypto');

const COOKIE = 'trivia_admin';
const MAX_FAILS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) {
      const k = part.slice(0, i).trim();
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = ''; }
    }
  });
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createAuth({ password, secret }) {
  const enabled = !!password;
  const key = secret || crypto.createHash('sha256').update('trivia-v1:' + (password || '')).digest('hex');
  const token = crypto.createHmac('sha256', key).update('admin-v1:' + (password || '')).digest('hex');
  const fails = new Map(); // ip -> { n, since }

  function isAdminCookieHeader(cookieHeader) {
    if (!enabled) return true;
    const t = parseCookies(cookieHeader)[COOKIE];
    return !!t && safeEqual(t, token);
  }

  function blocked(ip) {
    const f = fails.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > WINDOW_MS) { fails.delete(ip); return false; }
    return f.n >= MAX_FAILS;
  }

  return {
    enabled,
    isAdminCookieHeader,
    middleware(req, res, next) {
      if (isAdminCookieHeader(req.headers.cookie)) return next();
      res.status(401).json({ error: 'נדרשת כניסה עם סיסמה' });
    },
    login(req, res) {
      if (!enabled) return res.json({ ok: true });
      const ip = req.ip || 'x';
      if (blocked(ip)) return res.status(429).json({ error: 'יותר מדי ניסיונות. נסה שוב בעוד רבע שעה' });
      const pw = req.body && typeof req.body.password === 'string' ? req.body.password : '';
      if (!safeEqual(pw, password)) {
        const f = fails.get(ip) || { n: 0, since: Date.now() };
        f.n++; fails.set(ip, f);
        return setTimeout(() => res.status(401).json({ error: 'סיסמה שגויה' }), 400);
      }
      fails.delete(ip);
      const secure = req.secure ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secure}`);
      res.json({ ok: true });
    },
    logout(req, res) {
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      res.json({ ok: true });
    },
  };
}

module.exports = { createAuth, parseCookies };
