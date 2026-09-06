/* Shared by the renderer and migration tests; no storage or Electron access. */
(function (root) {
  const palettes = Object.freeze({
    graphite: { label: 'Graphite', light: false },
    paper: { label: 'Paper', light: true },
    warm: { label: 'Warm', light: true },
    dusk: { label: 'Dusk', light: false },
  });

  function normalize(settings = {}) {
    const palette = Object.hasOwn(palettes, settings.palette)
      ? settings.palette
      : (settings.lightMode ? 'paper' : 'graphite');
    return {
      palette,
      lightMode: palettes[palette].light,
    };
  }

  const appearance = Object.freeze({ palettes, normalize });
  if (typeof module !== 'undefined' && module.exports) module.exports = appearance;
  else root.LumaAppearance = appearance;
})(typeof globalThis !== 'undefined' ? globalThis : this);
