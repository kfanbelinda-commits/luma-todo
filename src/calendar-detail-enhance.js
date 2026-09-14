/* Calendar date-detail refinements: completed todos + compact LifeLog summary. */
(function () {
  const expandedCompletedDates = new Set();
  const expandedLifeLogDates = new Set();
  let lifelogObserver = null;
  let lifelogRefreshQueued = false;
  let wrapAttempts = 0;

  function currentDateKey() {
    return typeof calendarDetailDate === 'string' ? calendarDetailDate : '';
  }

  function completedTodosFor(dateKey) {
    if (!dateKey || typeof state === 'undefined') return [];
    return state.tasks
      .filter((task) => !isCalendarEvent(task)
        && task.completed
        && (task.dueDate || task.completedDate || '') === dateKey)
      .sort((a, b) => {
        if (a.time && b.time) return a.time.localeCompare(b.time);
        if (a.time) return -1;
        if (b.time) return 1;
        return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
      });
  }

  function completedTodoRow(task) {
    const project = projectById(task.projectId);
    const row = document.createElement('div');
    row.className = 'calendar-detail-todo-row calendar-detail-completed-row';
    row.style.setProperty('--detail-color', project.color);
    row.title = '已完成 · 点击方框恢复';
    row.innerHTML = `
      <button class="calendar-detail-check is-checked" type="button" aria-label="恢复 ${escapeAttribute(task.title)}"></button>
      <span class="calendar-detail-task-title">${escapeAttribute(task.time ? `${task.time} ${task.title}` : task.title)}</span>
      <span class="calendar-detail-project">${escapeAttribute(project.name)}</span>
    `;
    row.querySelector('.calendar-detail-check')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve(toggleTask(task.id)).catch((error) => console.error('无法恢复已完成待办', error));
    });
    return row;
  }

  function enhanceCompletedTodos() {
    const dateKey = currentDateKey();
    const todoHost = document.querySelector('#calendarTodoList');
    const detail = document.querySelector('#calendarDetail');
    if (!dateKey || !todoHost || !detail || detail.classList.contains('hidden')) return;

    const completed = completedTodosFor(dateKey);
    let block = document.querySelector('#calendarCompletedTodos');
    if (!completed.length) {
      block?.remove();
      return;
    }

    if (!block) {
      block = document.createElement('div');
      block.id = 'calendarCompletedTodos';
      block.className = 'calendar-detail-completed';
      todoHost.insertAdjacentElement('afterend', block);
    }

    const expanded = expandedCompletedDates.has(dateKey);
    block.replaceChildren();

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'calendar-detail-completed-toggle';
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.innerHTML = `<span class="calendar-detail-completed-check" aria-hidden="true">✓</span><span>已完成 ${completed.length}</span><span class="calendar-detail-completed-chevron" aria-hidden="true">⌄</span>`;
    toggle.addEventListener('click', () => {
      if (expandedCompletedDates.has(dateKey)) expandedCompletedDates.delete(dateKey);
      else expandedCompletedDates.add(dateKey);
      enhanceCompletedTodos();
    });
    block.appendChild(toggle);

    if (expanded) {
      const list = document.createElement('div');
      list.className = 'calendar-detail-completed-list';
      completed.forEach((task) => list.appendChild(completedTodoRow(task)));
      block.appendChild(list);
    }
  }

  function selectedPickerLabel(section, kind) {
    const value = section
      .querySelector(`.lifelog-pick[data-kind="${kind}"]`)
      ?.getAttribute('aria-label')
      ?.split('：')
      .slice(1)
      .join('：')
      .trim() || '';
    return value && value !== '未选' ? value : '';
  }

  function lifeLogPhotoCount(section) {
    const counter = section.querySelector('.lifelog-photo-count')?.textContent || '';
    const match = counter.match(/^(\d+)\s*\//);
    if (match) return Number(match[1]);
    return section.querySelector('.lifelog-photo-thumb') ? 1 : 0;
  }

  function lifeLogSummary(section) {
    const weather = selectedPickerLabel(section, 'weather');
    const mood = selectedPickerLabel(section, 'mood');
    const note = String(section.querySelector('#lifeLogNote')?.value || '').replace(/\s+/g, ' ').trim();
    const photos = lifeLogPhotoCount(section);
    const parts = [];
    if (weather) parts.push(`天气 ${weather}`);
    if (mood) parts.push(`心情 ${mood}`);
    if (note) parts.push(note.length > 26 ? `${note.slice(0, 26)}…` : note);
    if (photos) parts.push(`图片 ${photos}`);
    return parts.length ? parts.join(' · ') : '还没有生活记录';
  }

  function applyLifeLogCompact() {
    const section = document.querySelector('#lifeLogDetail');
    if (!section) return;

    const fullLifeLogView = document.querySelector('#calendarPanel')?.classList.contains('is-lifelog');
    if (fullLifeLogView) {
      section.classList.remove('lifelog-detail-compact', 'is-expanded');
      section.querySelector('.lifelog-compact-toggle')?.remove();
      return;
    }

    const dateKey = currentDateKey();
    if (!dateKey) return;
    const expanded = expandedLifeLogDates.has(dateKey);
    section.classList.add('lifelog-detail-compact');
    section.classList.toggle('is-expanded', expanded);

    let toggle = section.querySelector(':scope > .lifelog-compact-toggle');
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'lifelog-compact-toggle';
      toggle.innerHTML = '<span class="lifelog-compact-label">生活记录</span><span class="lifelog-compact-summary"></span><span class="lifelog-compact-chevron" aria-hidden="true">⌄</span>';
      section.insertBefore(toggle, section.firstChild);
      toggle.addEventListener('click', () => {
        const key = currentDateKey();
        if (!key) return;
        if (expandedLifeLogDates.has(key)) expandedLifeLogDates.delete(key);
        else expandedLifeLogDates.add(key);
        applyLifeLogCompact();
      });
    }

    toggle.setAttribute('aria-expanded', String(expanded));
    const summary = lifeLogSummary(section);
    const summaryHost = toggle.querySelector('.lifelog-compact-summary');
    if (summaryHost && summaryHost.textContent !== summary) summaryHost.textContent = summary;
  }

  function queueLifeLogCompact() {
    if (lifelogRefreshQueued) return;
    lifelogRefreshQueued = true;
    requestAnimationFrame(() => {
      lifelogRefreshQueued = false;
      applyLifeLogCompact();
    });
  }

  function installLifeLogObserver() {
    const detail = document.querySelector('#calendarDetail');
    if (!detail || lifelogObserver) return;
    lifelogObserver = new MutationObserver(() => queueLifeLogCompact());
    lifelogObserver.observe(detail, { childList: true, subtree: true });
    queueLifeLogCompact();
  }

  function wrapCalendarDetail() {
    if (typeof renderCalendarDetail !== 'function') return false;
    if (renderCalendarDetail.__detailEnhanceWrapped) return true;
    const original = renderCalendarDetail;
    renderCalendarDetail = function enhancedCalendarDetail(...args) {
      const result = original.apply(this, args);
      enhanceCompletedTodos();
      queueLifeLogCompact();
      return result;
    };
    renderCalendarDetail.__detailEnhanceWrapped = true;
    return true;
  }

  function boot() {
    installLifeLogObserver();
    if (wrapCalendarDetail()) {
      enhanceCompletedTodos();
      queueLifeLogCompact();
      return;
    }
    if (wrapAttempts < 80) {
      wrapAttempts += 1;
      window.setTimeout(boot, 50);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
