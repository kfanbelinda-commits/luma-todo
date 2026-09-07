(function bindCnHolidayMarks() {
  const decorated = new WeakSet();

  function markOf(dateKey) {
    return typeof getCnHolidayMark === 'function' ? getCnHolidayMark(dateKey) : null;
  }

  function badgeText(mark) {
    if (typeof cnHolidayBadgeText === 'function') return cnHolidayBadgeText(mark);
    return mark ? (mark.type === 'work' ? '班' : '休') : '';
  }

  function detailText(mark) {
    return typeof cnHolidayDetailLabel === 'function' ? cnHolidayDetailLabel(mark) : '';
  }

  function decorateCell(cell) {
    const key = cell?.dataset?.date;
    if (!key) return;
    const mark = markOf(key);
    cell.classList.toggle('holiday-off', mark?.type === 'off');
    cell.classList.toggle('holiday-work', mark?.type === 'work');

    const number = cell.querySelector('.day-number');
    if (!number) return;

    let heading = number.closest('.day-heading');
    if (!heading) {
      heading = document.createElement('div');
      heading.className = 'day-heading';
      number.replaceWith(heading);
      heading.appendChild(number);
    }

    const festivalName = typeof cnFestivalName === 'function' ? cnFestivalName(key) : '';
    let festival = heading.querySelector('.day-festival');
    if (festivalName) {
      if (!festival) {
        festival = document.createElement('span');
        festival.className = 'day-festival';
        number.after(festival);
      }
      if (festival.textContent !== festivalName) festival.textContent = festivalName;
      if (festival.title !== festivalName) festival.title = festivalName;
    } else festival?.remove();

    const existing = heading.querySelector('.day-holiday');
    if (!mark) {
      existing?.remove();
      return;
    }
    const text = badgeText(mark);
    const title = detailText(mark);
    if (existing
      && existing.classList.contains(`day-holiday-${mark.type}`)
      && existing.textContent === text) {
      if (title && existing.title !== title) existing.title = title;
      if (existing.getAttribute('aria-label') !== title) existing.setAttribute('aria-label', title);
      return;
    }
    existing?.remove();
    const badge = document.createElement('span');
    badge.className = `day-holiday day-holiday-${mark.type}`;
    badge.textContent = text;
    badge.setAttribute('aria-label', title);
    if (title) badge.title = title;
    heading.appendChild(badge);
  }

  function decorateGrid() {
    document.querySelectorAll('#calendarGrid .calendar-day[data-date]').forEach(decorateCell);
  }

  function decorateDetail() {
    const lunarEl = document.querySelector('#calendarDetailLunar');
    if (!lunarEl) return;
    const dateKey = typeof calendarDetailDate === 'string' ? calendarDetailDate : '';
    const mark = dateKey ? markOf(dateKey) : null;
    const holidayLine = detailText(mark);
    const current = lunarEl.textContent || '';
    if (!holidayLine) return;
    if (current.includes(holidayLine)) return;
    lunarEl.textContent = [current, holidayLine].filter(Boolean).join(' · ');
  }

  function decorateAll() {
    decorateGrid();
    decorateDetail();
  }

  function wrap(name) {
    const original = window[name];
    if (typeof original !== 'function') return false;
    if (original.__cnHolidayBound) return true;
    const patched = function patchedHolidayRender() {
      const result = original.apply(this, arguments);
      decorateAll();
      return result;
    };
    patched.__cnHolidayBound = true;
    window[name] = patched;
    return true;
  }

  function wrapKnown() {
    wrap('renderCalendar');
    wrap('renderCalendarDetail');
    wrap('render');
  }

  function watchGrid() {
    const grid = document.querySelector('#calendarGrid');
    if (!grid || decorated.has(grid)) return;
    decorated.add(grid);
    const observer = new MutationObserver(() => {
      wrapKnown();
      decorateAll();
    });
    observer.observe(grid, { childList: true, subtree: true });
  }

  function boot() {
    wrapKnown();
    watchGrid();
    decorateAll();
  }

  boot();
  document.addEventListener('DOMContentLoaded', boot);
  window.addEventListener('load', boot);
  [0, 50, 200, 800, 2000].forEach((ms) => setTimeout(boot, ms));
})();
