(() => {
  if (window.LumaCalendarContextMenu?.bound) return;

  const menu = document.createElement('div');
  menu.id = 'calendarContextMenu';
  menu.className = 'task-menu hidden';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-hidden', 'true');
  document.body.appendChild(menu);

  function closeCalendarContextMenu() {
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
    menu.innerHTML = '';
  }

  function closeOtherMenus() {
    if (typeof closeTaskMenu === 'function') closeTaskMenu();
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

  function appendAction(label, action, options = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `task-menu-action${options.danger ? ' danger' : ''}`;
    button.disabled = Boolean(options.disabled);

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

  function openCalendarCellMenu(dateKey, clientX, clientY) {
    closeOtherMenus();
    appendHeader(calendarDateLabel(dateKey), '新建');
    appendAction('新建日程', () => openCalendarTaskDialog(dateKey, 'event'));
    appendAction('新建待办', () => openCalendarTaskDialog(dateKey, 'todo'));
    positionCalendarContextMenu(clientX, clientY);
  }

  function openCalendarItemMenu(task, dateKey, clientX, clientY) {
    closeOtherMenus();
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

  document.addEventListener('contextmenu', (event) => {
    const calendarPanel = event.target.closest?.('#calendarPanel');
    if (!calendarPanel) return;

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
    if (!cell || event.target.closest('.day-overflow')) return;
    const dateKey = cell.dataset.date;
    if (!dateKey) return;
    event.preventDefault();
    event.stopPropagation();
    openCalendarCellMenu(dateKey, event.clientX, event.clientY);
  });

  document.addEventListener('pointerdown', (event) => {
    if (!menu.classList.contains('hidden') && !menu.contains(event.target)) closeCalendarContextMenu();
  }, { capture: true });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCalendarContextMenu();
  });
  window.addEventListener('blur', closeCalendarContextMenu);
  window.addEventListener('resize', closeCalendarContextMenu);

  window.LumaCalendarContextMenu = {
    bound: true,
    close: closeCalendarContextMenu,
  };
})();
