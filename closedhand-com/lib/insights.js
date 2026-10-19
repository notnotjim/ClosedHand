// A private page for whoever runs closedhand.com: everything closedhand.com
// already holds for its own work, totals and each person's row, plus GitHub's
// public counts. closedhand.com collects little (see the privacy page), so all
// of it is shown. Anyone not signed in with an email in OPERATOR_EMAILS that
// Google has verified gets the ordinary not-found page, so the page doesn't
// show that it exists.
const REPO = 'notnotjim/ClosedHand';
const INSTALL_SCRIPT = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;
// The route-building Worker stops making personal URLs at this many DNS
// records (see alerts.js).
const DNS_CEILING = 190;
const GITHUB_TTL = 15 * 60000;

function register(app, { db, sessions, render, env = process.env, request = fetch }) {
  const operators = new Set(String(env.OPERATOR_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const limit = Number.parseInt(env.ADDRESS_LIMIT || '100', 10);

  async function isOperator(req) {
    const owner = sessions.owner(req);
    if (!owner || !operators.size) return false;
    const row = (await db.query('SELECT email, email_verified FROM owners WHERE id = $1', [owner])).rows[0];
    return !!row && row.email_verified === true && operators.has(String(row.email || '').toLowerCase());
  }
  const guarded = fn => async (req, res, next) => {
    try {
      if (!(await isOperator(req))) return next();
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
      await fn(req, res);
    } catch (e) {
      console.error('[insights]', e.message);
      if (!res.headersSent) res.status(503).json({ error: 'Could not read the numbers. Try again.' });
    }
  };

  // The short install command, curl -fsSL https://closedhand.com/install | sh.
  // Adds one to today's count (nothing about who asked) and sends curl on to
  // the script in the repository. A count that fails never stops an install.
  app.get('/install', async (req, res) => {
    try {
      await db.query(`INSERT INTO install_fetches (day, fetches) VALUES (current_date, 1)
        ON CONFLICT (day) DO UPDATE SET fetches = install_fetches.fetches + 1`);
    } catch (e) { console.error('[install] Could not count a fetch:', e.message); }
    res.set('Cache-Control', 'no-store').redirect(302, INSTALL_SCRIPT);
  });

  // GitHub's public counts, fetched at most every 15 minutes, so the page
  // stays well inside GitHub's limit for requests without a sign-in.
  let github = null, githubAt = 0;
  async function githubCounts() {
    if (Date.now() - githubAt < GITHUB_TTL) return github;
    githubAt = Date.now();
    try {
      const get = async path => {
        const response = await request('https://api.github.com/repos/' + REPO + path, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'closedhand.com' }, signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('GitHub answered ' + response.status);
        return response.json();
      };
      const [repo, releases] = await Promise.all([get(''), get('/releases?per_page=100')]);
      const mac = releases.filter(r => !r.draft).map(r => ({
        version: r.tag_name,
        downloads: (r.assets || []).filter(a => /\.dmg$/i.test(a.name)).reduce((n, a) => n + (a.download_count || 0), 0),
      }));
      github = { stars: repo.stargazers_count || 0, forks: repo.forks_count || 0, macTotal: mac.reduce((n, r) => n + r.downloads, 0), macLatest: mac[0] || null };
    } catch (e) {
      console.error('[insights] GitHub counts unavailable:', e.message);
      github = null;
    }
    return github;
  }

  async function gather() {
    const one = async sql => (await db.query(sql)).rows[0] || {};
    const accounts = await one(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE provider = 'google')::int AS google,
        count(*) FILTER (WHERE provider = 'microsoft')::int AS microsoft,
        count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
        count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS month
      FROM owners`);
    // Online means the computer running it connected in that time, from the
    // Worker's hourly report of Cloudflare's tunnel records.
    const urls = await one(`SELECT
        count(*) FILTER (WHERE activated_at IS NOT NULL AND state <> 'revoked')::int AS working,
        count(*) FILTER (WHERE activated_at IS NOT NULL AND state <> 'revoked' AND last_seen_at > now() - interval '1 day')::int AS day,
        count(*) FILTER (WHERE activated_at IS NOT NULL AND state <> 'revoked' AND last_seen_at > now() - interval '7 days')::int AS week,
        count(*) FILTER (WHERE activated_at IS NOT NULL AND state <> 'revoked' AND last_seen_at > now() - interval '30 days')::int AS month,
        count(*) FILTER (WHERE activated_at IS NULL AND state IN ('pending', 'provisioning', 'connecting'))::int AS setting_up,
        count(*) FILTER (WHERE state = 'error')::int AS errors,
        count(*) FILTER (WHERE state <> 'revoked' AND (activated_at IS NOT NULL OR created_at > now() - interval '24 hours'))::int AS used
      FROM addresses`);
    const dns = await one("SELECT value FROM service_alerts WHERE name = 'dns-records'");
    const weeks = (await db.query(`SELECT to_char(w, 'YYYY-MM-DD') AS week,
        (SELECT count(*)::int FROM owners WHERE created_at >= w AND created_at < w + interval '7 days') AS accounts,
        (SELECT count(*)::int FROM addresses WHERE activated_at >= w AND activated_at < w + interval '7 days') AS claimed,
        (SELECT coalesce(sum(fetches), 0)::int FROM install_fetches WHERE day >= w::date AND day < (w + interval '7 days')::date) AS installs
      FROM generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') AS w
      ORDER BY w`)).rows;
    const installs = await one('SELECT coalesce(sum(fetches), 0)::int AS total FROM install_fetches');
    const bugs = await one(`SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
        count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week FROM bug_reports`);
    const email = await one(`SELECT
        (SELECT count(*)::int FROM mail_relay_accounts WHERE enabled) AS accounts,
        coalesce(u.sent, 0)::int AS sent, coalesce(u.received, 0)::int AS received
      FROM (SELECT 1) AS x LEFT JOIN mail_relay_usage u
        ON u.owner_key = 'global' AND u.period = date_trunc('month', now() at time zone 'UTC')::date`);
    // Everyone with a Closedhand account, newest first: their sign-in, the
    // personal URL it holds and when its computer last connected, a name held
    // for them, and Closedhand's own email addresses with this month's use.
    const people = (await db.query(`SELECT o.email, o.provider, o.email_verified, o.created_at AS signed_up,
        a.hostname, a.state, a.activated_at AS claimed, a.last_seen_at AS last_online,
        (SELECT h.hostname FROM held_names h WHERE h.owner_id = o.id ORDER BY h.created_at DESC LIMIT 1) AS held_name,
        (SELECT count(*)::int FROM retired_names r WHERE r.owner_id = o.id) AS renames,
        m.addresses AS assistant_email, coalesce(u.sent, 0)::int AS email_sent, coalesce(u.received, 0)::int AS email_received
      FROM owners o
      LEFT JOIN addresses a ON a.owner_id = o.id
      LEFT JOIN LATERAL (SELECT string_agg(address, ', ' ORDER BY created_at) AS addresses, min(owner_email) AS owner_email
        FROM mail_relay_accounts WHERE owner_id = o.id AND enabled) m ON true
      LEFT JOIN mail_relay_usage u ON m.owner_email IS NOT NULL
        AND u.owner_key = encode(sha256(convert_to(lower(m.owner_email), 'UTF8')), 'hex')
        AND u.period = date_trunc('month', now() at time zone 'UTC')::date
      ORDER BY o.created_at DESC LIMIT 2000`)).rows;
    const reports = (await db.query(`SELECT created_at, status, left(comment, 400) AS comment, app_version, platform, resolved_at
      FROM bug_reports ORDER BY created_at DESC LIMIT 50`)).rows;
    return {
      at: new Date().toISOString(),
      people,
      reports,
      accounts,
      urls: { ...urls, limit, dns: dns.value ?? null, dnsCeiling: DNS_CEILING },
      weeks,
      installs: { total: installs.total },
      bugs,
      email,
      github: await githubCounts(),
    };
  }

  app.get('/insights', guarded(async (req, res) => { res.type('html').send(render('insights.html')); }));
  app.get('/api/insights', guarded(async (req, res) => { res.json(await gather()); }));
}

module.exports = { register, INSTALL_SCRIPT };
