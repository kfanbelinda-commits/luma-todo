/* Narrow boot for LifeLog and date-detail refinements — does not rewrite app.js. */
(function () {
  function ensureStyle(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }

  function ensureScript(src) {
    if (document.querySelector(`script[src="${src}"]`)) return;
    const script = document.createElement("script");
    script.src = src;
    document.body.appendChild(script);
  }

  function load() {
    ensureStyle("src/lifelog.css");
    ensureStyle("src/calendar-detail-enhance.css");
    ensureScript("src/lifelog.js");
    ensureScript("src/calendar-detail-enhance.js");
  }

  load();
  document.addEventListener("DOMContentLoaded", load);
})();
