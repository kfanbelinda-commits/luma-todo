(function bindCalendarEnhancements() {
  // Holiday marks are rendered by app.js. Keep this post-app hook small and
  // load independent calendar interactions here so app.js stays untouched.
  if (!document.querySelector('script[data-luma-transient-layers]')) {
    const transient = document.createElement('script');
    transient.src = 'src/transient-layers.js';
    transient.dataset.lumaTransientLayers = '1';
    document.body.appendChild(transient);
  }
  if (!document.querySelector('script[data-luma-calendar-context-menu]')) {
    const script = document.createElement('script');
    script.src = 'src/calendar-context-menu.js';
    script.dataset.lumaCalendarContextMenu = '1';
    document.body.appendChild(script);
  }
})();
