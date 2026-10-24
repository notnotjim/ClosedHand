// closedhand.com: the public website, personal URLs and bug report intake
// for copies of Closedhand. It holds no one's mail, files or conversations.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { createSessions, equal } = require('./lib/session');

const PUBLIC = path.join(__dirname, 'public');
// Where Railway's sign-in may be sent back to: a personal URL, or the
// computer running Closedhand, at its root.
function railwayReturn(value) {
  let u;
  try { u = new URL(String(value || '')); } catch (_) { return false; }
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return false;
  if (u.protocol === 'https:') return require('./public/entry-navigation').registeredAddress(u.origin);
  return u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
}

// Pages name their stylesheets, scripts and images with a fingerprint of the
// file (?v=...). A changed file gets a new address, so no copy of the old one,
// in a browser or at Cloudflare, can ever be paired with a new page. That
// happened: Cloudflare keeps these files four hours, and a deploy showed new
// pages with old styling. An unchanged file can then be kept for a year.
const fingerprints = new Map();
function fingerprint(rel) {
  if (!fingerprints.has(rel)) {
    let v = null;
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, rel))).digest('hex').slice(0, 12); } catch (_) {}
    fingerprints.set(rel, v);
  }
  return fingerprints.get(rel);
}
const pages = new Map();
function render(name) {
  if (!pages.has(name)) {
    const html = fs.readFileSync(path.join(__dirname, 'views', name), 'utf8').replace(
      /((?:href|src|data-[a-z]+)=")(\/[^"#?]+\.(?:css|js|png|svg|jpg|webp|ico|mov|webm))"/g,
      (whole, attr, url) => { const v = fingerprint(url.slice(1)); return v ? attr + url + '?v=' + v + '"' : whole; });
    pages.set(name, html);
  }
  return pages.get(name);
}
function page(name) {
  return (req, res) => { res.set('Cache-Control', 'no-cache').type('html').send(render(name)); };
}

// request is the fetch used to reach Google, Microsoft and copies of
// Closedhand; tests pass a stand-in. startMailWorker starts the assistant
// email worker (it does nothing unless email is switched on); tests pass a
// stand-in too.
function createApp({ db, env = process.env, request = fetch, startMailWorker = require('./lib/assistant-mail-worker').start }) {
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
    // Browsers that have seen the site once use HTTPS for it from then on.
    if (baseUrl.startsWith('https://')) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  // Visitors arrive through Cloudflare, which adds a header carrying
  // EDGE_SECRET. A request that goes around Cloudflare could pretend to come
  // from any address and slip past the rate limits, so it is turned away.
  // Railway's health check and the route-building Worker, which carries its
  // own secret, are let through.
  if (env.EDGE_SECRET) {
    app.use((req, res, next) => {
      if (req.path === '/health' || req.path.startsWith('/api/phone-enrollment/jobs/') || equal(req.headers['x-closedhand-edge'], env.EDGE_SECRET)) return next();
      res.status(403).type('text/plain').send('Please open https://closedhand.com');
    });
  }
  // Only bug reports and assistant email replies (which may carry
  // attachments) are large; every other request is small. Polar's webhooks
  // are kept as they came, to check their signature (lib/plus.js).
  app.use('/api/plus/webhook', express.raw({ type: '*/*', limit: '256kb' }));
  app.use('/api/bug-intake', express.json({ limit: '8mb' }));
  app.use('/api/assistant-mail-relay/outbox', express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(PUBLIC, {
    index: false,
    setHeaders(res, file) {
      const v = res.req.query.v, rel = path.relative(PUBLIC, file).split(path.sep).join('/');
      res.set('Cache-Control', v && v === fingerprint(rel) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));

  app.get('/health', (req, res) => res.json({ ok: true }));
  // Browsers and crawlers ask for /favicon.ico whatever a page names.
  app.get('/favicon.ico', (req, res) => res.type('png').sendFile(path.join(PUBLIC, 'favicon.png')));
  // Lets Microsoft confirm closedhand.com publishes these sign-in apps, so
  // its permission screen names closedhand.com.
  app.get('/.well-known/microsoft-identity-association.json', (req, res) => {
    const ids = String(env.MICROSOFT_ASSOCIATED_APP_IDS || env.MICROSOFT_CLIENT_ID || '').split(',').map(s => s.trim())
      .filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id));
    res.json({ associatedApplications: ids.map(applicationId => ({ applicationId })) });
  });
  app.get('/', page('home.html'));
  app.get('/ethos', page('ethos.html'));
  app.get('/architecture', page('architecture.html'));
  app.get('/pcl', page('pcl.html'));
  app.get('/privacy', page('privacy.html'));
  app.get('/terms', page('terms.html'));
  app.get('/open', page('open.html'));
  app.get('/account', page('account.html'));
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
  // Closedhand Managed Models' keys (lib/included-ai.js) and Closedhand+,
  // which continues them (lib/plus.js), shared by the account routes; the
  // maintainer's notices about them (lib/capacity.js, lib/operator-notices.js)
  // reach the maintainer's own Closedhand through those routes too.
  const includedAi = require('./lib/included-ai').create({ db, env, request });
  const plus = require('./lib/plus').create({ db, env, request, includedAi, baseUrl });
  const notices = require('./lib/operator-notices').create({ db, env, request });
  const capacity = require('./lib/capacity').create({ db, env, includedAi, notices });
  require('./lib/addresses').register(app, { db, sessions, secret, baseUrl, env, request, includedAi, plus, notices });
  plus.register(app, { sessions });
  require('./lib/bugs').register(app, { db, secret: env.BUG_RECEIPT_SECRET || secret });
  require('./lib/download-link').register(app, { env, request });
  require('./lib/insights').register(app, { db, sessions, render, env, request });

  // The assistant email relay and the worker that moves its mail through
  // Amazon SES (lib/assistant-mail-*.js). A worker that cannot start leaves
  // the website up and the relay reporting itself unavailable.
  const mailDb = require('./lib/db-driver-pg').createPgClient({ pool: db });
  let mailWorker = null;
  try { mailWorker = startMailWorker(mailDb, env) || null; }
  catch (e) { console.error('[assistant email] The mail worker did not start:', e.message); }
  require('./lib/assistant-mail-relay').createRelay({ db: mailDb, owner: req => sessions.owner(req), secret, env, baseUrl, ready: () => !!mailWorker }).register(app);
  app.get('/assistant-email/confirm', (req, res) => { res.set('Cache-Control', 'no-store').type('html').send(render('assistant-email-confirm.html')); });

  // Railway's sign-in for Go always-on comes back to this one address, the
  // only one Railway knows, and goes straight on to the Closedhand that asked
  // (webapp/railway-move.js): at its personal URL, or on its own computer.
  // Nothing is kept here, and the code is no use without the verifier that
  // stays on that computer.
  app.get('/railway/return', (req, res) => {
    let back = null;
    try { back = JSON.parse(Buffer.from(String(req.query.state || ''), 'base64url').toString('utf8')).b; } catch (_) {}
    // Opened any other way, it is a page like any missing one.
    if (!railwayReturn(back)) return res.status(404).set('Cache-Control', 'no-cache').type('html').send(render('not-found.html'));
    const next = new URL('/api/move/railway/return', back);
    for (const key of ['code', 'state', 'error']) if (typeof req.query[key] === 'string') next.searchParams.set(key, req.query[key]);
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').redirect(next.href);
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((req, res) => res.status(404).set('Cache-Control', 'no-cache').type('html').send(render('not-found.html')));
  // Malformed or oversized requests get a plain answer, never a stack trace.
  app.use((err, req, res, next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error('[closedhand.com]', req.method, req.path, err.message);
    if (res.headersSent) return next(err);
    res.status(status).json({ error: status === 413 ? 'That request is too large.' : status < 500 ? 'That request could not be read.' : 'Something went wrong. Please try again.' });
  });
  // Run hourly: first months that have run out and months carried on past
  // fair use end, keys are brought in line with their subscriptions, the
  // maintainer is told what needs raising, and a notice their computer has
  // not collected for a day goes by email.
  async function hourly() {
    await includedAi.sweep().catch(e => console.error('[included ai] sweep:', e.message));
    await plus.sweep().catch(e => console.error('[plus] sweep:', e.message));
    await capacity.check().catch(e => console.error('[capacity] check:', e.message));
    await notices.emailStale().catch(e => console.error('[operator] notices:', e.message));
  }
  return { app, sessions, plus, hourly, stopMail: () => typeof mailWorker === 'function' && mailWorker() };
}

if (require.main === module) {
  const { connect, migrate } = require('./lib/db');
  (async () => {
    const db = connect();
    await migrate(db);
    const { app, hourly } = createApp({ db });
    setInterval(hourly, 3600000).unref();
    const port = Number(process.env.PORT || 8080);
    app.listen(port, () => console.log(`[closedhand.com] listening on ${port}`));
  })().catch(e => { console.error('[closedhand.com] failed to start:', e.message); process.exit(1); });
}

module.exports = { createApp };
