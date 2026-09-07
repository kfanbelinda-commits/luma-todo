(function bindCnHolidayMarks() {
  function decorateCell(cell) {
    const key = cell?.dataset?.date;
    const number = cell?.querySelector('.day-number');
    if (!key || !number) return;

    let heading = number.closest('.day-heading');
    if (!heading) {
      heading = document.createElement('div');
      heading.className = 'day-heading';
      number.replaceWith(heading);
      heading.appendChild(number);
    }

    heading.querySelectorAll('.day-holiday').forEach((node) => node.remove());
    const mark = typeof getCnHolidayMark === 'function' ? getCnHolidayMark(key) : null;
    if (!mark) return;

    const badge = document.createElement('span');
    badge.className = `day-holiday day-holiday-${mark.type}`;
    badge.textContent = typeof cnHolidayBadgeText === 'function'
      ? cnHolidayBadgeText(mark)
      : (mark.type === 'work' ? '班' : '休');
    const title = typeof cnHolidayDetailLabel === 'function' ? cnHolidayDetailLabel(mark) : '';
    if (title) badge.title = title;
    heading.appendChild(badge);
  }

  function decorateGrid() {
    document.querySelectorAll('#calendarGrid .calendar-day').forEach(decorateCell);
  }

  function decorateDetail() {
    const lunarEl = document.querySelector('#calendarDetailLunar');
    if (!lunarEl || typeof calendarDetailDate !== 'string' || !calendarDetailDate) return;
    const mark = typeof getCnHolidayMark === 'function' ? getCnHolidayMark(calendarDetailDate) : null;
    const holidayLine = typeof cnHolidayDetailLabel === 'function' ? cnHolidayDetailLabel(mark) : '';
    if (!holidayLine) return;
    const current = lunarEl.textContent || '';
    if (current.includes(holidayLine)) return;
    lunarEl.textContent = [current, holidayLine].filter(Boolean).join(' · ');
  }

  function wrap(name, after) {
    const original = window[name];
    if (typeof original !== 'function' || original.__cnHolidayBound) return;
    const patched = function patchedHolidayRender() {
      const result = original.apply(this, arguments);
      after();
      return result;
    };
    patched.__cnHolidayBound = true;
    window[name] = patched;
  }

  wrap('renderCalendar', decorateGrid);
  wrap('renderCalendarDetail', decorateDetail);
})();
