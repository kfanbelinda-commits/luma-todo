(() => {
  'use strict';
  let plugins = [], signature = '', generation = 0, panelRequest = 0;
  let hooks = {}, active = null;
  const marks = new Map(), loaded = new Set(), requests = new Map(), settingsRoots = new Map();
  const dialog = document.querySelector('#privateExtensionDialog');
  const panel = document.querySelector('#privateExtensionPanel').attachShadow({mode:'open'});
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const report = error => {document.querySelector('#privateExtensionStatus').textContent=error?.message || String(error);};
  const ready = () => plugins.filter(p=>p.apiVersion === 2);

  function paint(root,view) {
    if (!view || typeof view.html !== 'string' || typeof view.css !== 'string') throw new Error('扩展界面不可用');
    const template=document.createElement('template');
    template.innerHTML=view.html;
    template.content.querySelectorAll('script,iframe,object,embed,link,meta,base,form').forEach(n=>n.remove());
    for(const node of template.content.querySelectorAll('*')) {
      for(const attribute of [...node.attributes]) {
        if (/^on/i.test(attribute.name) || /^(src|srcset|href|action|formaction|autofocus)$/i.test(attribute.name)) node.removeAttribute(attribute.name);
      }
      if(node.tagName === 'BUTTON') node.type='button';
    }
    const style=document.createElement('style'); style.textContent=view.css;
    root.replaceChildren(style,template.content);
  }
  function close() {active=null;panelRequest++;if(dialog.open)dialog.close();panel.replaceChildren();}
  dialog.addEventListener('close',()=>{active=null;panelRequest++;});
  document.querySelector('#closePrivateExtension').addEventListener('click',close);
  async function renderPanel(args) {
    if(!active)return;
    const id=active.id, request=++panelRequest;
    try {
      const context=hooks.context?.(args.dateKey) || {};
      const view=await window.luma.privateExtensionPanel(id,{...context,...args});
      if(request !== panelRequest || active?.id !== id)return;
      paint(panel,view);
      document.querySelector('#closePrivateExtension').hidden=Boolean(panel.querySelector('[data-extension-action="close"]'));
      active.args={...args,...view.state};
      dialog.setAttribute('aria-label',view.title || '私人扩展');
      dialog.style.width=Math.min(800,Math.max(280,Number(view.width)||520))+'px';
    } catch(error) {if(request === panelRequest){panel.textContent=error?.message || '无法打开扩展';}}
  }
  async function open(id,dateKey) {
    active={id,args:{dateKey}};
    panel.textContent='正在读取…';
    document.querySelector('#closePrivateExtension').hidden=false;
    if(!dialog.open)dialog.showModal();
    await renderPanel({dateKey});
  }
  panel.addEventListener('click',async event=>{
    const button=event.target.closest('[data-extension-action]');
    if(!button || !active)return;
    event.preventDefault();
    const action=button.dataset.extensionAction;
    if(action === 'close'){close();return;}
    try {
      if(action === 'render')await renderPanel({...active.args,...JSON.parse(button.dataset.extensionArgs || '{}')});
      if(action === 'shift-date') {
        const date=new Date(active.args.dateKey+'T12:00:00');
        date.setDate(date.getDate()+Math.max(-1,Math.min(1,Number(button.dataset.extensionOffset)||0)));
        const dateKey=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
        hooks.selectDate?.(dateKey);
        await renderPanel({dateKey});
      }
    } catch(error){report(error);}
  });
  async function refreshSettings(results={}) {
    const epoch=generation;
    await Promise.all(ready().filter(p=>p.contributions?.settings).map(async plugin=>{
      const root=settingsRoots.get(plugin.id);
      if(!root)return;
      try {
        const result=results[plugin.id];
        const view=await window.luma.privateExtensionSettings(plugin.id,result?.error ? null : result,result?.error || '');
        if(epoch === generation && root === settingsRoots.get(plugin.id))paint(root,view);
      } catch(error){if(epoch===generation)root.textContent=error?.message || '扩展设置不可用';}
    }));
  }
  function setStatus(status,force=false) {
    plugins=status?.plugins || [];
    const next=JSON.stringify(plugins);
    if(next === signature && !force)return;
    signature=next;generation++;marks.clear();loaded.clear();requests.clear();close();settingsRoots.clear();
    const actions=document.querySelector('#privateExtensionActions');actions.replaceChildren();
    const installed=document.querySelector('#privateExtensionInstalled');installed.replaceChildren();installed.hidden=!plugins.length;
    for(const plugin of plugins) {
      const row=document.createElement('section'), name=document.createElement('strong'), remove=document.createElement('button');
      name.textContent=plugin.name+' '+plugin.version+(plugin.apiVersion === 2 ? '' : '（请安装新版扩展）');
      remove.type='button';remove.className='soft-button';remove.textContent='卸载';
      remove.addEventListener('click',async()=>{try{hooks.status?.(await window.luma.privateExtensionUninstall(plugin.id));}catch(error){report(error);}});
      row.append(name,remove);installed.append(row);
      if(plugin.apiVersion !== 2)continue;
      if(plugin.contributions?.panel) {
        const button=document.createElement('button');button.type='button';button.className='private-extension-day-button';
        button.textContent=plugin.contributions.panel.label;button.title=plugin.contributions.panel.title;
        button.addEventListener('click',()=>open(plugin.id,hooks.date?.()));actions.append(button);
      }
      if(plugin.contributions?.settings) {
        const host=document.createElement('div');row.append(host);const root=host.attachShadow({mode:'open'});settingsRoots.set(plugin.id,root);
        root.addEventListener('click',async event=>{
          const button=event.target.closest('[data-extension-action="sync-calendar"]');if(!button)return;
          event.preventDefault();
          const calendarUrl=root.querySelector('[data-extension-field="calendarUrl"]')?.value;
          if(!calendarUrl){report(new Error('请选择一个单独的 iCloud 日历。'));return;}
          button.disabled=true;
          try{await refreshSettings({[plugin.id]:await window.luma.privateExtensionSyncCalendar(plugin.id,calendarUrl)});}
          catch(error){await refreshSettings({[plugin.id]:{error:error?.message || String(error)}});}
          finally{button.disabled=false;}
        });
      }
    }
    refreshSettings();hooks.refresh?.();
  }
  async function ensureRange(startDate,endDate) {
    const epoch=generation;
    await Promise.all(ready().filter(p=>p.contributions?.dayMarks).map(plugin=>{
      const key=plugin.id+'|'+startDate+'|'+endDate;
      if(loaded.has(key))return;
      if(requests.has(key))return requests.get(key);
      const request=(async()=>{
        try {
          const payload=await window.luma.privateExtensionMarks(plugin.id,{startDate,endDate});
          if(epoch!==generation)return;
          if(!Array.isArray(payload?.marks))throw new Error('扩展未返回日期标记');
          const byDate=marks.get(plugin.id) || new Map();
          for(const date of byDate.keys())if(date>=startDate && date<=endDate)byDate.delete(date);
          for(const mark of payload.marks)if(/^\d{4}-\d{2}-\d{2}$/.test(mark?.dateKey) && mark.dateKey>=startDate && mark.dateKey<=endDate)byDate.set(mark.dateKey,mark);
          marks.set(plugin.id,byDate);loaded.add(key);hooks.refresh?.();
        } catch(error){if(epoch===generation)report(error);}
        finally{if(epoch===generation)requests.delete(key);}
      })();
      requests.set(key,request);return request;
    }));
  }
  const getAll=date=>ready().flatMap(p=>marks.get(p.id)?.has(date)?[marks.get(p.id).get(date)]:[]);
  function badges(date,className,short=false) {
    return getAll(date).map(mark=>{
      const a=mark.appearance || {};
      const color=value=>/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value || '')?value:'inherit';
      const style='--extension-color:'+color(a.color)+';--extension-bg:'+color(a.background)+';--extension-light-color:'+color(a.lightColor || a.color)+';--extension-light-bg:'+color(a.lightBackground || a.background);
      return '<span class="'+className+'" style="'+style+'" title="'+escape(mark.label)+'" aria-label="'+escape(mark.label)+'">'+escape(short?mark.short:mark.label)+'</span>';
    }).join('');
  }
  window.LumaExtensions={configure:value=>{hooks=value;},setStatus,refreshSettings,ensureRange,badges,getAll,open,close};
})();
