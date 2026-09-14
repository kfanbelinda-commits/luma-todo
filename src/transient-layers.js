(() => {
  if (window.__lumaTransientLayersBound) return;
  window.__lumaTransientLayersBound = true;

  const style = document.createElement('style');
  style.id = 'lumaTransientLayerDragStyle';
  style.textContent = `
    body.luma-transient-layer-open .drag-region {
      -webkit-app-region: no-drag !important;
    }
  `;
  document.head.appendChild(style);

  function anyTransientLayerOpen() {
    return Boolean(
      document.querySelector('#calendarContextMenu:not(.hidden)')
      || document.querySelector('#taskMenu:not(.hidden)')
      || document.querySelector('#reminderPopover:not(.hidden)')
      || document.querySelector('.time-picker:not([hidden])')
      || document.querySelector('#settingsDialog[open]')
    );
  }

  function syncTransientDragState() {
    document.body?.classList.toggle('luma-transient-layer-open', anyTransientLayerOpen());
  }

  const observer = new MutationObserver(syncTransientDragState);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'hidden', 'open'],
  });

  document.addEventListener('pointerdown', syncTransientDragState, true);
  document.addEventListener('keydown', syncTransientDragState, true);
  window.addEventListener('blur', syncTransientDragState);
  syncTransientDragState();
})();
