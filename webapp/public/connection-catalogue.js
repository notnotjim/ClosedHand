(() => {
  let services=[], loaded=false, loading=false;
  const byId=id=>document.getElementById(id);
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  // The web chat's copy icon, and a tick once copied.
  const COPY_ICON='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  const DONE_ICON='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  async function loadCatalogue() {
    if(loading)return;
    loading=true;byId('catalogue-retry').hidden=true;
    byId('catalogue-status').textContent='Loading connections…';
    try {
      const response=await fetch('/api/connection-catalogue',{cache:'no-store'});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||'Could not load connections.');
      services=data.services;loaded=true;
      byId('catalogue-status').textContent='';
      render(query);
    }catch(e){byId('catalogue-status').textContent=e.message;byId('catalogue-retry').hidden=false;}finally{loading=false;}
  }
  // Connected apps live under "Connected"; this list holds the rest, as
  // tiles. The search at the top of the tab narrows it.
  let query='';
  function render(q=query) {
    query=q;
    const list=byId('connection-catalogue-list');list.replaceChildren();
    const term=q.trim().toLowerCase();
    const open=services.filter(s=>!s.connected);
    const visible=open.filter(s=>(s.name+' '+s.description).toLowerCase().includes(term))
      .sort((a,b)=>a.name.localeCompare(b.name));
    visible.forEach(s=>{
      const tile=el('button','catalogue-tile');tile.type='button';tile.title=s.description||'';
      tile.setAttribute('aria-label','Connect '+s.name);
      const logo=el('img');logo.src=s.logoUrl;logo.alt='';logo.width=24;logo.height=24;
      tile.append(logo,el('span','',s.name));
      tile.addEventListener('click',()=>choose(s,tile));
      list.append(tile);
    });
    byId('catalogue-apps-heading').hidden=!visible.length&&!!term;
    if(!visible.length&&!term)list.append(el('p','catalogue-empty',open.length?'':'Every app here is connected.'));
  }
  // An app with a quick route and an own-app route asks which, in its own
  // view; any other goes straight to its route.
  function choose(s,tile){
    if(!(['mcp','microsoft'].includes(s.mode)&&s.manualMode)){select(s,tile);return;}
    const {box,title}=openSetup(s);
    const help=el('p','',s.description||'');
    const quick=el('button','catalogue-action','Connect '+s.name);quick.type='button';
    quick.onclick=()=>{closeSetup();select(s,quick);};
    const own=el('button','catalogue-quiet','Use your own '+s.name+' app instead');own.type='button';
    own.onclick=()=>select({...s,mode:s.manualMode},own);
    const actions=el('div','catalogue-choice');actions.append(quick,own);
    box.append(help,actions);title.focus();
  }
  function closeSetup(){
    const box=byId('catalogue-setup'),mcp=document.querySelector('#connection-catalogue .mcp-hero');
    box.hidden=true;box.replaceChildren();byId('catalogue-browse').hidden=false;if(mcp)mcp.hidden=false;
    byId('mcp-section').classList.remove('setting-up');
  }
  // One connection's setup stands alone: the paste box and the Mac card
  // belong to browsing, and around a form they read as its steps.
  function openSetup(s){
    const box=byId('catalogue-setup'),mcp=document.querySelector('#connection-catalogue .mcp-hero');
    box.replaceChildren();box.hidden=false;byId('mcp-section').classList.add('setting-up');
    byId('catalogue-browse').hidden=true;if(mcp)mcp.hidden=true;
    const back=el('button','catalogue-return');back.type='button';
    back.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';
    back.append('Back to connections');
    back.onclick=()=>{closeSetup();const first=document.querySelector('#connection-catalogue-list .catalogue-tile');if(first)first.focus();};
    const title=el('h3','', 'Connect '+s.name);title.tabIndex=-1;
    box.append(back,title);
    return {box,title};
  }
  async function select(s,button) {
    if(s.mode==='shopify'){window.openShopifyModal();return;}
    if(s.mode==='google'){(window.top||window).location.href='/setup#step-accounts=google';return;}
    if(s.mode==='microsoft'){(window.top||window).location.href='/setup#step-accounts=microsoft';return;}
    if(s.mode==='oauth'){(window.top||window).location.href='/auth/'+s.key+(['google','microsoft'].includes(s.key)?'?extra=1':'');return;}
    if(s.mode==='mcp'){
      byId('mcp-url-input').value=s.url;
      byId('mcp-url-input').scrollIntoView({block:'center',behavior:'smooth'});
      button.disabled=true;
      try{await window.addMcpConnection();}finally{button.disabled=false;}
      return;
    }
    const {box,title}=openSetup(s);
    const help=el('p','',s.instruction+' Add the callback address below, then paste its client ID and secret here.');
    const link=el('a','catalogue-deep','Open '+s.name+' settings');link.href=s.guide;link.target='_blank';link.rel='noopener noreferrer';
    const form=el('form','catalogue-form');
    const callback=el('div','catalogue-callback');
    const callbackLabel=el('span','','Callback address');
    const field=el('div','catalogue-copybox'),address=el('code','',s.redirectUri);
    const copy=el('button','catalogue-copy-btn');copy.type='button';copy.title='Copy';copy.setAttribute('aria-label','Copy callback address');copy.innerHTML=COPY_ICON;
    copy.onclick=async()=>{
      try{
        await navigator.clipboard.writeText(s.redirectUri);
        copy.classList.add('done');copy.innerHTML=DONE_ICON;copy.setAttribute('aria-label','Copied');
        setTimeout(()=>{copy.classList.remove('done');copy.innerHTML=COPY_ICON;copy.setAttribute('aria-label','Copy callback address');},1500);
      }catch(_){status.textContent='Select and copy the callback address above.';}
    };
    field.append(address,copy);callback.append(callbackLabel,field);
    const idLabel=el('label','','Client ID'),id=el('input');id.name='clientId';id.required=true;id.maxLength=4096;id.autocomplete='off';idLabel.append(id);
    const secretLabel=el('label','','Client secret'),secret=el('input');secret.type='password';secret.name='clientSecret';secret.required=true;secret.maxLength=4096;secret.autocomplete='new-password';secretLabel.append(secret);
    const status=el('p','catalogue-status');status.setAttribute('role','status');
    const submit=el('button','catalogue-action','Save and sign in');submit.type='submit';
    form.append(callback);
    if(s.scopes.length){const permissions=el('p','','Enable these permissions in the application: '+s.scopes.join(', ')+'.');form.append(permissions);}
    form.append(idLabel,secretLabel,submit,status);
    form.onsubmit=async event=>{
      event.preventDefault();submit.disabled=true;status.textContent='Saving…';
      try{
        const response=await fetch('/api/connection-catalogue/'+s.key+'/client',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:id.value,clientSecret:secret.value})});
        const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not save. Try again.');
        secret.value='';(window.top||window).location.href=data.redirectUrl;
      }catch(e){status.textContent=e.message;submit.disabled=false;}
    };
    box.append(help,link,form);title.focus();
  }
  // Connections changed (the dashboard reloads its MCP list after any): an
  // app just connected leaves the tiles, one removed comes back.
  window.refreshConnectionCatalogue=function(){if(loaded){loaded=false;loadCatalogue();}};
  window.filterConnectionCatalogue=function(q){if(loaded)render(q||'');else query=q||'';};
  window.openConnectionCatalogue=function(q){
    if(typeof q==='string')query=q;
    if(!loaded)loadCatalogue();else render(query);
    byId('mcp-section').scrollIntoView({block:'start',behavior:'smooth'});
  };
  document.addEventListener('DOMContentLoaded',()=>{
    loadCatalogue();
    byId('catalogue-retry').onclick=()=>{byId('catalogue-retry').hidden=true;loadCatalogue();};
  });
})();

