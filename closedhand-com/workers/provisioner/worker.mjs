// Separate routing-only service. Never receives account identities or user data.
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function clients(env, request) {
  if (!env.CF_PHONE_API_TOKEN || !env.PHONE_PROVISIONER_SECRET || !env.ADDRESS_HOSTS) throw new Error('Provisioner is not configured');
  async function service(path, body) {
    const r=await request('https://closedhand.com/api/phone-enrollment/jobs/'+path,{
      method:'POST',headers:{Authorization:'Bearer '+env.PHONE_PROVISIONER_SECRET,'Content-Type':'application/json'},
      body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(15000)});
    if(!r.ok) throw new Error('Address job unavailable (HTTP '+r.status+')');
    return r.json();
  }
  async function api(path,method='GET',body) {
    const r=await request('https://api.cloudflare.com/client/v4/'+path,{
      method,headers:{Authorization:'Bearer '+env.CF_PHONE_API_TOKEN,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(15000)});
    const data=await r.json();
    if(!r.ok||!data.success) throw new Error('Provider operation could not be confirmed');
    return data;
  }
  return {service,api};
}
export async function provision(env, request = fetch) {
  const {service,api}=clients(env,request);
  const {job}=await service('lease',{});
  if(!job) return {idle:true};
  if(!uuid.test(job.id)||!uuid.test(job.attempt)||!Number.isInteger(job.port)||job.port<1024||job.port>65535||!validHost(job.hostname)) throw new Error('Invalid routing job');
  const checkpoint=patch=>service('checkpoint',{id:job.id,attempt:job.attempt,...patch});
  try {
    const account='accounts/'+env.CF_ACCOUNT_ID+'/cfd_tunnel';
    const zone='zones/'+env.CF_ZONE_ID+'/dns_records';
    const name='closedhand-v2-'+job.id;
    if(job.revoked) {
      // Reconcile even if revocation raced a timed-out tunnel creation.
      const matches=(await api(account+'?is_deleted=false&name='+encodeURIComponent(name))).result;
      if(!Array.isArray(matches)||matches.length>1) throw new Error('Ambiguous revocation');
      const tunnel=matches[0];
      if(tunnel) {
        if(!uuid.test(tunnel.id)||tunnel.name!==name||(job.tunnelId&&tunnel.id!==job.tunnelId)) throw new Error('Revocation identity mismatch');
        await api(account+'/'+tunnel.id+'/configurations','PUT',{config:{ingress:[{service:'http_status:404'}]}});
        const bytes=crypto.getRandomValues(new Uint8Array(32));
        await api(account+'/'+tunnel.id,'PATCH',{tunnel_secret:btoa(String.fromCharCode(...bytes))});
        await api(account+'/'+tunnel.id+'/connections','DELETE');
      }
      await env.ADDRESS_HOSTS.delete(job.hostname);
      // An address let go (its account deleted, or unused) is taken down
      // completely: its own DNS record, then its tunnel. One moving to
      // another computer keeps both, to be built again for the new one.
      if(job.teardown===true) {
        const found=(await api(zone+'?name='+encodeURIComponent(job.hostname))).result;
        if(!Array.isArray(found)) throw new Error('DNS lookup failed');
        const own=record=>record.name===job.hostname&&record.type==='CNAME'&&/^[a-f0-9-]{36}\.cfargotunnel\.com$/.test(record.content||'')&&
          (record.id===job.dnsId||record.comment==='ClosedHand address '+job.id||(tunnel&&record.content===tunnel.id+'.cfargotunnel.com'));
        for (const record of found) if(own(record)) await api(zone+'/'+record.id,'DELETE');
        if(tunnel) await api(account+'/'+tunnel.id,'DELETE');
      }
      await checkpoint({revoked:true});
      return {revoked:true};
    }
    // Reconcile a timed-out creation by its deterministic name. Never blind-retry POST.
    const found=await api(account+'?is_deleted=false&name='+encodeURIComponent(name));
    if(!Array.isArray(found.result)||found.result.length>1) throw new Error('Ambiguous tunnel');
    let tunnel=found.result[0];
    if(job.tunnelId && tunnel?.id!==job.tunnelId) throw new Error('Tunnel identity changed');
    if(tunnel && (tunnel.name!==name||!uuid.test(tunnel.id)||(tunnel.config_src!=='cloudflare'&&tunnel.remote_config!==true))) throw new Error('Unexpected tunnel');
    const records=await api(zone+'?per_page=1');
    const used=records.result_info?.total_count;
    if(!Number.isInteger(used)||used>=190) throw new Error('DNS capacity reserved');
    if(!tunnel) {
      const tunnels=await api(account+'?is_deleted=false&per_page=1');
      if(!Number.isInteger(tunnels.result_info?.total_count)||tunnels.result_info.total_count>=990) throw new Error('Tunnel capacity reserved');
      await checkpoint({});
      tunnel=(await api(account,'POST',{name,config_src:'cloudflare'})).result;
    }
    if(!uuid.test(tunnel?.id)) throw new Error('Invalid tunnel result');
    await checkpoint({tunnelId:tunnel.id});
    await api(account+'/'+tunnel.id+'/configurations','PUT',{config:{ingress:[{hostname:job.hostname,service:'http://localhost:'+job.port},{service:'http_status:404'}]}});
    await checkpoint({tunnelId:tunnel.id});
    const existing=await api(zone+'?name='+encodeURIComponent(job.hostname));
    if(!Array.isArray(existing.result)||existing.result.length>1) throw new Error('DNS conflict');
    let dns=existing.result[0];
    const target=tunnel.id+'.cfargotunnel.com';
    if(dns && (dns.type!=='CNAME'||dns.content!==target||!dns.proxied||dns.name!==job.hostname)) throw new Error('DNS conflict');
    if(job.dnsId && dns?.id!==job.dnsId) throw new Error('DNS identity changed');
    if(!dns) dns=(await api(zone,'POST',{type:'CNAME',name:job.hostname,content:target,proxied:true,ttl:1,comment:'ClosedHand address '+job.id})).result;
    await checkpoint({tunnelId:tunnel.id,dnsId:dns.id});
    // The binding grants only this registry, without Worker code-edit permission.
    // A name taken back after a rename stops redirecting.
    await env.ADDRESS_HOSTS.delete('moved:'+job.hostname);
    await env.ADDRESS_HOSTS.put(job.hostname,job.id);
    const token=(await api(account+'/'+tunnel.id+'/token')).result;
    await checkpoint({tunnelId:tunnel.id,dnsId:dns.id,token});
    return {ready:true};
  } catch (_) {
    // Do not log provider responses or credentials. An expired lease must not
    // overwrite another attempt, and an uncertain resource is never deleted.
    await checkpoint({error:true}).catch(()=>{});
    return {retry:true};
  }
}
// Renamed addresses. An old name redirects to the new one for thirty days,
// then says it has moved (the edge Worker reads the moved: entry). After
// the thirty days its own route goes and the catch-all record brings
// visitors to the edge Worker instead. Six months after the rename the name
// is released: its entry goes too, and closedhand.com forgets it.
const isTunnelRecord=(record,hostname,dnsId)=>record.name===hostname&&record.type==='CNAME'&&
  /^[a-f0-9-]{36}\.cfargotunnel\.com$/.test(record.content||'')&&
  (dnsId?record.id===dnsId:String(record.comment||'').startsWith('ClosedHand address '));
export async function moveNames(env, request = fetch) {
  const {service,api}=clients(env,request);
  const {moves}=await service('moves',{});
  const zone='zones/'+env.CF_ZONE_ID+'/dns_records';
  // An old name's own route, unless it was taken back and routed again.
  async function removeRoute(move) {
    if(await env.ADDRESS_HOSTS.get(move.hostname)) return;
    const found=(await api(zone+'?name='+encodeURIComponent(move.hostname))).result;
    if(!Array.isArray(found)) throw new Error('DNS lookup failed');
    for (const record of found) if(isTunnelRecord(record,move.hostname,move.dnsId)) await api(zone+'/'+record.id,'DELETE');
  }
  let done=0;
  for (const move of Array.isArray(moves)?moves:[]) {
    if(!validHost(move?.hostname)) continue;
    try {
      if(move.release===true) {
        await removeRoute(move);
        await env.ADDRESS_HOSTS.delete('moved:'+move.hostname);
        await service('moves/done',{hostname:move.hostname,released:true});
      } else if(move.remove===true) {
        await removeRoute(move);
        await service('moves/done',{hostname:move.hostname,removed:true});
      } else {
        if(!validHost(move.to)||!Number.isFinite(Date.parse(move.until))||!Number.isFinite(Date.parse(move.release))) continue;
        await env.ADDRESS_HOSTS.put('moved:'+move.hostname,JSON.stringify({to:move.to,until:move.until,release:move.release}));
        await env.ADDRESS_HOSTS.delete(move.hostname);
        await service('moves/done',{hostname:move.hostname,to:move.to});
      }
      done++;
    } catch (_) { /* Tried again next minute. */ }
  }
  return {moved:done};
}
// How many DNS records personal URLs use: every one is a Closedhand tunnel
// record. closedhand.com emails its operator past the alert level. Counted
// every fifteen minutes.
export async function countRecords(env, request = fetch) {
  const {service,api}=clients(env,request);
  const zone='zones/'+env.CF_ZONE_ID+'/dns_records';
  let count=0;
  for (let page=1; page<=20; page++) {
    const found=await api(zone+'?type=CNAME&per_page=500&page='+page);
    if(!Array.isArray(found.result)) throw new Error('DNS listing failed');
    count+=found.result.filter(r=>/\.cfargotunnel\.com$/.test(r.content||'')&&String(r.comment||'').startsWith('ClosedHand address ')).length;
    if(page>=(found.result_info?.total_pages||1)) break;
  }
  await service('usage',{dnsRecords:count});
  return {records:count};
}
// When each address's computer was last connected, from Cloudflare's own
// record of its tunnel: now while connected, otherwise when it last went
// quiet. closedhand.com lets an address go after ninety quiet days.
export async function reportSeen(env, request = fetch) {
  const {service,api}=clients(env,request);
  const account='accounts/'+env.CF_ACCOUNT_ID+'/cfd_tunnel';
  const tunnels=[];
  for (let page=1; page<=20; page++) {
    const found=await api(account+'?is_deleted=false&include_prefix=closedhand-v2-&per_page=100&page='+page);
    if(!Array.isArray(found.result)) throw new Error('Tunnel listing failed');
    for (const t of found.result) {
      const address=String(t.name||'').slice('closedhand-v2-'.length);
      if(!t.name?.startsWith('closedhand-v2-')||!uuid.test(address)||!uuid.test(t.id||'')) continue;
      const connected=['healthy','degraded'].includes(t.status);
      const seen=connected?new Date().toISOString():t.conns_inactive_at;
      if(seen&&Number.isFinite(Date.parse(seen))) tunnels.push({address,tunnel:t.id,seen});
    }
    if(found.result.length<100) break;
  }
  const result=await service('seen',{tunnels});
  return {reported:tunnels.length,matched:result.matched};
}
function validHost(host) {
  const reserved=['www','app','api','admin','account','accounts','auth','login','mail','smtp','support','status','cloud','dashboard','closedhand'];
  return typeof host==='string' && /^[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/.test(host) && !reserved.includes(host.split('.')[0]);
}
export default {
  async scheduled(event,env,ctx) {
    const jobs=[provision(env),moveNames(env)];
    const minute=new Date(event.scheduledTime||Date.now()).getUTCMinutes();
    if(minute%15===0) jobs.push(countRecords(env));
    if(minute===30) jobs.push(reportSeen(env));
    ctx.waitUntil(Promise.allSettled(jobs));
  },
  fetch() { return new Response('Not found',{status:404}); },
};
