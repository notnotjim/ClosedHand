// Connection discovery and per-account OAuth application settings.
// This module never returns a saved secret to the browser.
const { encryptString, decryptString } = require('./crypto-tokens');
const guides = {
  microsoft: ['https://entra.microsoft.com/', 'Register a web application in Microsoft Entra.'],
  notion: ['https://www.notion.so/profile/integrations', 'Create a public connection in Notion.'],
  atlassian: ['https://developer.atlassian.com/console/myapps/', 'Create an OAuth application in Atlassian.'],
  spotify: ['https://developer.spotify.com/dashboard', 'Create an application in Spotify for Developers.'],
  stripe: ['https://dashboard.stripe.com/settings/connect', 'Open your Stripe Connect application settings.'],
  dropbox: ['https://www.dropbox.com/developers/apps', 'Create a scoped application in Dropbox.'],
  meta_ads: ['https://developers.facebook.com/apps/', 'Create a Meta application with Marketing API access.'],
  hubspot: ['https://developers.hubspot.com/', 'Create an OAuth application in HubSpot.'],
  salesforce: ['https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm&type=5', 'Create an external client application in Salesforce.'],
  github: ['https://github.com/settings/developers', 'Create an OAuth application in GitHub.'],
  gitlab: ['https://gitlab.com/-/user_settings/applications', 'Create an application in GitLab.'],
};
const remote = {
  notion: 'https://mcp.notion.com/mcp',
  atlassian: 'https://mcp.atlassian.com/v2/mcp?tools=all',
  stripe: 'https://mcp.stripe.com',
};
function validClient(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);
}
function createCatalogue({db, services, userId, baseUrl}) {
  async function resolve(key, owner) {
    const service=services[key];
    if (!service || !owner || key==='google') return service;
    const {data,error}=await db.from('connection_clients').select('client_id,client_secret').eq('user_id',owner).eq('service',key).maybeSingle();
    if(error) throw new Error('Could not read connection settings.');
    if(!data) return service;
    const secret=decryptString(data.client_secret);
    if(!secret) throw new Error('Could not open saved connection settings. Save them again.');
    return {...service,clientId:data.client_id,clientSecret:secret,personalClient:true};
  }
  function register(app) {
    app.get('/api/connection-catalogue',async(req,res)=>{
      res.set('Cache-Control','no-store');
      const owner=userId(req); if(!owner)return res.status(401).json({error:'Sign in to view connections.'});
      try {
        const [clients,connections,mcps]=await Promise.all([
          db.from('connection_clients').select('service').eq('user_id',owner),
          db.from('connections').select('service').eq('user_id',owner),
          db.from('user_mcps').select('server_url,status').eq('user_id',owner),
        ]);
        if(clients.error||connections.error||mcps.error)throw new Error('Could not load connections. Try again.');
        const own=new Set((clients.data||[]).map(x=>x.service));
        const linked=new Set((connections.data||[]).map(x=>x.service.replace(/^(google|microsoft)_extra_.+$/, '$1')));
        const rows=Object.entries(services).filter(([key,s])=>!s.isChatPlatform).map(([key,s])=>{
          const ready=own.has(key)||!!(s.clientId&&s.clientSecret);
          const url=remote[key];
          const mcpLinked=url&&(mcps.data||[]).some(m=>m.status==='connected'&&m.server_url?.replace(/\/$/,'')===url.replace(/\/$/,''));
          return {key,name:s.name,description:s.description||'',logoUrl:s.logoUrl||'',connected:linked.has(key)||!!mcpLinked,
            mode:s.needsStoreDomain?'shopify':ready?'oauth':url?'mcp':key==='google'?'google':'setup',
            url:!ready&&url?url:null,guide:guides[key]?.[0],instruction:guides[key]?.[1],
            redirectUri:baseUrl+'/auth/'+key+'/callback',scopes:s.scopes||[],personalClient:own.has(key)};
        });
        res.json({services:rows});
      } catch(e){res.status(503).json({error:e.message});}
    });
    app.put('/api/connection-catalogue/:service/client',async(req,res)=>{
      const owner=userId(req); if(!owner)return res.status(401).json({error:'Sign in to set up a connection.'});
      const key=req.params.service, service=services[key];
      if(!service||!guides[key])return res.status(400).json({error:'Use this service’s existing setup.'});
      const {clientId,clientSecret}=req.body||{};
      if(!validClient(clientId)||!validClient(clientSecret))return res.status(400).json({error:'Enter the client ID and client secret from your application.'});
      try{
        const encrypted=encryptString(clientSecret.trim());
        if(!encrypted.startsWith('enc:v1:'))throw new Error('Encrypted storage is unavailable. Check your installation settings.');
        const {error}=await db.from('connection_clients').upsert({user_id:owner,service:key,client_id:clientId.trim(),client_secret:encrypted,updated_at:new Date().toISOString()},{onConflict:'user_id,service'});
        if(error)throw new Error('Could not save connection settings. Try again.');
        res.json({redirectUrl:'/auth/'+key+(service.isSignup?'?extra=1':'')});
      }catch(e){res.status(503).json({error:e.message});}
    });
  }
  return {resolve,register};
}
module.exports={createCatalogue,validClient};

