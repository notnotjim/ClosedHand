// Microsoft 365's stdio login is separate from the MCP transport connection.
const mcp = require('./mcp-client');
function resultData(result) {
  const text = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}
function deviceCode(data) {
  if (data.error !== 'device_code_required') return null;
  const code = String(data.message || '').match(/\bcode\s+([A-Z0-9]{6,12})\b/i)?.[1];
  if (!code) throw new Error('Microsoft did not provide a sign-in code. Please try again.');
  return { code, url: 'https://microsoft.com/devicelogin' };
}
function register(app, db, userId) {
  const sessions = new Map();
  async function close(key) {
    const session = sessions.get(key); if (!session) return;
    sessions.delete(key); clearTimeout(session.timer);
    await mcp.closeQuietly(session.open.client, session.open.transport);
  }
  app.post('/api/mcps/:id/account/:action', async (req, res) => {
    const owner = userId(req); if (!owner) return res.status(401).json({ error: 'Sign in first.' });
    res.set('Cache-Control', 'no-store');
    const key = owner + ':' + req.params.id;
    try {
      const { data: row, error } = await db.from('user_mcps').select('*').eq('id', req.params.id).eq('user_id', owner).single();
      if (error || !row) return res.status(404).json({ error: 'Connection not found.' });
      if (!mcp.isSelfHost() || !mcp.isMicrosoft365(row)) return res.status(400).json({ error: 'This connection does not support Microsoft device sign-in.' });
      if (!['login', 'status'].includes(req.params.action)) return res.status(400).json({ error: 'Unknown sign-in action.' });
      let session = sessions.get(key);
      if (!session) {
        const open = await mcp.openClient(row, { connectTimeoutMs: 180000 });
        session = { open, timer: setTimeout(() => { close(key).catch(() => {}); }, 15 * 60000) };
        session.timer.unref(); sessions.set(key, session);
      }
      const call = async name => resultData(await session.open.client.callTool({ name, arguments: {} }, undefined, { timeout: 30000 }));
      let data;
      if (req.params.action === 'login') {
        if (session.pending) return res.json({ pending: true, ...session.pending });
        data = await call('login');
        const device = deviceCode(data);
        if (device) { session.pending = device; return res.json({ pending: true, ...device }); }
        if (data.success !== true) throw new Error('Microsoft did not start sign-in.');
      } else {
        // verify-login may wait for an unfinished device flow. Check the cache
        // first so polling cannot time out and kill that flow's process.
        const cached = await call('list-accounts');
        if (!(cached.accounts || []).length) return res.json({ pending: true });
        data = await call('verify-login');
      }
      if (data.success !== true) {
        const cleared = await db.from('user_mcps').update({ caps: { ...row.caps, account_auth: null } }).eq('id', row.id).eq('user_id', owner);
        if (cleared.error) throw new Error('Could not update the sign-in status.');
        return res.json({ pending: true, message: 'Finish signing in with Microsoft, then check again.' });
      }
      const listed = await call('list-accounts');
      const accounts = (listed.accounts || []).map(a => ({ email: String(a.email || '').slice(0, 254), selected: !!a.isDefault })).filter(a => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email));
      if (!accounts.length) throw new Error('Microsoft returned no account identity.');
      const saved = await db.from('user_mcps').update({ caps: { ...row.caps, account_auth: { provider: 'microsoft', accounts, checked_at: new Date().toISOString() } } }).eq('id', row.id).eq('user_id', owner);
      if (saved.error) throw new Error('Could not save the sign-in result. Check again.');
      await close(key);
      res.json({ connected: true, accounts });
    } catch (error) {
      await close(key);
      console.error('[mcp-account] Sign-in failed:', error.name);
      res.status(503).json({ error: 'Microsoft sign-in could not finish. Please try again.' });
    }
  });
}
module.exports = { register, resultData, deviceCode };
