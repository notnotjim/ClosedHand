// closedhand.com: the public website, personal URLs and bug report intake
// for copies of ClosedHand. It holds no one's mail, files or conversations.
const path = require('node:path');
const express = require('express');
const { createSessions } = require('./lib/session');

function page(name) {
  const file = path.join(__dirname, 'views', name);
  return (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(file); };
}

// request is the fetch used to reach Google, Microsoft and copies of
// ClosedHand; tests pass a stand-in.
function createApp({ db, env = process.env, request = fetch }) {
  const baseUrl = (env.BASE_URL || 'https://closedhand.com').replace(/\/$/, '');
  const secret = env.SESSION_SECRET;
  if (!env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const sessions = createSessions({ secret, secure: baseUrl.startsWith('https://') });

  const app = express();
  app.disable('x-powered-by');
  // Visitors arrive through Cloudflare, then Railway's edge, each adding one
  // X-Forwarded-For entry. Trusting exactly those two hops gives the address
  // Cloudflare saw, which a visitor cannot forge from their side.
  app.set('trust proxy', Number(env.TRUSTED_PROXY_HOPS || 2));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' });
    next();
  });
  // Only bug reports carry screenshots; every other request is small.
  app.use('/api/bug-intake', express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m', index: false }));

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/', page('home.html'));
  app.get('/ethos', page('ethos.html'));
  app.get('/architecture', page('architecture.html'));
  app.get('/privacy', page('privacy.html'));
  app.get('/terms', page('terms.html'));
  app.get('/open', page('open.html'));
  app.get('/phone-access/pair', page('pair.html'));
  // Older links to a dashboard on closedhand.com lead to the finder instead.
  app.get(['/dashboard', '/keep'], (req, res) => {
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect('/open?next=' + encodeURIComponent(req.path + query));
  });

  require('./lib/signin').register(app, {
    db, sessions, baseUrl, request,
    clients: {
      google: { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET },
      microsoft: { id: env.MICROSOFT_CLIENT_ID, secret: env.MICROSOFT_CLIENT_SECRET },
    },
  });
  require('./lib/addresses').register(app, { db, sessions, secret, baseUrl, env, request });
  require('./lib/bugs').register(app, { db, secret: env.BUG_RECEIPT_SECRET || secret });

  // The assistant email relay is not offered yet. Copies ask before showing
  // anything, so "not available" is the whole answer for now.
  app.get('/api/assistant-mail-relay/availability', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ available: false }); });
  app.all('/api/assistant-mail-relay/*', (req, res) => res.status(503).json({ error: 'Email delivery is not available yet.' }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'views', 'not-found.html')));
  // Malformed or oversized requests get a plain answer, never a stack trace.
  app.use((err, req, res, next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error('[closedhand.com]', req.method, req.path, err.message);
    if (res.headersSent) return next(err);
    res.status(status).json({ error: status === 413 ? 'That request is too large.' : status < 500 ? 'That request could not be read.' : 'Something went wrong. Please try again.' });
  });
  return { app, sessions };
}

if (require.main === module) {
  const { connect, migrate } = require('./lib/db');
  (async () => {
    const db = connect();
    await migrate(db);
    const { app } = createApp({ db });
    const port = Number(process.env.PORT || 8080);
    app.listen(port, () => console.log(`[closedhand.com] listening on ${port}`));
  })().catch(e => { console.error('[closedhand.com] failed to start:', e.message); process.exit(1); });
}

module.exports = { createApp };
