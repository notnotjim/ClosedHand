// Separate routing-only service. Never receives account identities or user data.
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export async function provision(env, request = fetch) {
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
function validHost(host) {
  const reserved=['www','app','api','admin','account','accounts','auth','login','mail','smtp','support','status','cloud','dashboard','closedhand'];
  return typeof host==='string' && /^[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/.test(host) && !reserved.includes(host.split('.')[0]);
}
export default {
  async scheduled(_event,env,ctx) { ctx.waitUntil(provision(env)); },
  fetch() { return new Response('Not found',{status:404}); },
};
