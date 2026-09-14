(() => {
  if (window.LumaCalendarContextMenu?.bound) return;

  const menu = document.createElement('div');
  menu.id = 'calendarContextMenu';
  menu.className = 'task-menu hidden';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-hidden', 'true');
  document.body.appendChild(menu);

  const style = document.createElement('style');
  style.id = 'calendarContextMenuStyles';
  style.textContent = `
    #calendarContextMenu.calendar-context-menu--cell {
      width: 164px;
      max-width: calc(100vw - 20px);
      overflow: hidden;
      padding: 5px;
      border-radius: 10px;
      border-color: rgba(255,255,255,.12);
      background: rgba(39,42,49,.98);
      box-shadow: 0 10px 28px rgba(0,0,0,.26), 0 2px 8px rgba(0,0,0,.16);
    }

    #calendarContextMenu.calendar-context-menu--cell .task-menu-action {
      min-height: 34px;
      justify-content: flex-start;
      gap: 9px;
      padding: 7px 9px;
      border-radius: 7px;
      font-size: 12px;
      line-height: 1.2;
    }

    #calendarContextMenu.calendar-context-menu--cell .task-menu-action small {
      margin-left: auto;
      white-space: nowrap;
      font-size: 10px;
    }

    #calendarContextMenu.calendar-context-menu--cell .calendar-context-menu-icon {
      width: 16px;
      height: 16px;
      display: grid;
      place-items: center;
      flex: 0 0 16px;
      color: rgba(244,247,252,.70);
    }

    #calendarContextMenu.calendar-context-menu--cell .calendar-context-menu-icon svg {
      width: 14px;
      height: 14px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.45;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    #calendarContextMenu.calendar-context-menu--cell .task-menu-action:hover,
    #calendarContextMenu.calendar-context-menu--cell .task-menu-action:focus-visible {
      background: rgba(255,255,255,.08);
    }

    html[data-theme="light"] #calendarContextMenu.calendar-context-menu--cell {
      border-color: rgba(58,71,92,.14);
      color: #202938;
      background: rgba(250,251,253,.985);
      box-shadow: 0 10px 28px rgba(45,55,72,.16), 0 2px 8px rgba(45,55,72,.08);
    }

    html[data-theme="light"] #calendarContextMenu.calendar-context-menu--cell .calendar-context-menu-icon {
      color: #667085;
    }

    html[data-theme="light"] #calendarContextMenu.calendar-context-menu--cell .task-menu-action:hover,
    html[data-theme="light"] #calendarContextMenu.calendar-context-menu--cell .task-menu-action:focus-visible {
      background: rgba(58,71,92,.07);
    }
  `;
  document.head.appendChild(style);

  function closeCalendarContextMenu() {
    menu.classList.add('hidden');
    menu.classList.remove('calendar-context-menu--cell');
    menu.removeAttribute('aria-label');
    menu.setAttribute('aria-hidden', 'true');
    menu.innerHTML = '';
  }

  function closeReminderPopover() {
    const reminder = document.querySelector('#reminderPopover');
    if (!reminder || reminder.classList.contains('hidden')) return;
    reminder.classList.add('hidden');
    if (typeof pendingReminderTaskId !== 'undefined') pendingReminderTaskId = null;
  }

  function closeOtherMenus() {
    if (typeof closeTaskMenu === 'function') closeTaskMenu();
    if (typeof closeTimePickers === 'function') closeTimePickers();
    closeReminderPopover();
    closeCalendarContextMenu();
  }

  function positionCalendarContextMenu(clientX, clientY) {
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      const left = Math.max(10, Math.min(clientX, window.innerWidth - rect.width - 10));
      const top = Math.max(10, Math.min(clientY, window.innerHeight - rect.height - 10));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    });
  }

  function appendHeader(title, subtitle = '') {
    const header = document.createElement('div');
    header.className = 'task-menu-header';

    const copy = document.createElement('div');
    copy.style.minWidth = '0';
    copy.style.flex = '1';

    const strong = document.createElement('strong');
    strong.textContent = title;
    strong.style.display = 'block';
    copy.appendChild(strong);

    if (subtitle) {
      const small = document.createElement('small');
      small.textContent = subtitle;
      small.style.display = 'block';
      small.style.marginTop = '2px';
      small.style.color = 'rgba(232,236,244,.62)';
      small.style.fontSize = '10px';
      copy.appendChild(small);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭菜单');
    close.textContent = '×';
    close.addEventListener('click', closeCalendarContextMenu);

    header.append(copy, close);
    menu.appendChild(header);
  }

  function createActionIcon(kind) {
    const icon = document.createElement('span');
    icon.className = 'calendar-context-menu-icon';
    icon.setAttribute('aria-hidden', 'true');
    if (kind === 'event') {
      icon.innerHTML = '<svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="10" rx="2"></rect><path d="M5 2.5v2.2M11 2.5v2.2M2.7 6.3h10.6"></path></svg>';
    } else if (kind === 'todo') {
      icon.innerHTML = '<svg viewBox="0 0 16 16"><rect x="2.7" y="2.7" width="10.6" height="10.6" rx="2.2"></rect><path d="m5.1 8.1 1.8 1.8 4-4.1"></path></svg>';
    }
    return icon;
  }

  function appendAction(label, action, options = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `task-menu-action${options.danger ? ' danger' : ''}`;
    button.disabled = Boolean(options.disabled);

    if (options.icon) button.appendChild(createActionIcon(options.icon));

    const span = document.createElement('span');
    span.textContent = label;
    button.appendChild(span);

    if (options.detail) {
      const small = document.createElement('small');
      small.textContent = options.detail;
      button.appendChild(small);
    }

    button.addEventListener('click', () => {
      if (button.disabled) return;
      closeCalendarContextMenu();
      Promise.resolve(action()).catch((error) => console.error(`日历右键操作失败：${label}`, error));
    });
    menu.appendChild(button);
    return button;
  }

  function calendarDateLabel(dateKey) {
    const date = typeof fromDateKey === 'function' ? fromDateKey(dateKey) : new Date(`${dateKey}T00:00:00`);
    return `${date.getMonth() + 1}月${date.getDate()}日 周${WEEKDAYS[date.getDay()]}`;
  }

  function addThirtyMinutes(time) {
    if (typeof addMinutesToTime === 'function') return addMinutesToTime(time, 30);
    const match = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return '';
    const value = Number(match[1]) * 60 + Number(match[2]) + 30;
    return `${String(Math.floor((value % 1440) / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  }

  function openNewCalendarItem(dateKey, mode, initialTime = '') {
    if (typeof openCalendarTaskDialog !== 'function') return;
    openCalendarTaskDialog(dateKey, mode);
    if (mode !== 'event' || !initialTime) return;

    const start = document.querySelector('#calendarTaskTime');
    const end = document.querySelector('#calendarTaskEndTime');
    if (start) start.value = initialTime;
    if (end) end.value = addThirtyMinutes(initialTime);
    if (typeof syncCalendarEventEndTimeState === 'function') syncCalendarEventEndTimeState();
  }

  function isGoogleReadOnly(task) {
    return Boolean(task?.googleCalendarExternal || task?.syncTarget === 'external-calendar');
  }

  function calendarItemSourceLabel(task) {
    if (isGoogleReadOnly(task)) return task.googleCalendarName || 'Google Calendar';
    if (task?.icloudExternal) return task.icloudCalendarName || 'Apple 日历';
    return typeof isCalendarEvent === 'function' && isCalendarEvent(task) ? 'Luma 日程' : 'Luma 待办';
  }

  function safeProjectId(task) {
    const projectId = task?.projectId || 'inbox';
    return typeof isSystemCalendarProject === 'function' && isSystemCalendarProject(projectId) ? 'inbox' : projectId;
  }

  async function duplicateCalendarItem(task) {
    if (!task || typeof state === 'undefined') return;
    const now = Date.now();
    const eventMode = typeof isCalendarEvent === 'function' && isCalendarEvent(task);
    const duplicate = {
      id: typeof uid === 'function' ? uid() : `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: String(task.title || ''),
      projectId: eventMode ? 'inbox' : safeProjectId(task),
      dueDate: task.dueDate || (typeof dayOffset === 'function' ? dayOffset(0) : ''),
      time: String(task.time || ''),
      itemType: eventMode ? 'event' : 'todo',
      completed: false,
      createdAt: now,
      updatedAt: now,
      order: now,
      syncTarget: eventMode ? 'calendar' : 'tasks',
    };

    if (eventMode) {
      duplicate.endDate = task.endDate || duplicate.dueDate;
      duplicate.endTime = String(task.endTime || '');
      duplicate.eventColor = typeof eventColorFor === 'function' ? eventColorFor(task) : String(task.eventColor || '');
    } else if (task.reminderMinutes != null) {
      duplicate.reminderMinutes = task.reminderMinutes;
    }

    state.tasks.push(duplicate);
    if (typeof persist === 'function') await persist();
    if (typeof render === 'function') render();
  }

  function appendProjectChoices(task) {
    if (!task || typeof state === 'undefined' || !Array.isArray(state.projects)) return;
    const section = document.createElement('div');
    section.className = 'task-menu-section';

    const label = document.createElement('span');
    label.className = 'task-menu-label';
    label.textContent = '移动到分类';
    section.appendChild(label);

    const choices = document.createElement('div');
    choices.className = 'task-project-choices';
    state.projects
      .filter((project) => typeof isSystemCalendarProject !== 'function' || !isSystemCalendarProject(project))
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
      .forEach((project) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `task-project-choice${project.id === task.projectId ? ' selected' : ''}`;
        button.innerHTML = `<i style="--choice-color:${project.color}"></i><span>${escapeAttribute(project.name)}</span>${project.id === task.projectId ? '<b>✓</b>' : ''}`;
        button.addEventListener('click', () => {
          closeCalendarContextMenu();
          Promise.resolve(moveTaskToProject(task.id, project.id)).catch((error) => console.error('移动分类失败', error));
        });
        choices.appendChild(button);
      });

    section.appendChild(choices);
    menu.appendChild(section);
  }

  function openCalendarCellMenu(dateKey, clientX, clientY, options = {}) {
    closeOtherMenus();
    menu.classList.add('calendar-context-menu--cell');
    const initialTime = String(options.initialTime || '');
    menu.setAttribute('aria-label', `${calendarDateLabel(dateKey)} 新建事项${initialTime ? ` ${initialTime}` : ''}`);
    appendAction('新建日程', () => openNewCalendarItem(dateKey, 'event', initialTime), {
      icon: 'event',
      detail: initialTime,
    });
    appendAction('新建待办', () => openNewCalendarItem(dateKey, 'todo'), { icon: 'todo' });
    positionCalendarContextMenu(clientX, clientY);
  }

  function openCalendarItemMenu(task, dateKey, clientX, clientY) {
    closeOtherMenus();
    menu.classList.remove('calendar-context-menu--cell');
    const eventMode = typeof isCalendarEvent === 'function' && isCalendarEvent(task);
    const googleReadOnly = isGoogleReadOnly(task);
    appendHeader(task.title || (eventMode ? '日程' : '待办'), calendarItemSourceLabel(task));

    if (googleReadOnly) {
      appendAction('查看当天详情', () => openCalendarDetail(dateKey));
      appendAction('复制为 Luma 日程', () => duplicateCalendarItem(task));
      positionCalendarContextMenu(clientX, clientY);
      return;
    }

    if (eventMode) {
      appendAction('编辑日程', () => openCalendarTaskDialog(task.dueDate || dateKey, 'event', task.id), {
        detail: typeof eventRangeLabel === 'function' ? eventRangeLabel(task) : '',
      });
      appendAction('复制', () => duplicateCalendarItem(task));
      appendAction('删除', () => deleteTask(task.id), { danger: true });
    } else {
      appendAction(task.completed ? '标记为未完成' : '标记为完成', () => toggleTask(task.id));
      appendAction('修改日期和时间', () => editTaskSchedule(task.id), {
        detail: `${task.dueDate ? formatShortDate(task.dueDate) : '无日期'}${task.time ? ` · ${task.time}` : ''}`,
      });
      appendProjectChoices(task);
      appendAction('复制', () => duplicateCalendarItem(task));
      appendAction('删除', () => deleteTask(task.id), { danger: true });
    }

    positionCalendarContextMenu(clientX, clientY);
  }

  function weekDateAtX(container, clientX, fallback = '') {
    if (!container) return fallback;
    const columns = [...container.children].filter((child) => child?.dataset?.date);
    if (!columns.length) return fallback;
    const rect = container.getBoundingClientRect();
    if (!rect.width) return fallback;
    const index = Math.max(0, Math.min(columns.length - 1, Math.floor((clientX - rect.left) * columns.length / rect.width)));
    return columns[index]?.dataset.date || fallback;
  }

  function weekItemDate(item, clientX) {
    if (!item) return '';
    if (item.classList.contains('week-allday-span')) {
      return weekDateAtX(item.closest('.week-allday-cols'), clientX, item.dataset.date || '');
    }
    return item.dataset.date || item.closest('[data-date]')?.dataset.date || '';
  }

  function weekTimeAt(clientY, column) {
    const days = column?.closest('.week-days');
    if (!days || !column) return '';
    const rect = column.getBoundingClientRect();
    const startHour = Number(days.dataset.startHour || 0);
    const hours = Number(days.dataset.hours || 24);
    const height = Math.max(rect.height, column.scrollHeight || 0, 1);
    const ratio = Math.max(0, Math.min(0.999, (clientY - rect.top) / height));
    const rawMinutes = startHour * 60 + ratio * hours * 60;
    const snapped = Math.max(0, Math.min(24 * 60 - 15, Math.round(rawMinutes / 15) * 15));
    return `${String(Math.floor(snapped / 60)).padStart(2, '0')}:${String(snapped % 60).padStart(2, '0')}`;
  }

  function handleWeekContextMenu(event) {
    const board = event.target.closest?.('#weekBoard');
    if (!board || board.hidden) return false;

    if (event.target.closest('.week-overflow, .week-mini, .week-handle')) return false;

    const item = event.target.closest('.week-block, .week-chip, .week-todo-item');
    if (item?.dataset.id) {
      const task = typeof state !== 'undefined' ? state.tasks.find((candidate) => candidate.id === item.dataset.id) : null;
      const dateKey = weekItemDate(item, event.clientX) || task?.dueDate || '';
      if (!task || !dateKey) return false;
      event.preventDefault();
      event.stopPropagation();
      openCalendarItemMenu(task, dateKey, event.clientX, event.clientY);
      return true;
    }

    const timedColumn = event.target.closest('.week-day-col');
    if (timedColumn?.dataset.date) {
      event.preventDefault();
      event.stopPropagation();
      openCalendarCellMenu(timedColumn.dataset.date, event.clientX, event.clientY, {
        initialTime: weekTimeAt(event.clientY, timedColumn),
      });
      return true;
    }

    const dateSurface = event.target.closest('.week-todo-col, .week-allday-col, .week-col-head');
    if (dateSurface?.dataset.date) {
      event.preventDefault();
      event.stopPropagation();
      openCalendarCellMenu(dateSurface.dataset.date, event.clientX, event.clientY);
      return true;
    }

    return false;
  }

  document.addEventListener('contextmenu', (event) => {
    const calendarPanel = event.target.closest?.('#calendarPanel');
    if (!calendarPanel) {
      if (!menu.classList.contains('hidden')) closeCalendarContextMenu();
      return;
    }

    if (handleWeekContextMenu(event)) return;

    const item = event.target.closest('.day-event, .calendar-span-event');
    if (item) {
      const taskId = item.dataset.taskId;
      const task = typeof state !== 'undefined' ? state.tasks.find((candidate) => candidate.id === taskId) : null;
      const dateKey = item.closest('.calendar-day')?.dataset.date || task?.dueDate || '';
      if (!task || !dateKey) return;
      event.preventDefault();
      event.stopPropagation();
      openCalendarItemMenu(task, dateKey, event.clientX, event.clientY);
      return;
    }

    const cell = event.target.closest('.calendar-day');
    if (!cell || event.target.closest('.day-overflow')) {
      if (!menu.classList.contains('hidden')) closeCalendarContextMenu();
      return;
    }
    const dateKey = cell.dataset.date;
    if (!dateKey) return;
    event.preventDefault();
    event.stopPropagation();
    openCalendarCellMenu(dateKey, event.clientX, event.clientY);
  });

  function dismissTransientMenus(event) {
    const target = event.target;
    if (!menu.classList.contains('hidden') && !menu.contains(target)) closeCalendarContextMenu();

    const taskMenu = document.querySelector('#taskMenu');
    if (taskMenu && !taskMenu.classList.contains('hidden') && !taskMenu.contains(target) && !target.closest?.('.task-more')) {
      if (typeof closeTaskMenu === 'function') closeTaskMenu();
    }

    const reminder = document.querySelector('#reminderPopover');
    if (reminder && !reminder.classList.contains('hidden') && !reminder.contains(target)) closeReminderPopover();

    if (!target.closest?.('.time-field') && typeof closeTimePickers === 'function') closeTimePickers();
  }

  // Use several native pointer/click paths. Electron drag/no-drag regions do not
  // always deliver exactly the same sequence, so any outside interaction gets a
  // chance to dismiss transient UI without changing modal/editor behavior.
  window.addEventListener('pointerdown', dismissTransientMenus, true);
  window.addEventListener('mousedown', dismissTransientMenus, true);
  window.addEventListener('click', dismissTransientMenus, true);
  window.addEventListener('contextmenu', (event) => {
    if (!menu.classList.contains('hidden') && !menu.contains(event.target) && !event.target.closest?.('#calendarPanel')) {
      closeCalendarContextMenu();
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeCalendarContextMenu();
    closeReminderPopover();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) closeCalendarContextMenu();
  });
  window.addEventListener('blur', closeCalendarContextMenu);
  window.addEventListener('resize', closeCalendarContextMenu);

  window.LumaCalendarContextMenu = {
    bound: true,
    close: closeCalendarContextMenu,
    openCell: openCalendarCellMenu,
    openItem: openCalendarItemMenu,
  };
})();