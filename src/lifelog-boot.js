/* Narrow boot for Lifelog — does not rewrite app.js. */
(function () {
  function load() {
    if (!document.querySelector('link[href="src/lifelog.css"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "src/lifelog.css";
      document.head.appendChild(link);
    }
    if (!document.querySelector('script[src="src/lifelog.js"]')) {
      const script = document.createElement("script");
      script.src = "src/lifelog.js";
      document.body.appendChild(script);
    }
  }
  load();
  document.addEventListener("DOMContentLoaded", load);
})();
