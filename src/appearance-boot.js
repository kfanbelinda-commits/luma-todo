/* Wires palettes into the existing renderer without rewriting app.js.
   window.luma is provided by preload before these scripts run. */
(function () {
  function applyPalette(palette) {
    const appearance = LumaAppearance.normalize({ palette });
    document.documentElement.dataset.theme = appearance.lightMode ? 'light' : 'dark';
    document.documentElement.dataset.palette = appearance.palette;
    document.querySelectorAll('[name="palette"]').forEach((input) => {
      input.checked = input.value === appearance.palette;
    });
    const toggle = document.querySelector('#lightModeToggle');
    if (toggle) toggle.checked = appearance.lightMode;
    return appearance;
  }

  if (!document.querySelector('#lightModeToggle')) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'lightModeToggle';
    input.hidden = true;
    document.body.appendChild(input);
  }

  const luma = window.luma;
  if (luma && typeof luma.load === 'function') {
    const originalLoad = luma.load.bind(luma);
    luma.load = async () => {
      const state = await originalLoad();
      if (state?.settings) Object.assign(state.settings, LumaAppearance.normalize(state.settings));
      queueMicrotask(() => applyPalette(state?.settings?.palette));
      return state;
    };
  }
  if (luma && typeof luma.save === 'function') {
    const originalSave = luma.save.bind(luma);
    luma.save = async (state) => {
      if (state?.settings) {
        Object.assign(state.settings, LumaAppearance.normalize({
          palette: document.documentElement.dataset.palette || state.settings.palette,
          lightMode: state.settings.lightMode,
        }));
      }
      return originalSave(state);
    };
  }

  document.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'palette' || !input.checked) return;
    const appearance = applyPalette(input.value);
    const toggle = document.querySelector('#lightModeToggle');
    if (toggle && toggle.checked !== appearance.lightMode) {
      toggle.checked = appearance.lightMode;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  window.LumaAppearanceApply = applyPalette;
})();
