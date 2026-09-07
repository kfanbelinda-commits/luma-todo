(() => {
  const $ = selector => document.querySelector(selector);
  let busy = false;
  let current;
  function paint(value) {
    current = value;
    $('#storagePathText').textContent = value.storagePath;
    $('#inboxPathText').textContent = value.inboxPath || '未选择文件夹';
    $('#inboxEnabledToggle').checked = value.inboxEnabled;
    $('#inboxEnabledToggle').disabled = !value.inboxPath;
    $('#scanInbox').disabled = !value.inboxEnabled;
    $('#closeActionSelect').value = value.closeAction;
    $('#hideButton').title = value.closeAction === 'edge' ? '贴边收起' : '隐藏到托盘';
    $('#hideButton').setAttribute('aria-label', $('#hideButton').title);
    $('#localSettingsStatus').textContent = value.lastImport || '';
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    const controls = ['#chooseStorage', '#chooseInbox', '#scanInbox', '#inboxEnabledToggle', '#closeActionSelect'].map($);
    controls.forEach(el => { el.disabled = true; });
    try { paint(await action()); }
    catch (error) {
      if (current) paint(current);
      $('#localSettingsStatus').textContent = error.message;
      $('.local-settings').open = true;
    } finally {
      busy = false;
      controls.forEach(el => { el.disabled = false; });
      $('#inboxEnabledToggle').disabled = !current?.inboxPath;
      $('#scanInbox').disabled = !current?.inboxEnabled;
    }
  }
  $('#closeActionSelect').addEventListener('change', event => { const closeAction = event.target.value; run(() => window.luma.localConfigure({ closeAction })); });
  $('#inboxEnabledToggle').addEventListener('change', event => { const inboxEnabled = event.target.checked; run(() => window.luma.localConfigure({ inboxEnabled })); });
  $('#chooseInbox').addEventListener('click', () => run(() => window.luma.localChoose('inbox')));
  $('#chooseStorage').addEventListener('click', () => run(async () => {
    await persist();
    await window.LumaLifelog?.flush();
    return window.luma.localChoose('storage');
  }));
  $('#scanInbox').addEventListener('click', () => run(async () => {
    await window.LumaLifelog?.flush();
    const result = await window.luma.localScan();
    if (window.LumaLifelog) {
      await window.LumaLifelog.reload();
      await window.LumaLifelog.renderBoard();
      if (typeof calendarDetailDate === 'string' && calendarDetailDate) await window.LumaLifelog.renderDetail(calendarDetailDate);
    }
    return result;
  }));
  $('#settingsButton').addEventListener('click', () => run(() => window.luma.localStatus()));
  run(() => window.luma.localStatus());
})();
