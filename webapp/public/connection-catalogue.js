(() => {
  let services=[], loaded=false, loading=false;
  const byId=id=>document.getElementById(id);
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
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
      render(byId('catalogue-search').value);
    }catch(e){byId('catalogue-status').textContent=e.message;byId('catalogue-retry').hidden=false;}finally{loading=false;}
  }
  function render(query='') {
    const list=byId('connection-catalogue-list');list.replaceChildren();
    const q=query.trim().toLowerCase();
    const visible=services.filter(s=>(s.name+' '+s.description).toLowerCase().includes(q));
    visible.sort((a,b)=>Number(b.connected)-Number(a.connected)||a.name.localeCompare(b.name));
    visible.forEach(s=>{
      const row=el('div','catalogue-row');
      const logo=el('img');logo.src=s.logoUrl;logo.alt='';logo.width=28;logo.height=28;
      const copy=el('div','catalogue-copy');copy.append(el('strong','',s.name),el('span','',s.description));
      const button=el('button','catalogue-action',s.connected?'Connected':s.mode==='setup'?'Set up':'Connect');
      button.type='button';button.disabled=s.connected;button.setAttribute('aria-label',button.textContent+' '+s.name);
      button.addEventListener('click',()=>select(s,button));
      if(['mcp','microsoft'].includes(s.mode)&&s.manualMode&&!s.connected){
        const advanced=el('details','catalogue-advanced'),summary=el('summary','','Other setup options');
        const manual=el('button','catalogue-back','Use your own application');manual.type='button';
        manual.onclick=()=>select({...s,mode:s.manualMode},manual);
        advanced.append(summary,manual);copy.append(advanced);
      }
      row.append(logo,copy,button);list.append(row);
    });
    if(!visible.length)list.append(el('p','catalogue-empty','No matching service. You can add another connection below.'));
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
    const box=byId('catalogue-setup');box.replaceChildren();box.hidden=false;
    byId('catalogue-browse').hidden=true;
    const back=el('button','catalogue-back','Back to connections');back.type='button';
    back.onclick=()=>{box.hidden=true;box.replaceChildren();byId('catalogue-browse').hidden=false;byId('catalogue-search').focus();};
    const title=el('h3','', 'Connect '+s.name);title.tabIndex=-1;
    const help=el('p','',s.instruction+' Add the callback address below, then paste its client ID and secret here.');
    const link=el('a','', 'Open '+s.name+' settings');link.href=s.guide;link.target='_blank';link.rel='noopener noreferrer';
    const form=el('form','catalogue-form');
    const callback=el('div','catalogue-callback');
    const callbackLabel=el('span','','Callback address');
    const address=el('code','',s.redirectUri);
    const copy=el('button','catalogue-action','Copy');copy.type='button';
    copy.onclick=async()=>{try{await navigator.clipboard.writeText(s.redirectUri);copy.textContent='Copied';}catch(_){status.textContent='Select and copy the callback address above.';}};
    callback.append(callbackLabel,address,copy);
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
    box.append(back,title,help,link,form);title.focus();
  }
  window.filterConnectionCatalogue=function(query){byId('catalogue-search').value=query;render(query);};
  window.openConnectionCatalogue=function(query){
    const box=byId('connection-catalogue');box.open=true;
    if(typeof query==='string')byId('catalogue-search').value=query;
    if(!loaded)loadCatalogue();else render(byId('catalogue-search').value);
    if(query===undefined){box.scrollIntoView({block:'start',behavior:'smooth'});byId('catalogue-search').focus({preventScroll:true});}
  };
  document.addEventListener('DOMContentLoaded',()=>{
    byId('connection-catalogue').addEventListener('toggle',()=>{if(byId('connection-catalogue').open&&!loaded)loadCatalogue();});
    byId('catalogue-search').addEventListener('input',e=>render(e.target.value));
    byId('catalogue-retry').onclick=()=>{byId('catalogue-retry').hidden=true;loadCatalogue();};
  });
})();

