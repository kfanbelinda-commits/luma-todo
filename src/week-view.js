/* Week board for Luma. Leaves month rendering in app.js and only
   takes over the calendar panel when the 周 toggle is on. */
(function () {
  const DAY_START = 0;
  const DAY_END = 24;
  const VIEW_START = 8;
  const VIEW_END = 20;
  const HOUR_PX = 44;
  const SNAP = 15;
  const MIN_SPAN = 15;
  const WEEK_TODO_VISIBLE = 2;
  const WEEK_ALLDAY_VISIBLE = 2;
  const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
  function weekLunarParts(date) {
    try {
      const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' }).formatToParts(date);
      const month = parts.find((part) => part.type === 'month')?.value || '';
      const rawDay = parts.find((part) => part.type === 'day')?.value || '';
      const day = /^\d+$/.test(rawDay) && typeof formatChineseLunarDay === 'function'
        ? formatChineseLunarDay(rawDay)
        : (typeof formatLunarDate === 'function'
          ? formatLunarDate(date).replace(/^农历/, '').replace(month, '')
          : rawDay);
      return { month, day, text: `${month}${day}`, isFirst: day === '初一' || rawDay === '1' };
    } catch {
      return { month: '', day: '', text: '', isFirst: false };
    }
  }
  function weekLunarLabel(date, { isMonday = false } = {}) {
    const current = weekLunarParts(date);
    if (!current.text) return '';
    // Monday anchors the week; 初一 marks a lunar month change.
    if (isMonday || current.isFirst) return current.text;
    return current.day || current.text;
  }
  function holidayMark(dateKey) {
    return typeof getCnHolidayMark === 'function' ? getCnHolidayMark(dateKey) : null;
  }
  function holidayDetail(mark) {
    return typeof cnHolidayDetailLabel === 'function' ? cnHolidayDetailLabel(mark) : '';
  }
  function luckyDayMark(dateKey) {
    return window.LumaLuckyDayMarks?.get?.(dateKey) || null;
  }
  function luckyDayBadge(dateKey, className = 'week-luckyday-mark') {
    const mark = luckyDayMark(dateKey);
    if (!mark) return '';
    return `<span class="${className} ${className}-${mark.type}" title="${escapeText(mark.label)}" aria-label="${escapeText(mark.label)}">${escapeText(mark.label)}</span>`;
  }
  function holidayCaption(dateKey) {
    if (typeof cnHolidayWeekCaption === 'function') return cnHolidayWeekCaption(dateKey);
    const mark = holidayMark(dateKey);
    if (!mark) return null;
    const detail = holidayDetail(mark);
    if (mark.type === 'work') {
      const badge = typeof cnHolidayBadgeText === 'function' ? (cnHolidayBadgeText(mark) || '班') : '班';
      return { type: 'work', badge, full: '调休上班', fest: '', detail };
    }
    const prev = parseKey(dateKey);
    prev.setDate(prev.getDate() - 1);
    const previous = holidayMark(toKey(prev));
    const lead = !(previous && previous.type === 'off' && previous.name === mark.name);
    const fest = lead && typeof cnFestivalName === 'function' ? cnFestivalName(mark) : (lead ? String(mark.name || '') : '');
    return { type: 'off', badge: '休', full: fest ? `${fest} · 休` : '休息日', fest, detail };
  }
  function weekHolidaySubline(dateKey, lunar) {
    const caption = holidayCaption(dateKey);
    const lucky = luckyDayBadge(dateKey);
    if (!caption) {
      const lunarText = lunar ? `<span class="week-col-lunar">${lunar}</span>` : '';
      return `<span class="week-col-subline">${lunarText}${lucky}</span>`;
    }
    const title = caption.detail ? ` title="${escapeText(caption.detail)}"` : '';
    const holiday = `<span class="week-col-lunar is-holiday is-holiday-${caption.type}"${title}><span class="week-col-fest">${escapeText(caption.full)}</span><span class="week-col-mark" aria-hidden="true">${escapeText(caption.badge)}</span></span>`;
    return `<span class="week-col-subline">${holiday}${lucky}</span>`;
  }
  let view = 'month';
  let anchorKey = todayKey();
  let drag = null;
  let savedScroll = null;
  let nowTimer = 0;
  function pad(value) { return String(value).padStart(2, '0'); }
  function todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
  function parseKey(key) {
    const [year, month, day] = String(key || todayKey()).split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  function toKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  function mondayOf(date) {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const weekday = day.getDay();
    day.setDate(day.getDate() + (weekday === 0 ? -6 : 1 - weekday));
    return day;
  }
  function weekKeys(fromKey) {
    const start = mondayOf(parseKey(fromKey));
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return toKey(date);
    });
  }
  function minutes(time) {
    const match = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  }
  function formatMinutes(value) {
    const safe = ((value % 1440) + 1440) % 1440;
    return `${pad(Math.floor(safe / 60))}:${pad(safe % 60)}`;
  }
  function snapMinutes(value) { return Math.round(value / SNAP) * SNAP; }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function escapeText(value) {
    return String(value || '').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
  }
  function projectColor(task) {
    if (typeof eventColorFor === 'function' && typeof isCalendarEvent === 'function' && isCalendarEvent(task)) return eventColorFor(task);
    const project = (typeof projectById === 'function' ? projectById(task.projectId) : null);
    return project?.color || '#91a9c7';
  }
  function findTask(id) {
    return (typeof state !== 'undefined' && state.tasks || []).find((item) => item.id === id);
  }
  function isExternal(task) {
    return Boolean(task && (task.googleCalendarExternal || task.syncTarget === 'external-calendar'));
  }
  function canDragTime(task) {
    return Boolean(task && !task.completed && !isExternal(task) && minutes(task.time) != null);
  }
  function nowMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }
  function ensureAssets() {
    if (!document.querySelector('link[href="src/week-view.css"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'src/week-view.css';
      document.head.appendChild(link);
    }
    const controls = document.querySelector('.month-controls');
    if (controls && !controls.querySelector('.calendar-view-switch')) {
      const wrap = document.createElement('div');
      wrap.className = 'calendar-view-switch';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', '日历视图');
      wrap.innerHTML = '<button type="button" class="calendar-view-button" data-calendar-view="month" aria-pressed="true">月</button><button type="button" class="calendar-view-button" data-calendar-view="week" aria-pressed="false">周</button>';
      controls.insertBefore(wrap, controls.firstChild);
    }
  }
  function ensureBoard() {
    let board = document.querySelector('#weekBoard');
    if (!board) {
      board = document.createElement('div');
      board.id = 'weekBoard';
      board.className = 'week-board hidden';
      board.hidden = true;
      document.querySelector('#calendarGrid')?.after(board);
    }
    return board;
  }
  function weekTodoSort(a, b) {
    const aDone = Boolean(a?.completed);
    const bDone = Boolean(b?.completed);
    if (aDone !== bDone) return aDone ? 1 : -1;
    if (!aDone && typeof taskSort === 'function') return taskSort(a, b);
    if (aDone && bDone) return Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0);
    return Number(a?.order || a?.createdAt || 0) - Number(b?.order || b?.createdAt || 0);
  }
  function weekItemsOnDate(key) {
    const tasks = (typeof state !== 'undefined' && Array.isArray(state.tasks)) ? state.tasks : [];
    const todos = [];
    const allDayEvents = [];
    const timedEvents = [];

    tasks.forEach((task) => {
      if (!task) return;
      const calendarEvent = typeof isCalendarEvent === 'function' && isCalendarEvent(task);
      if (!calendarEvent) {
        if ((task.dueDate || task.completedDate) === key) todos.push(task);
        return;
      }
      if (task.completed) return;
      const covers = typeof eventCoversDate === 'function' ? eventCoversDate(task, key) : task.dueDate === key;
      if (!covers) return;
      if (task.time && minutes(task.time) != null) timedEvents.push(task);
      else allDayEvents.push(task);
    });

    todos.sort(weekTodoSort);
    allDayEvents.sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')) || String(a.title || '').localeCompare(String(b.title || '')));
    timedEvents.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')) || String(a.title || '').localeCompare(String(b.title || '')));
    return { todos, allDayEvents, timedEvents };
  }
  function weekTodoMarkup(task, key) {
    const pending = typeof isTaskPendingCompletion === 'function' && isTaskPendingCompletion(task.id);
    const checked = Boolean(task.completed || pending);
    const time = task.time && minutes(task.time) != null ? `<em>${escapeText(task.time)}</em>` : '';
    const title = pending
      ? `${task.title} · 已完成 · 再点方框可撤销`
      : (task.completed ? `${task.title} · 已完成 · 点击方框恢复` : `${task.title} · 待办`);
    return `<div class="week-todo-item${checked ? ' is-checked' : ''}${pending ? ' is-pending' : ''}" data-date="${key}" data-id="${escapeText(task.id)}" style="--todo-color:${projectColor(task)}" title="${escapeText(title)}">`
      + `<button type="button" class="week-todo-check${checked ? ' is-checked' : ''}" data-id="${escapeText(task.id)}" data-date="${key}" aria-label="${checked ? '恢复' : '完成'} ${escapeText(task.title)}"></button>`
      + `<button type="button" class="week-todo-title" data-id="${escapeText(task.id)}" data-date="${key}">${time}<span>${escapeText(task.title)}</span></button>`
      + `</div>`;
  }
  function weekOverflowMarkup(key, hidden, kind) {
    if (hidden <= 0) return '';
    const label = hidden === 1 ? '+1' : `+${hidden}`;
    return `<button type="button" class="week-overflow" data-date="${key}" data-kind="${kind}" aria-label="还有 ${hidden} 项">${label}</button>`;
  }
  function hourLabels() {
    return Array.from({ length: DAY_END - DAY_START }, (_, index) => DAY_START + index);
  }
  function monthKeyBounds(year, month) {
    const startKey = `${year}-${pad(month + 1)}-01`;
    const end = new Date(year, month + 1, 0);
    return { startKey, endKey: toKey(end) };
  }
  function monthTodos(year, month) {
    const { startKey, endKey } = monthKeyBounds(year, month);
    const tasks = (typeof state !== 'undefined' && Array.isArray(state.tasks)) ? state.tasks : [];
    return tasks.filter((task) => {
      if (!task || (typeof isCalendarEvent === 'function' && isCalendarEvent(task))) return false;
      if (!task.dueDate) return false;
      return task.dueDate >= startKey && task.dueDate <= endKey;
    });
  }
  function monthStats(year, month) {
    const items = monthTodos(year, month);
    const today = todayKey();
    const done = items.filter((task) => task.completed);
    const active = items.filter((task) => !task.completed && task.dueDate <= today);
    const upcoming = items.filter((task) => !task.completed && task.dueDate > today);
    const total = items.length;
    const pct = (count) => (total ? `${((count / total) * 100).toFixed(1)}%` : '0%');
    return {
      total,
      rows: [
        { key: 'done', label: '已完成', count: done.length, ratio: pct(done.length), tone: 'done' },
        { key: 'active', label: '进行中', count: active.length, ratio: pct(active.length), tone: 'active' },
        { key: 'upcoming', label: '未开始', count: upcoming.length, ratio: pct(upcoming.length), tone: 'upcoming' },
      ],
      open: items.filter((task) => !task.completed).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)) || String(a.title).localeCompare(String(b.title))),
      notes: done.slice().sort((a, b) => String(b.updatedAt || 0) - String(a.updatedAt || 0)).slice(0, 8),
    };
  }
  function renderMini(host, keys) {
    const focus = parseKey(anchorKey);
    const year = focus.getFullYear();
    const month = focus.getMonth();
    let start = mondayOf(new Date(year, month, 1));
    const focusedWeekStart = mondayOf(parseKey(keys[0]));
    // First grid row is the focused week itself — shift earlier so a prior week stays clickable (bottom already exposes next-month days).
    if (focusedWeekStart.getTime() <= start.getTime()) {
      start = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7);
    }
    const weekSet = new Set(keys);
    const today = todayKey();
    const cells = [];
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = toKey(date);
      const muted = date.getMonth() !== month;
      const mark = holidayMark(key);
      const detail = holidayDetail(mark);
      const holidayClass = mark?.type === 'off' ? ' is-holiday-off' : (mark?.type === 'work' ? ' is-holiday-work' : '');
      const title = detail ? ` title="${escapeText(detail)}"` : '';
      const aria = detail ? ` aria-label="${date.getDate()}日，${escapeText(detail)}"` : '';
      const workdot = mark?.type === 'work' ? '<i class="week-mini-workdot" aria-hidden="true"></i>' : '';
      const lucky = luckyDayMark(key);
      const luckyMini = lucky ? `<i class="week-mini-luckyday week-mini-luckyday-${lucky.type}" aria-hidden="true">${escapeText(lucky.short)}</i>` : '';
      cells.push(`<button type="button" class="week-mini-day${muted ? ' is-muted' : ''}${weekSet.has(key) ? ' is-week' : ''}${key === today ? ' is-today' : ''}${key === anchorKey ? ' is-anchor' : ''}${holidayClass}" data-date="${key}"${title}${aria}>${date.getDate()}${luckyMini}${workdot}</button>`);
    }
    const stats = monthStats(year, month);
    const statRows = stats.rows.map((row) => (
      `<tr class="week-rail-stat is-${row.tone}"><td><i aria-hidden="true"></i></td><td>${row.label}</td><td>${row.count}</td><td>${row.ratio}</td></tr>`
    )).join('');
    const todoItems = stats.open.slice(0, 12).map((task) => (
      `<li class="week-rail-todo" data-id="${escapeText(task.id)}">`
      + `<button type="button" class="week-rail-check" data-id="${escapeText(task.id)}" aria-label="完成待办"></button>`
      + `<button type="button" class="week-rail-todo-title" data-date="${escapeText(task.dueDate || '')}">${escapeText(task.title)}</button>`
      + `</li>`
    )).join('') || '<li class="week-rail-empty">本月暂无待办</li>';
    const noteItems = stats.notes.map((task) => (
      `<li class="week-rail-note"><i class="week-rail-note-dot" aria-hidden="true"></i><span>${escapeText(task.title)}</span></li>`
    )).join('') || '<li class="week-rail-empty">完成待办后会出现在这里</li>';
    host.innerHTML = [
      `<div class="week-rail-top">`
      + `<div class="week-rail-cal">`
      + `<div class="week-mini-weekdays">${WEEKDAY_LABELS.map((label) => `<span>${label}</span>`).join('')}</div>`
      + `<div class="week-mini-grid">${cells.join('')}</div>`
      + `</div></div>`,
      `<div class="week-rail-body">`
      + `<section class="week-rail-section">`
      + `<h3>Stats <em>本月计划统计</em></h3>`
      + `<table class="week-rail-stats"><thead><tr><th></th><th>状态</th><th>数量</th><th>比例</th></tr></thead><tbody>${statRows}`
      + `</tbody></table>`
      + `</section>`
      + `<section class="week-rail-section week-rail-todos">`
      + `<h3>To Do <em>本月待办</em></h3>`
      + `<ul class="week-rail-list">${todoItems}</ul>`
      + `</section>`
      + `<section class="week-rail-section week-rail-notes">`
      + `<h3>Notes <em>本月成果</em></h3>`
      + `<ul class="week-rail-notes-list">${noteItems}</ul>`
      + `</section></div>`
    ].join('');
    host.querySelectorAll('.week-rail-check').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = button.dataset.id;
        if (id && typeof toggleTask === 'function') toggleTask(id).then(() => renderBoard());
      });
    });
    host.querySelectorAll('.week-rail-todo-title').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.date) jumpTo(button.dataset.date);
      });
    });
  }
  function blockMarkup(task, key, rangeStart, rangeMinutes) {
    const begin = minutes(task.time);
    const finish = minutes(task.endTime) ?? (begin + 30);
    const top = ((clamp(begin, rangeStart, rangeStart + rangeMinutes) - rangeStart) / rangeMinutes) * 100;
    const height = Math.max(6, ((clamp(finish, begin + MIN_SPAN, rangeStart + rangeMinutes) - clamp(begin, rangeStart, rangeStart + rangeMinutes)) / rangeMinutes) * 100);
    const draggable = canDragTime(task);
    const handles = draggable ? '<i class="week-handle week-handle-start" data-edge="start"></i><i class="week-handle week-handle-end" data-edge="end"></i>' : '';
    return `<button type="button" class="week-block${draggable ? ' is-draggable' : ''}${isExternal(task) ? ' is-external' : ''}" data-date="${key}" data-id="${escapeText(task.id)}" style="top:${top}%;height:${height}%;--event-color:${projectColor(task)}">${handles}<em>${escapeText(task.time)}</em><span>${escapeText(task.title)}</span></button>`;
  }
  function nowLineMarkup(keys, rangeStart, rangeMinutes) {
    const key = todayKey();
    if (!keys.includes(key)) return '';
    const top = ((nowMinutes() - rangeStart) / rangeMinutes) * 100;
    return `<div class="week-now" data-date="${key}" style="top:${top}%"><span></span></div>`;
  }
  function placeNowLine() {
    const line = document.querySelector('.week-now');
    const days = document.querySelector('.week-days');
    if (!line || !days) return;
    const key = todayKey();
    if (line.dataset.date !== key) { line.remove(); return; }
    const rangeStart = Number(days.dataset.startHour || 0) * 60;
    const rangeMinutes = Number(days.dataset.hours || 24) * 60;
    line.style.top = `${((nowMinutes() - rangeStart) / rangeMinutes) * 100}%`;
    if (line.parentElement !== days) days.appendChild(line);
  }
  function defaultScrollTop() {
    const keys = weekKeys(anchorKey);
    const now = nowMinutes();
    if (keys.includes(todayKey()) && (now < VIEW_START * 60 || now > VIEW_END * 60)) {
      return Math.max(0, (now / 60) * HOUR_PX - HOUR_PX * 2);
    }
    return VIEW_START * HOUR_PX;
  }
  function syncWeekScrollbarGutter() {
    const main = document.querySelector('.week-main');
    const scroll = document.querySelector('.week-scroll');
    if (!main || !scroll) return;
    // Real scrollbar width — guessing 12px is why head/allday vs timed grid keep drifting.
    const width = Math.max(0, scroll.offsetWidth - scroll.clientWidth);
    main.style.setProperty('--week-sb', `${width}px`);
  }
  function restoreScroll(board) {
    const scroll = board.querySelector('.week-scroll');
    if (!scroll) return;
    scroll.scrollTop = savedScroll == null ? defaultScrollTop() : savedScroll;
  }
  function renderBoard() {
    const board = ensureBoard();
    const existing = board.querySelector('.week-scroll');
    if (existing) savedScroll = existing.scrollTop;
    const keys = weekKeys(anchorKey);
    window.LumaLuckyDayMarks?.ensureRange?.(keys[0], keys[6]);
    const start = parseKey(keys[0]);
    const end = parseKey(keys[6]);
    const labels = hourLabels();
    const title = document.querySelector('#monthTitle');
    if (title) {
      const crossYear = start.getFullYear() !== end.getFullYear();
      if (crossYear) {
        title.textContent = `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 – ${end.getFullYear()}年${end.getMonth() + 1}月${end.getDate()}日`;
      } else if (start.getMonth() === end.getMonth()) {
        title.textContent = `${start.getMonth() + 1} 月 ${start.getDate()}–${end.getDate()} 日`;
      } else {
        title.textContent = `${start.getMonth() + 1}月${start.getDate()}日 – ${end.getMonth() + 1}月${end.getDate()}日`;
      }
    }
    const rangeStart = DAY_START * 60;
    const rangeMinutes = (DAY_END - DAY_START) * 60;
    const header = keys.map((key, index) => {
      const date = parseKey(key);
      const dow = date.getDay();
      const weekend = dow === 0 || dow === 6;
      const lunar = weekLunarLabel(date, { isMonday: index === 0 });
      const caption = holidayCaption(key);
      const weekday = WEEKDAY_LABELS[(dow + 6) % 7];
      const sub = weekHolidaySubline(key, lunar);
      const aria = caption?.detail ? ` aria-label="${date.getDate()} 周${weekday}，${escapeText(caption.detail)}"` : '';
      return `<button type="button" class="week-col-head${key === todayKey() ? ' is-today' : ''}${weekend ? ' is-weekend' : ''}" data-date="${key}"${aria}><span class="week-col-primary"><strong>${date.getDate()}</strong> 周${weekday}</span>${sub}</button>`;
    }).join('');
    const todoCols = keys.map((key) => {
      const items = weekItemsOnDate(key).todos;
      const visible = items.slice(0, WEEK_TODO_VISIBLE).map((task) => weekTodoMarkup(task, key)).join('');
      const overflow = weekOverflowMarkup(key, Math.max(0, items.length - WEEK_TODO_VISIBLE), 'todo');
      return `<div class="week-todo-col" data-date="${key}">${visible}${overflow}</div>`;
    }).join('');
    const allDayCols = keys.map((key) => {
      const items = weekItemsOnDate(key).allDayEvents;
      const chips = items.slice(0, WEEK_ALLDAY_VISIBLE).map((task) => `<button type="button" class="week-chip" data-date="${key}" data-id="${escapeText(task.id)}" style="--event-color:${projectColor(task)}">${escapeText(task.title)}</button>`).join('');
      const overflow = weekOverflowMarkup(key, Math.max(0, items.length - WEEK_ALLDAY_VISIBLE), 'allday');
      return `<div class="week-allday-col" data-date="${key}">${chips}${overflow}</div>`;
    }).join('');
    const dayCols = keys.map((key) => {
      const blocks = weekItemsOnDate(key).timedEvents.map((task) => blockMarkup(task, key, rangeStart, rangeMinutes)).join('');
      return `<div class="week-day-col" data-date="${key}"><div class="week-hour-lines">${labels.map(() => '<i></i>').join('')}</div>${blocks}</div>`;
    }).join('');
    const todayIndex = keys.indexOf(todayKey()) + 1;
    const nowLine = nowLineMarkup(keys, rangeStart, rangeMinutes);
    const gutter = labels.map((hour) => `<span>${pad(hour)}:00</span>`).join('');
    board.innerHTML = `<aside class="week-mini" aria-label="周视图侧栏"></aside><section class="week-main"><div class="week-main-head"><span class="week-gutter-spacer"></span><div class="week-col-heads${todayIndex ? ' has-today' : ''}" style="--today-index:${todayIndex}">${header}</div></div><div class="week-hairline" aria-hidden="true"></div><div class="week-todos"><span class="week-gutter-label">待办</span><div class="week-todo-cols${todayIndex ? ' has-today' : ''}" style="--today-index:${todayIndex}">${todoCols}</div></div><div class="week-hairline" aria-hidden="true"></div><div class="week-allday"><span class="week-gutter-label">全天</span><div class="week-allday-cols${todayIndex ? ' has-today' : ''}" style="--today-index:${todayIndex}">${allDayCols}</div></div><div class="week-hairline" aria-hidden="true"></div><div class="week-scroll"><div class="week-gutter" style="--hour-h:${HOUR_PX}px;--hours:${labels.length}">${gutter}</div><div class="week-days${todayIndex ? ' has-today' : ''}" data-start-hour="${DAY_START}" data-hours="${labels.length}" style="--hour-h:${HOUR_PX}px;--hours:${labels.length};--today-index:${todayIndex}">${dayCols}${nowLine}</div></div></section>`;
    renderMini(board.querySelector('.week-mini'), keys);
    restoreScroll(board);
    syncWeekScrollbarGutter();
    placeNowLine();
  }
  function setView(next) {
    view = next === 'week' ? 'week' : 'month';
    const panel = document.querySelector('.calendar-panel');
    const grid = document.querySelector('#calendarGrid');
    const weekdays = document.querySelector('.weekdays');
    const board = ensureBoard();
    panel?.classList.toggle('is-week', view === 'week');
    document.querySelectorAll('[data-calendar-view]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.calendarView === view));
    });
    if (view === 'week') {
      if (grid) grid.hidden = true;
      if (weekdays) weekdays.hidden = true;
      board.hidden = false;
      board.classList.remove('hidden');
      savedScroll = null;
      renderBoard();
      startNowClock();
    } else {
      stopNowClock();
      board.hidden = true;
      board.classList.add('hidden');
      if (grid) grid.hidden = false;
      if (weekdays) weekdays.hidden = false;
      if (typeof renderCalendar === 'function') renderCalendar();
    }
  }
  function jumpTo(key) {
    anchorKey = key;
    const date = parseKey(key);
    if (typeof calendarCursor !== 'undefined') calendarCursor = new Date(date.getFullYear(), date.getMonth(), 1);
    if (view === 'week') renderBoard();
    else if (typeof renderCalendar === 'function') renderCalendar();
  }
  function wrapCalendar() {
    if (typeof changeCalendarMonth === 'function' && changeCalendarMonth.name !== 'weekAwareChange') {
      const original = changeCalendarMonth;
      changeCalendarMonth = function weekAwareChange(offset, animate) {
        if (view === 'week') {
          const date = parseKey(anchorKey);
          date.setDate(date.getDate() + offset * 7);
          jumpTo(toKey(date));
          return;
        }
        return original(offset, animate);
      };
    }
    if (typeof goToCurrentCalendarMonth === 'function' && goToCurrentCalendarMonth.name !== 'weekAwareToday') {
      const original = goToCurrentCalendarMonth;
      goToCurrentCalendarMonth = function weekAwareToday() {
        if (view === 'week') { jumpTo(todayKey()); return; }
        return original();
      };
    }
    if (typeof renderCalendar === 'function' && renderCalendar.name !== 'weekAwareRender') {
      const original = renderCalendar;
      renderCalendar = function weekAwareRender() {
        original();
        if (view === 'week') {
          const grid = document.querySelector('#calendarGrid');
          const weekdays = document.querySelector('.weekdays');
          if (grid) grid.hidden = true;
          if (weekdays) weekdays.hidden = true;
          renderBoard();
        }
      };
    }
  }
  function pointToMinutes(clientY) {
    const days = document.querySelector('.week-days');
    if (!days) return 0;
    const startHour = Number(days.dataset.startHour || 0);
    const hours = Number(days.dataset.hours || 24);
    const scroll = document.querySelector('.week-scroll');
    const rect = days.getBoundingClientRect();
    // Prefer full content height; when scrolled, rect.top is negative so clientY-rect.top is content Y.
    const y = clientY - rect.top;
    const height = Math.max(rect.height, days.scrollHeight, 1);
    const ratio = clamp(y / height, 0, 0.999);
    return snapMinutes(startHour * 60 + ratio * hours * 60);
  }
  function columnKeyAt(clientX, clientY) {
    const prev = document.querySelectorAll('.week-block.is-dragging');
    prev.forEach((el) => { el.style.pointerEvents = 'none'; });
    const el = document.elementFromPoint(clientX, clientY);
    prev.forEach((el) => { el.style.pointerEvents = ''; });
    return el?.closest('.week-day-col')?.dataset.date || drag?.dateKey || '';
  }
  function applyPreview(block, startMin, endMin, dateKey) {
    const days = document.querySelector('.week-days');
    if (!days || !block) return;
    const rangeStart = Number(days.dataset.startHour || 0) * 60;
    const rangeMinutes = Number(days.dataset.hours || 24) * 60;
    block.style.top = `${((clamp(startMin, rangeStart, rangeStart + rangeMinutes) - rangeStart) / rangeMinutes) * 100}%`;
    block.style.height = `${Math.max(6, ((clamp(endMin, startMin + MIN_SPAN, rangeStart + rangeMinutes) - clamp(startMin, rangeStart, rangeStart + rangeMinutes)) / rangeMinutes) * 100)}%`;
    const label = block.querySelector('em');
    if (label) label.textContent = formatMinutes(startMin);
    if (dateKey) block.dataset.date = dateKey;
    const column = document.querySelector(`.week-day-col[data-date="${dateKey}"]`);
    if (column && block.parentElement !== column) column.appendChild(block);
  }
  function beginDrag(event, block, edge) {
    if (drag) return;
    const task = findTask(block.dataset.id);
    if (!canDragTime(task)) return;
    event.preventDefault();
    event.stopPropagation();
    const startMin = minutes(task.time);
    const endMin = minutes(task.endTime) ?? (startMin + 30);
    drag = {
      taskId: task.id, edge: edge || 'move', pointerId: event.pointerId,
      originX: event.clientX, originY: event.clientY, moved: false,
      dateKey: block.dataset.date, startMin, endMin, captureTarget: ensureBoard(),
      original: { dueDate: task.dueDate, endDate: task.endDate || task.dueDate, time: task.time, endTime: task.endTime || '' },
    };
    block.classList.add('is-dragging');
    document.body.classList.add('week-dragging');
    // The preview reparents the block between columns, which releases capture.
    // Keep capture on the stable board so an outside release still commits.
    try { drag.captureTarget.setPointerCapture(event.pointerId); } catch {}
    window.addEventListener('pointermove', updateDrag, true);
    window.addEventListener('pointerup', onWindowUp, true);
    window.addEventListener('pointercancel', onWindowCancel, true);
  }
  function onWindowUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    updateDrag(event);
    finishDrag(false);
  }
  function onWindowCancel(event) {
    if (drag && event.pointerId === drag.pointerId) finishDrag(true);
  }
  function updateDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (Math.abs(event.clientX - drag.originX) + Math.abs(event.clientY - drag.originY) > 4) drag.moved = true;
    const task = findTask(drag.taskId);
    const block = document.querySelector(`.week-block[data-id="${drag.taskId}"]`);
    if (!task || !block) return;
    const pointed = pointToMinutes(event.clientY);
    const span = drag.endMin - drag.startMin;
    let startMin = drag.startMin;
    let endMin = drag.endMin;
    if (drag.edge === 'start') startMin = clamp(pointed, 0, endMin - MIN_SPAN);
    else if (drag.edge === 'end') endMin = clamp(pointed, startMin + MIN_SPAN, 24 * 60);
    else {
      startMin = clamp(pointed, 0, 24 * 60 - span);
      endMin = startMin + span;
      const nextDate = columnKeyAt(event.clientX, event.clientY);
      if (nextDate) drag.dateKey = nextDate;
    }
    drag.liveStart = startMin;
    drag.liveEnd = endMin;
    // Only the preview changes until this pointer is released successfully.
    applyPreview(block, startMin, endMin, drag.dateKey);
  }
  async function finishDrag(cancel) {
    const current = drag;
    drag = null;
    document.body.classList.remove('week-dragging');
    document.querySelectorAll('.week-block.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
    window.removeEventListener('pointermove', updateDrag, true);
    window.removeEventListener('pointerup', onWindowUp, true);
    window.removeEventListener('pointercancel', onWindowCancel, true);
    if (!current) return;
    try { current.captureTarget.releasePointerCapture(current.pointerId); } catch {}
    if (current.moved) ensureBoard().dataset.skipClick = '1';
    const task = findTask(current.taskId);
    if (!task) { renderBoard(); return; }
    if (cancel || !current.moved) {
      renderBoard();
      return;
    }
    if (current.liveStart != null) task.time = formatMinutes(current.liveStart);
    if (current.liveEnd != null) task.endTime = formatMinutes(current.liveEnd);
    if (current.edge === 'move' && current.dateKey) {
      task.dueDate = current.dateKey;
      if (typeof isCalendarEvent === 'function' && isCalendarEvent(task) && typeof fromDateKey === 'function') {
        const length = (fromDateKey(current.original.endDate) - fromDateKey(current.original.dueDate)) / 86400000;
        const end = parseKey(current.dateKey);
        end.setDate(end.getDate() + Math.max(0, length));
        task.endDate = toKey(end);
      } else {
        task.endDate = current.dateKey;
      }
    }
    task.updatedAt = Date.now();
    try {
      if (typeof persist === 'function') await persist();
      else if (window.luma && window.luma.save && typeof state !== 'undefined') await window.luma.save(state);
    } catch (err) {
      console.error('week drag persist failed', err);
    }
    if (typeof render === 'function') render();
    else renderBoard();
  }
  function startNowClock() {
    stopNowClock();
    nowTimer = window.setInterval(placeNowLine, 30000);
  }
  function stopNowClock() {
    if (nowTimer) window.clearInterval(nowTimer);
    nowTimer = 0;
  }
  function bindBoard() {
    const board = ensureBoard();
    if (board.dataset.bound === '1') return;
    board.dataset.bound = '1';
    board.addEventListener('pointerdown', (event) => {
      if (event.button != null && event.button !== 0) return;
      const handle = event.target.closest('.week-handle');
      const block = event.target.closest('.week-block');
      if (handle && block) { beginDrag(event, block, handle.dataset.edge); return; }
      if (block?.classList.contains('is-draggable')) beginDrag(event, block, 'move');
    });
    if (!window.__weekSbResizeBound) {
      window.__weekSbResizeBound = true;
      window.addEventListener('resize', () => syncWeekScrollbarGutter());
    }
    board.addEventListener('click', (event) => {
      if (board.dataset.skipClick === '1') {
        delete board.dataset.skipClick;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.target.closest('.week-handle')) { event.preventDefault(); event.stopPropagation(); return; }

      const todoCheck = event.target.closest('.week-todo-check');
      if (todoCheck?.dataset.id) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof toggleTask === 'function') {
          Promise.resolve(toggleTask(todoCheck.dataset.id)).catch((error) => console.error('week todo completion failed', error));
        }
        return;
      }

      const todoTitle = event.target.closest('.week-todo-title');
      if (todoTitle?.dataset.id) {
        event.preventDefault();
        event.stopPropagation();
        const task = findTask(todoTitle.dataset.id);
        const pending = task && typeof isTaskPendingCompletion === 'function' && isTaskPendingCompletion(task.id);
        if (task && !task.completed && !pending && typeof openCalendarTaskDialog === 'function') {
          openCalendarTaskDialog(todoTitle.dataset.date, 'todo', task.id);
        } else if (todoTitle.dataset.date && typeof openCalendarDetail === 'function') {
          openCalendarDetail(todoTitle.dataset.date);
        }
        return;
      }

      const overflow = event.target.closest('.week-overflow');
      if (overflow?.dataset.date) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof openCalendarDetail === 'function') openCalendarDetail(overflow.dataset.date);
        return;
      }

      const mini = event.target.closest('.week-mini-day');
      if (mini?.dataset.date) { jumpTo(mini.dataset.date); return; }
      const item = event.target.closest('.week-block, .week-chip, .week-col-head, .week-day-col, .week-allday-col, .week-todo-col');
      if (item?.dataset.date && typeof openCalendarDetail === 'function') openCalendarDetail(item.dataset.date);
    });
    const panel = document.querySelector('#calendarPanel');
    if (panel && panel.dataset.weekWheel !== '1') {
      panel.dataset.weekWheel = '1';
      panel.addEventListener('wheel', (event) => {
        if (view !== 'week') return;
        const rail = event.target.closest('.week-mini');
        if (rail) {
          const body = rail.querySelector('.week-rail-body') || rail;
          event.preventDefault();
          event.stopPropagation();
          body.scrollTop += event.deltaY;
          return;
        }
        const scroll = document.querySelector('.week-scroll');
        if (!scroll) return;
        event.preventDefault();
        event.stopPropagation();
        savedScroll = scroll.scrollTop + event.deltaY;
        scroll.scrollTop = savedScroll;
      }, { capture: true, passive: false });
    }
  }
  function boot() {
    ensureAssets();
    wrapCalendar();
    bindBoard();
    const switcher = document.querySelector('.calendar-view-switch');
    if (switcher && switcher.dataset.bound !== '1') {
      switcher.dataset.bound = '1';
      switcher.addEventListener('click', (event) => {
        const button = event.target.closest('[data-calendar-view]');
        if (!button) return;
        if (button.dataset.calendarView === 'week') anchorKey = todayKey();
        setView(button.dataset.calendarView);
      });
    }
  }
  window.LumaWeekView = {
    refresh: () => { if (view === 'week') renderBoard(); },
    getView: () => view,
  };
  boot();
  document.addEventListener('DOMContentLoaded', boot);
})();
