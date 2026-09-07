(() => {
  const btn = document.querySelector('button');
  const THRESHOLD = 4;
  let active = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let lastY = 0;

  btn.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    active = true;
    dragging = false;
    startX = event.screenX;
    startY = event.screenY;
    lastY = event.screenY;
    btn.setPointerCapture(event.pointerId);
  });

  btn.addEventListener('pointermove', (event) => {
    if (!active) return;
    const dx = event.screenX - startX;
    const dyTotal = event.screenY - startY;
    if (!dragging && (Math.abs(dx) > THRESHOLD || Math.abs(dyTotal) > THRESHOLD)) dragging = true;
    if (!dragging) return;
    const dy = event.screenY - lastY;
    lastY = event.screenY;
    if (dy) window.lumaEdge.move({ dy });
  });

  function endPointer(event) {
    if (!active) return;
    active = false;
    try { btn.releasePointerCapture(event.pointerId); } catch {}
    if (dragging) window.lumaEdge.move({ dy: 0, persist: true });
    else window.lumaEdge.restore();
  }

  btn.addEventListener('pointerup', endPointer);
  btn.addEventListener('pointercancel', endPointer);
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
})();