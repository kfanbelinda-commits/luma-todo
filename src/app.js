const COLORS = [
  '#d94f70', '#f06a3f', '#e2c94c', '#4fa56f', '#7289f5', '#8b6ef5',
  '#ef7180', '#f58a3d', '#c5cf52', '#4aa6a1', '#8796cf', '#a88478',
  '#e95736', '#f0a85a', '#82b45b', '#4da7c9', '#aa98cf', '#8b8e92',
  '#df8278', '#f3bd55', '#4fb58f', '#5d8de0', '#a878ad', '#b5a99b',
];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const DEFAULT_EVENT_COLOR = '#91a9c7';
const EVENT_COLORS = [
  { value: DEFAULT_EVENT_COLOR, label: '默认蓝灰' },
  { value: '#039be5', label: '亮蓝' },
  { value: '#3f51b5', label: '靛蓝' },
  { value: '#00a6a6', label: '青' },
  { value: '#33b679', label: '绿' },
  { value: '#f6bf26', label: '黄' },
  { value: '#f4511e', label: '橙' },
  { value: '#e67c73', label: '珊瑚' },
  { value: '#d50000', label: '红' },
  { value: '#ff2d55', label: '粉红' },
  { value: '#8e24aa', label: '紫' },
  { value: '#616161', label: '石墨' },
];

const $ = (selector) => document.querySelector(selector);
const pad = (value) => String(value).padStart(2, '0');
const toDateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const fromDateKey = (key) => {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
};
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function dayOffset(offset) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return toDateKey(date);
}

const seedState = {
  version: 1,
  settings: { autoStart: false, googleConnected: false, panelOpacity: 88, alwaysOnTop: false, lightMode: false, collapsedProjectIds: [] },
  projects: [
    { id: 'inbox', name: '未分类', color: '#9aa4b8', order: 0 },
    { id: 'client', name: '客户项目', color: '#7289f5', order: 1 },
    { id: 'internal', name: '内部系统', color: '#8b6ef5', order: 2 },
  ],
  tasks: [],
};

let state = structuredClone(seedState);
let expanded = false;
let calendarCursor = new Date();
calendarCursor.setDate(1);
let taskDateFilter = null;
let calendarDetailDate = null;
let calendarDetailViewMode = 'detail';
let calendarCreateMode = 'todo';
let editingCalendarEventId = null;
let calendarEventResizeState = null;
let selectedEventColor = DEFAULT_EVENT_COLOR;
let pendingReminderTaskId = null;
let draggedTaskId = null;
let draggedProjectId = null;
let selectedProjectColor = COLORS[0];
let editingProjectId = null;
let editingScheduleTaskId = null;
let activeQuickProjectId = null;
let highlightedTaskId = null;
let activeTaskMenuId = null;
let projectCreationTaskId = null;
let calendarTransitioning = false;
let opacitySaveTimer = null;
let calendarWheelDelta = 0;
let calendarWheelResetTimer = null;
let calendarWheelLockedUntil = 0;
const expandedCompleted = new Set();
const COMPLETION_GRACE_MS = 1500;
const pendingTaskCompletions = new Map();
let collapsedProjects = new Set();

function normalizeState(input) {
  if (!input || !Array.isArray(input.tasks) || !Array.isArray(input.projects)) return structuredClone(seedState);
  input.settings ??= {};
  input.settings.googleConnected ??= false;
  input.settings.alwaysOnTop = Boolean(input.settings.alwaysOnTop ?? input.settings.desktopPinned);
  delete input.settings.desktopPinned;
  input.settings.lightMode = Boolean(input.settings.lightMode);
  input.settings.collapsedProjectIds = Array.isArray(input.settings.collapsedProjectIds)
    ? input.settings.collapsedProjectIds.map(String)
    : [];
  input.settings.panelOpacity = Math.min(100, Math.max(45, Number(input.settings.panelOpacity) || 88));
  input.projects.forEach((project, index) => {
    project.order ??= index;
    project.updatedAt = Number(project.updatedAt || 0);
    if (project.id === 'google-calendar') {
      project.name = 'Google 日历';
      project.color = '#8b93a3';
    }
  });
  input.projectsUpdatedAt = Number(input.projectsUpdatedAt || Math.max(0, ...input.projects.map((project) => project.updatedAt)));
  input.tasks.forEach((task) => {
    task.completed = Boolean(task.completed);
    task.googleCalendarExternal = Boolean(task.googleCalendarExternal || task.syncTarget === 'external-calendar');
    task.icloudExternal = Boolean(task.icloudExternal);
    task.itemType = (task.itemType === 'event' || task.googleCalendarExternal || task.icloudExternal) ? 'event' : 'todo';
    task.projectId ??= 'inbox';
    task.syncTarget ??= task.itemType === 'event' ? 'calendar' : 'tasks';

    if (task.itemType === 'event') {
      task.endDate = task.endDate || task.dueDate || '';
      task.eventColor = /^#[0-9a-f]{6}$/i.test(task.eventColor || '') ? task.eventColor : DEFAULT_EVENT_COLOR;
      task.endTime = task.time ? (task.endTime || addMinutesToTime(task.time, 30)) : '';
    }
    task.updatedAt ??= task.createdAt || Date.now();
  });
  return input;
}

async function persist() {
  await window.luma?.save(state);
}

function projectById(id) {
  return state.projects.find((project) => project.id === id) || state.projects[0];
}

function isSystemCalendarProject(projectOrId) {
  const id = typeof projectOrId === 'string' ? projectOrId : projectOrId?.id;
  return id === 'google-calendar' || id === 'apple-calendar';
}

function projectOptions(selectedId = 'inbox') {
  return [...state.projects]
    .filter((project) => !isSystemCalendarProject(project))
    .sort((a, b) => a.order - b.order)
    .map((project) => `<option value="${escapeAttribute(project.id)}"${project.id === selectedId ? ' selected' : ''}>${escapeAttribute(project.name)}</option>`)
    .join('');
}

function isCalendarEvent(task) {
  return Boolean(task && (task.itemType === 'event' || task.googleCalendarExternal || task.syncTarget === 'external-calendar'));
}

function eventCoversDate(task, dateKey) {
  if (!isCalendarEvent(task) || !task?.dueDate || !dateKey) return false;
  const endDate = task.endDate || task.dueDate;
  return task.dueDate <= dateKey && endDate >= dateKey;
}

function eventRangeLabel(task) {
  const endDate = task.endDate || task.dueDate;
  if (!task.dueDate) return task.time || '全天';

  if (!task.time) {
    return endDate === task.dueDate
      ? '全天'
      : `${formatShortDate(task.dueDate)}–${formatShortDate(endDate)}`;
  }

  const endTime = task.endTime || addMinutesToTime(task.time, 30);
  if (endDate === task.dueDate) return `${task.time}–${endTime}`;
  return `${formatShortDate(task.dueDate)} ${task.time}–${formatShortDate(endDate)} ${endTime}`;
}

function eventColorFor(task) {
  return /^#[0-9a-f]{6}$/i.test(task?.eventColor || '') ? task.eventColor : DEFAULT_EVENT_COLOR;
}

function renderEventColorChoices() {
  const host = $('#calendarEventColors');
  if (!host) return;
  if (!host.children.length) {
    EVENT_COLORS.forEach((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'event-color-choice';
      button.dataset.eventColor = option.value;
      button.title = option.label;
      button.setAttribute('aria-label', `日程颜色：${option.label}`);
      button.style.setProperty('--choice-color', option.value);
      button.addEventListener('click', () => {
        selectedEventColor = option.value;
        renderEventColorChoices();
      });
      host.appendChild(button);
    });
  }
  host.querySelectorAll('[data-event-color]').forEach((button) => {
    const active = button.dataset.eventColor === selectedEventColor;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function localResizableCalendarEvent(task) {
  return Boolean(task
    && isCalendarEvent(task)
    && !task.googleCalendarExternal
    && task.syncTarget !== 'external-calendar');
}

function addCalendarEventResizeHandle(host, task, edge) {
  if (!localResizableCalendarEvent(task)) return;
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = `event-resize-handle event-resize-${edge}`;
  handle.setAttribute('aria-label', edge === 'start' ? '拖动修改日程开始日期' : '拖动修改日程结束日期');
  handle.title = edge === 'start' ? '拖动修改开始日期' : '拖动修改结束日期';
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    handle.parentElement?.classList.add('event-resizing');
    beginCalendarEventResize(task.id, edge, event.pointerId);
  });
  handle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  host.appendChild(handle);
}

function beginCalendarEventResize(taskId, edge, pointerId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!localResizableCalendarEvent(task)) return;

  const panel = $('#calendarPanel');
  if (panel && Number.isInteger(pointerId)) {
    try {
      panel.setPointerCapture(pointerId);
    } catch {
      // Continue with the document-level pointer listeners.
    }
  }

  calendarEventResizeState = {
    taskId,
    edge,
    pointerId,
    originalStart: task.dueDate,
    originalEnd: task.endDate || task.dueDate,
    previewDate: edge === 'start' ? task.dueDate : (task.endDate || task.dueDate),
  };
  document.body.classList.add('calendar-event-resizing');
}

function calendarResizeDateAtPoint(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY);
  return target?.closest('.calendar-day')?.dataset.date || '';
}

function updateCalendarEventResize(event) {
  const resize = calendarEventResizeState;
  if (!resize) return;
  const dateKey = calendarResizeDateAtPoint(event.clientX, event.clientY);
  if (!dateKey || dateKey === resize.previewDate) return;

  const task = state.tasks.find((item) => item.id === resize.taskId);
  if (!task) return;

  if (resize.edge === 'start') {
    if (dateKey > resize.originalEnd) return;
    task.dueDate = dateKey;
    task.endDate = resize.originalEnd;
  } else {
    if (dateKey < resize.originalStart) return;
    task.dueDate = resize.originalStart;
    task.endDate = dateKey;
  }
  resize.previewDate = dateKey;
  renderCalendar();
}

async function finishCalendarEventResize(cancel = false) {
  const resize = calendarEventResizeState;
  if (!resize) return;

  const panel = $('#calendarPanel');
  if (panel && Number.isInteger(resize.pointerId)) {
    try {
      if (panel.hasPointerCapture(resize.pointerId)) panel.releasePointerCapture(resize.pointerId);
    } catch {
      // Capture may already have been released by the browser.
    }
  }

  calendarEventResizeState = null;
  document.body.classList.remove('calendar-event-resizing');

  const task = state.tasks.find((item) => item.id === resize.taskId);
  if (!task) {
    renderCalendar();
    return;
  }

  if (cancel) {
    task.dueDate = resize.originalStart;
    task.endDate = resize.originalEnd;
    renderCalendar();
    return;
  }

  task.updatedAt = Date.now();
  await persist();
  render();
}

function daysLate(task) {
  if (!task.dueDate || task.completed) return 0;
  const due = fromDateKey(task.dueDate);
  const today = fromDateKey(dayOffset(0));
  return Math.max(0, Math.round((today - due) / 86400000));
}

function taskSort(a, b) {
  const rank = (task) => {
    const externalCalendar = task.googleCalendarExternal || task.syncTarget === 'external-calendar';
    if (externalCalendar) return 0;
    if (!task.time) return 1;
    return 2;
  };
  const rankDifference = rank(a) - rank(b);
  if (rankDifference) return rankDifference;
  if (a.time && b.time) return a.time.localeCompare(b.time);
  return (a.order ?? a.createdAt) - (b.order ?? b.createdAt);
}

function projectTaskSort(a, b) {
  return (a.order ?? a.createdAt) - (b.order ?? b.createdAt);
}

function dismissEmptyProjectQuickAdd() {
  if (!activeQuickProjectId) return false;
  const input = document.querySelector(`[data-project-composer="${activeQuickProjectId}"]`);
  if (input?.value.trim()) return false;
  activeQuickProjectId = null;
  renderProjects();
  return true;
}

function formatChineseLunarDay(value) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 30) return String(value || '');
  const digits = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (day <= 9) return `初${digits[day - 1]}`;
  if (day === 10) return '初十';
  if (day < 20) return `十${digits[day - 11]}`;
  if (day === 20) return '二十';
  if (day < 30) return `廿${digits[day - 21]}`;
  return '三十';
}

function formatLunarDate(date) {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      month: 'long',
      day: 'numeric',
    }).formatToParts(date);
    const month = parts.find((part) => part.type === 'month')?.value || '';
    const rawDay = parts.find((part) => part.type === 'day')?.value || '';
    const day = /^\d+$/.test(rawDay) ? formatChineseLunarDay(rawDay) : rawDay;
    return month && day ? `农历${month}${day}` : '';
  } catch {
    return '';
  }
}

function renderHeader() {
  const dateSummary = $('#dateSummary');
  const dateSummaryText = $('#dateSummaryText');
  const pinButton = $('#pinWindowButton');
  const pinned = Boolean(state.settings.alwaysOnTop);
  pinButton.classList.toggle('active', pinned);
  pinButton.setAttribute('aria-pressed', String(pinned));
  pinButton.title = pinned ? '取消置顶' : '置顶在其他窗口上方';
  pinButton.setAttribute('aria-label', pinButton.title);

  const displayDate = taskDateFilter ? fromDateKey(taskDateFilter) : new Date();
  const lunar = formatLunarDate(displayDate);
  const dateText = `${displayDate.getMonth() + 1}月${displayDate.getDate()}日 周${WEEKDAYS[displayDate.getDay()]}`;
  dateSummaryText.textContent = dateText;
  dateSummary.classList.toggle('filtered-date', Boolean(taskDateFilter));
  dateSummary.classList.toggle('expanded', expanded);
  dateSummary.setAttribute('aria-expanded', String(expanded));
  dateSummary.title = `${displayDate.getFullYear()}年${dateText}${lunar ? ` · ${lunar}` : ''}`;
  dateSummary.setAttribute('aria-label', expanded ? '收起日历' : '展开日历');
}

function setTaskDateFilter(dateKey) {
  taskDateFilter = dateKey || null;
  if (taskDateFilter) {
    const selectedDate = fromDateKey(taskDateFilter);
    calendarCursor = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
  }
  activeQuickProjectId = null;
  renderHeader();
  renderProjects();
  renderCalendar();
}

function stepTaskDateFilter(offset) {
  const date = taskDateFilter ? fromDateKey(taskDateFilter) : fromDateKey(dayOffset(0));
  date.setDate(date.getDate() + offset);
  setTaskDateFilter(toDateKey(date));
}

function toggleTodayOrAll() {
  setTaskDateFilter(taskDateFilter ? null : dayOffset(0));
}

async function toggleAlwaysOnTop() {
  const button = $('#pinWindowButton');
  button.disabled = true;
  try {
    const actual = await window.luma?.setAlwaysOnTop(!state.settings.alwaysOnTop);
    state.settings.alwaysOnTop = Boolean(actual);
    renderHeader();
    await persist();
  } finally {
    button.disabled = false;
  }
}

function applyPanelOpacity(value) {
  const opacity = Math.min(100, Math.max(45, Number(value) || 88));
  document.documentElement.style.setProperty('--panel-opacity', String(opacity / 100));
  $('#opacityValue').textContent = `${opacity}%`;
  $('#opacitySlider').value = String(opacity);
  return opacity;
}

function schedulePanelOpacitySave() {
  clearTimeout(opacitySaveTimer);
  opacitySaveTimer = setTimeout(() => {
    opacitySaveTimer = null;
    persist().catch((error) => console.error('无法保存窗口透明度', error));
  }, 120);
}

async function flushPanelOpacitySave() {
  clearTimeout(opacitySaveTimer);
  opacitySaveTimer = null;
  await persist();
}

function applyColorMode(lightMode) {
  const enabled = Boolean(lightMode);
  document.documentElement.dataset.theme = enabled ? 'light' : 'dark';
  $('#lightModeToggle').checked = enabled;
  return enabled;
}

function taskElement(task) {
  const project = projectById(task.projectId);
  const externalCalendar = Boolean(task.googleCalendarExternal || task.syncTarget === 'external-calendar');
  const pendingCompletion = isTaskPendingCompletion(task.id);
  const visuallyCompleted = task.completed || pendingCompletion;
  const item = document.createElement('article');
  item.className = `task-item${visuallyCompleted ? ' completed' : ''}${pendingCompletion ? ' pending-completion' : ''}${externalCalendar ? ' external-calendar-event' : ''}${activeTaskMenuId === task.id ? ' menu-open' : ''}`;
  item.draggable = !visuallyCompleted && !externalCalendar;
  item.dataset.taskId = task.id;
  item.style.setProperty('--task-color', project.color);

  const late = daysLate(task);
  const meta = [];
  if (externalCalendar) meta.push(`<span class="sync-icon">${escapeAttribute(task.googleCalendarName || 'Google Calendar')}</span>`);
  if (late) meta.push(`<span class="overdue-chip">已顺延 ${late} 天</span>`);
  const scheduleParts = [];
  if (task.time) scheduleParts.push(task.time);
  if (task.dueDate) scheduleParts.push(task.dueDate === dayOffset(0) ? '今天' : formatShortDate(task.dueDate));

  item.innerHTML = `
    <button class="check" aria-label="${externalCalendar ? 'Google Calendar 事件' : (visuallyCompleted ? '恢复任务' : '完成任务')}"${externalCalendar ? ' disabled' : ''}></button>
    <div class="task-copy">
      <input class="task-title" value="${escapeAttribute(task.title)}" aria-label="任务标题"${externalCalendar ? ' readonly' : ''} />
      ${meta.length ? `<div class="task-meta">${meta.join('')}</div>` : ''}
    </div>
    <div class="task-actions">
      <span class="task-date-label">${scheduleParts.join(' · ')}</span>
      <button class="task-time task-more" title="更多操作" aria-label="${escapeAttribute(task.title)}的更多操作" aria-expanded="${String(activeTaskMenuId === task.id)}">•••</button>
    </div>`;

  if (!externalCalendar) item.querySelector('.check').addEventListener('click', () => toggleTask(task.id));
  if (!externalCalendar) item.querySelector('.task-title').addEventListener('change', (event) => updateTaskTitle(task.id, event.target.value));
  item.querySelector('.task-title').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.target.blur();
  });
  item.querySelector('.task-more').addEventListener('click', (event) => {
    event.stopPropagation();
    openTaskMenu(task.id, event.currentTarget);
  });
  item.addEventListener('dragstart', (event) => {
    draggedTaskId = task.id;
    item.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', task.id);
  });
  item.addEventListener('dragover', (event) => {
    if (!draggedTaskId || draggedTaskId === task.id) return;
    event.preventDefault();
    event.stopPropagation();
    const after = event.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2;
    item.classList.toggle('drop-before', !after);
    item.classList.toggle('drop-after', after);
  });
  item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
  item.addEventListener('drop', async (event) => {
    if (!draggedTaskId || draggedTaskId === task.id) return;
    event.preventDefault();
    event.stopPropagation();
    const after = event.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2;
    item.classList.remove('drop-before', 'drop-after');
    await reorderTask(draggedTaskId, task.id, after, task.projectId);
    draggedTaskId = null;
  });
  item.addEventListener('dragend', () => {
    draggedTaskId = null;
    item.classList.remove('dragging');
    document.querySelectorAll('.task-item.drop-before, .task-item.drop-after').forEach((row) => row.classList.remove('drop-before', 'drop-after'));
  });
  return item;
}

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function renderProjects() {
  const host = $('#projectGroups');
  host.innerHTML = '';
  const orderedProjects = [...state.projects].sort((a, b) => a.order - b.order);

  for (const project of orderedProjects) {
    const systemCalendarProject = isSystemCalendarProject(project);
    if (systemCalendarProject) continue;
    const relevant = state.tasks.filter((task) => !isCalendarEvent(task) && task.projectId === project.id && (!taskDateFilter || task.dueDate === taskDateFilter));
    const active = relevant.filter((task) => !task.completed).sort(projectTaskSort);
    const completed = relevant.filter((task) => task.completed);
    const projectCollapsed = collapsedProjects.has(project.id);
    const group = document.createElement('section');
    group.className = `project-group${projectCollapsed ? ' collapsed' : ''}`;
    group.style.setProperty('--group-color', project.color);
    group.innerHTML = `
      <header class="project-header">
        <div class="project-title" role="button" tabindex="0" draggable="true" aria-expanded="${String(!projectCollapsed)}" title="点击展开/收起，拖拽排序，双击编辑分类"><span class="project-color-dot" aria-hidden="true"></span><span class="project-name">${escapeAttribute(project.name)}</span><button class="project-collapse" type="button" tabindex="-1" aria-hidden="true"></button><span class="project-progress">${completed.length}/${relevant.length || 0}</span></div>
        <div class="project-header-actions">
          <button class="project-add-task" type="button" aria-label="在${escapeAttribute(project.name)}中添加待办" title="添加待办">＋</button>
        </div>
      </header>
      <div class="task-list" data-project-id="${project.id}"></div>
      ${activeQuickProjectId === project.id ? `<div class="project-quick-add">
        <input class="project-quick-input" autocomplete="off" aria-label="在${escapeAttribute(project.name)}中添加待办" placeholder="在此分类中快速添加待办…" />
        <button class="project-quick-submit" type="button" aria-label="添加到${escapeAttribute(project.name)}">＋</button>
      </div>` : ''}
      ${completed.length ? `<button class="completed-toggle" type="button" aria-expanded="${String(expandedCompleted.has(project.id))}" title="${expandedCompleted.has(project.id) ? '收起已完成任务' : '展开已完成任务'}"><span class="completed-toggle-check" aria-hidden="true">✓</span><span>已完成 ${completed.length}</span></button><div class="completed-list ${expandedCompleted.has(project.id) ? '' : 'collapsed'}"></div>` : ''}`;

    const list = group.querySelector('.task-list');
    active.forEach((task) => list.appendChild(taskElement(task)));
    list.addEventListener('dragover', (event) => {
      if (!draggedTaskId) return;
      event.preventDefault();
      list.classList.add('drag-over');
    });
    list.addEventListener('dragleave', () => list.classList.remove('drag-over'));
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      list.classList.remove('drag-over');
      if (draggedTaskId) {
        const taskId = draggedTaskId;
        draggedTaskId = null;
        await moveTaskToProject(taskId, project.id);
      }
    });

    const completedList = group.querySelector('.completed-list');
    if (completedList) completed.forEach((task) => completedList.appendChild(taskElement(task)));
    group.querySelector('.completed-toggle')?.addEventListener('click', () => {
      expandedCompleted.has(project.id) ? expandedCompleted.delete(project.id) : expandedCompleted.add(project.id);
      renderProjects();
    });
    const projectTitle = group.querySelector('.project-title');
    const collapseButton = group.querySelector('.project-collapse');
    let projectTitleClickTimer = null;
    let projectWasDragged = false;
    const toggleProjectCollapsed = async () => {
      if (collapsedProjects.has(project.id)) collapsedProjects.delete(project.id);
      else collapsedProjects.add(project.id);
      activeQuickProjectId = null;
      state.settings.collapsedProjectIds = [...collapsedProjects];
      await persist();
      renderProjects();
    };
    collapseButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleProjectCollapsed();
    });
    collapseButton.addEventListener('dblclick', (event) => event.stopPropagation());
    projectTitle.draggable = !systemCalendarProject;
    projectTitle.addEventListener('dragstart', (event) => {
      projectWasDragged = true;
      draggedProjectId = project.id;
      group.classList.add('project-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', project.id);
    });
    projectTitle.addEventListener('dragend', () => {
      draggedProjectId = null;
      group.classList.remove('project-dragging');
      document.querySelectorAll('.project-group.project-drop-before, .project-group.project-drop-after').forEach((item) => item.classList.remove('project-drop-before', 'project-drop-after'));
      setTimeout(() => { projectWasDragged = false; }, 0);
    });
    projectTitle.addEventListener('click', (event) => {
      if (event.target.closest('.project-collapse') || projectWasDragged) return;
      clearTimeout(projectTitleClickTimer);
      projectTitleClickTimer = setTimeout(() => {
        projectTitleClickTimer = null;
        toggleProjectCollapsed();
      }, 180);
    });
    if (!systemCalendarProject) projectTitle.addEventListener('dblclick', (event) => {
      if (event.target.closest('.project-collapse')) return;
      clearTimeout(projectTitleClickTimer);
      projectTitleClickTimer = null;
      openProjectDialog(project.id);
    });
    projectTitle.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleProjectCollapsed();
      }
    });
    group.addEventListener('dragover', (event) => {
      if (draggedTaskId) {
        event.preventDefault();
        group.classList.add('task-drop-target');
        return;
      }
      if (!draggedProjectId || draggedProjectId === project.id) return;
      event.preventDefault();
      const after = event.clientY > group.getBoundingClientRect().top + group.offsetHeight / 2;
      group.classList.toggle('project-drop-before', !after);
      group.classList.toggle('project-drop-after', after);
    });
    group.addEventListener('dragleave', (event) => {
      if (!group.contains(event.relatedTarget)) group.classList.remove('project-drop-before', 'project-drop-after', 'task-drop-target');
    });
    group.addEventListener('drop', async (event) => {
      if (draggedTaskId) {
        event.preventDefault();
        event.stopPropagation();
        group.classList.remove('task-drop-target');
        const taskId = draggedTaskId;
        draggedTaskId = null;
        await moveTaskToProject(taskId, project.id);
        return;
      }
      if (!draggedProjectId || draggedProjectId === project.id) return;
      event.preventDefault();
      event.stopPropagation();
      const after = event.clientY > group.getBoundingClientRect().top + group.offsetHeight / 2;
      group.classList.remove('project-drop-before', 'project-drop-after');
      await reorderProject(draggedProjectId, project.id, after);
      draggedProjectId = null;
    });
    const projectAddButton = group.querySelector('.project-add-task');
    projectAddButton.hidden = systemCalendarProject;
    projectAddButton.addEventListener('click', async () => {
      if (systemCalendarProject) return;
      if (collapsedProjects.delete(project.id)) {
        state.settings.collapsedProjectIds = [...collapsedProjects];
        await persist();
      }
      activeQuickProjectId = activeQuickProjectId === project.id ? null : project.id;
      renderProjects();
      if (activeQuickProjectId) requestAnimationFrame(() => document.querySelector(`[data-project-composer="${activeQuickProjectId}"]`)?.focus());
    });
    const quickInput = group.querySelector('.project-quick-input');
    if (quickInput) {
      quickInput.dataset.projectComposer = project.id;
      const submitQuickTask = () => addTaskToProject(project.id, quickInput);
      quickInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submitQuickTask();
        }
      });
      group.querySelector('.project-quick-submit').addEventListener('click', submitQuickTask);
    }
    host.appendChild(group);
  }
}

function formatShortDate(key) {
  const date = fromDateKey(key);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function renderUpcoming() {
  const upcoming = state.tasks
    .filter((task) => !isCalendarEvent(task) && !task.completed && task.dueDate > dayOffset(0))
    .sort((a, b) => `${a.dueDate}${a.time}`.localeCompare(`${b.dueDate}${b.time}`))
    .slice(0, 3);
  const host = $('#upcomingList');
  host.innerHTML = '';
  if (!upcoming.length) {
    host.innerHTML = '<p class="empty-note">未来还没有安排，留一点呼吸的空间。</p>';
    return;
  }
  upcoming.forEach((task) => {
    const date = fromDateKey(task.dueDate);
    const project = projectById(task.projectId);
    const row = document.createElement('div');
    row.className = 'upcoming-item';
    row.style.setProperty('--upcoming-project-color', project.color);
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('title', '在月历中查看');
    row.innerHTML = `
      <div class="upcoming-date"><strong>${date.getDate()}</strong><span>${date.getMonth() + 1} 月</span></div>
      <div><div class="upcoming-title">${escapeAttribute(task.title)}</div><div class="upcoming-project">${project.name}</div></div>
      <span class="upcoming-time">${task.time || '待办'}</span>`;
    row.addEventListener('click', () => openTaskInCalendar(task));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openTaskInCalendar(task);
      }
    });
    host.appendChild(row);
  });
}

async function openTaskInCalendar(task) {
  if (!task?.dueDate) return;
  highlightedTaskId = task.id;
  taskDateFilter = task.dueDate;
  calendarCursor = fromDateKey(task.dueDate);
  calendarCursor.setDate(1);
  renderHeader();
  renderProjects();
  renderCalendar();
  await toggleExpanded(true);
}

function animateCalendarMonth(direction = 0) {
  const grid = $('#calendarGrid');
  const title = $('#monthTitle');
  grid.classList.remove('month-enter-next', 'month-enter-prev');
  title.classList.remove('month-feedback');
  void grid.offsetWidth;
  if (direction > 0) grid.classList.add('month-enter-next');
  else if (direction < 0) grid.classList.add('month-enter-prev');
  title.classList.add('month-feedback');
  setTimeout(() => {
    grid.classList.remove('month-enter-next', 'month-enter-prev');
    title.classList.remove('month-feedback');
  }, 220);
}

window.addEventListener('resize', () => {
  if (calendarDetailDate) requestAnimationFrame(positionCalendarDetail);
  requestAnimationFrame(fitAllCalendarCells);
});

function changeCalendarMonth(offset, animate = true) {
  if (!offset) return;
  calendarDetailDate = null;
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + offset, 1);
  renderCalendar();
  if (animate) animateCalendarMonth(offset);
}

function goToCurrentCalendarMonth() {
  calendarDetailDate = null;
  const now = new Date();
  const currentIndex = calendarCursor.getFullYear() * 12 + calendarCursor.getMonth();
  const targetIndex = now.getFullYear() * 12 + now.getMonth();
  calendarCursor = new Date(now.getFullYear(), now.getMonth(), 1);
  renderCalendar();
  animateCalendarMonth(Math.sign(targetIndex - currentIndex));
}

function fitCalendarCellContent(cell) {
  if (!cell) return;
  const events = cell.querySelector('.day-events');
  if (!events) return;

  const items = [...events.querySelectorAll('.day-event')];
  items.forEach((item) => { item.hidden = false; });
  events.querySelector('.day-overflow')?.remove();

  let hiddenCount = Number(cell.dataset.hiddenCalendarCount || 0);
  let overflow = null;
  const ensureOverflow = () => {
    if (!overflow) {
      overflow = document.createElement('div');
      overflow.className = 'day-overflow';
      overflow.addEventListener('click', (event) => {
        event.stopPropagation();
        openCalendarDetail(cell.dataset.date);
      });
      events.appendChild(overflow);
    }
    overflow.textContent = `+${hiddenCount}`;
    overflow.title = `还有 ${hiddenCount} 项未显示，点击日期查看`;
  };

  if (hiddenCount > 0) ensureOverflow();

  // Measure only after layout exists. Hide items from the end until the actual
  // rendered cell fits; do not reserve a fixed number of rows in advance.
  let index = items.length - 1;
  while (events.scrollHeight > events.clientHeight + 1 && index >= 0) {
    items[index].hidden = true;
    hiddenCount += 1;
    ensureOverflow();
    index -= 1;
  }

  // Adding the overflow indicator itself can consume the last line.
  while (overflow && events.scrollHeight > events.clientHeight + 1 && index >= 0) {
    items[index].hidden = true;
    hiddenCount += 1;
    overflow.textContent = `+${hiddenCount}`;
    overflow.title = `还有 ${hiddenCount} 项未显示，点击日期查看`;
    index -= 1;
  }

  if (overflow && hiddenCount <= 0) overflow.remove();
}

function fitAllCalendarCells() {
  document.querySelectorAll('.calendar-day').forEach((cell) => fitCalendarCellContent(cell));
}

function renderCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  $('#monthTitle').textContent = `${year} 年 ${month + 1} 月`;
  const referenceDate = calendarDetailDate ? fromDateKey(calendarDetailDate) : (taskDateFilter ? fromDateKey(taskDateFilter) : new Date());
  const monthLunar = $('#monthLunar');
  if (referenceDate.getFullYear() === year && referenceDate.getMonth() === month) {
    const lunar = formatLunarDate(referenceDate);
    monthLunar.textContent = `${referenceDate.getMonth() + 1}月${referenceDate.getDate()}日 周${WEEKDAYS[referenceDate.getDay()]}${lunar ? ` · ${lunar}` : ''}`;
  } else {
    monthLunar.textContent = '';
  }

  const first = new Date(year, month, 1);
  const mondayIndex = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - mondayIndex);
  const host = $('#calendarGrid');
  host.innerHTML = '';

  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = toDateKey(date);
    const weekdayIndex = index % 7;

    const spanningEvents = state.tasks
      .filter((task) => !task.completed
        && isCalendarEvent(task)
        && task.dueDate
        && (task.endDate || task.dueDate) !== task.dueDate
        && eventCoversDate(task, key))
      .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || '') || (a.title || '').localeCompare(b.title || ''));

    const singleEvents = state.tasks
      .filter((task) => !task.completed
        && isCalendarEvent(task)
        && task.dueDate === key
        && (task.endDate || task.dueDate) === task.dueDate)
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

    const activeTodos = state.tasks
      .filter((task) => !isCalendarEvent(task) && !task.completed && task.dueDate === key)
      .sort(taskSort);

    const completedTodos = state.tasks
      .filter((task) => !isCalendarEvent(task) && task.completed && (task.dueDate || task.completedDate) === key)
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));

    const visibleSpans = spanningEvents.slice(0, 1);
    const visibleItems = [...singleEvents, ...activeTodos, ...completedTodos];
    const totalCount = spanningEvents.length + visibleItems.length;
    const hiddenCount = Math.max(0, spanningEvents.length - visibleSpans.length);
    const allCalendarItems = [...spanningEvents, ...singleEvents, ...activeTodos, ...completedTodos];

    const cell = document.createElement('div');
    cell.dataset.date = key;
    cell.dataset.hiddenCalendarCount = String(hiddenCount);
    cell.className = `calendar-day${date.getMonth() !== month ? ' muted' : ''}${key === dayOffset(0) ? ' today' : ''}${key === calendarDetailDate ? ' selected-date' : ''}`;
    if (totalCount > 4) cell.classList.add('crowded');
    if (allCalendarItems.some((task) => task.id === highlightedTaskId)) cell.classList.add('focused-date');

    const dayLabel = date.getMonth() !== month ? `${date.getMonth() + 1}/${date.getDate()}` : String(date.getDate());
    cell.innerHTML = `<span class="day-number">${dayLabel}</span><div class="day-spans"></div><div class="day-events"></div>`;

    const spanHost = cell.querySelector('.day-spans');
    visibleSpans.forEach((task) => {
      const endDate = task.endDate || task.dueDate;
      const beginsSegment = key === task.dueDate || weekdayIndex === 0;
      const endsSegment = key === endDate || weekdayIndex === 6;
      const segment = document.createElement('div');
      const external = Boolean(task.googleCalendarExternal || task.syncTarget === 'external-calendar');
      segment.className = `calendar-span-event${beginsSegment ? ' span-left-round' : ''}${endsSegment ? ' span-right-round' : ''}${external ? ' google-calendar-event readonly' : ''}${calendarEventResizeState?.taskId === task.id ? ' event-resizing' : ''}`;
      segment.style.setProperty('--event-color', eventColorFor(task));
      segment.textContent = beginsSegment ? `${task.time ? `${task.time} ` : ''}${task.title}` : '';
      if (key === task.dueDate) addCalendarEventResizeHandle(segment, task, 'start');
      if (key === endDate) addCalendarEventResizeHandle(segment, task, 'end');
      segment.title = `${task.title} · ${eventRangeLabel(task)}${external ? ' · Google Calendar' : ''}`;
      segment.addEventListener('click', (clickEvent) => {
        clickEvent.stopPropagation();
        openCalendarDetail(key);
      });
      spanHost.appendChild(segment);
    });

    const events = cell.querySelector('.day-events');
    visibleItems.forEach((task) => {
      const item = document.createElement('div');
      const project = projectById(task.projectId);
      const calendarEvent = isCalendarEvent(task);
      const external = Boolean(task.googleCalendarExternal || task.syncTarget === 'external-calendar');
      const pendingCompletion = !calendarEvent && isTaskPendingCompletion(task.id);
      const visuallyCompleted = task.completed || pendingCompletion;
      item.className = `day-event${calendarEvent ? ' calendar-event-item' : ' calendar-todo-item'}${visuallyCompleted ? ' completed-calendar-event' : ''}${pendingCompletion ? ' pending-completion' : ''}${task.id === highlightedTaskId ? ' highlighted' : ''}${external ? ' google-calendar-event' : ''}${calendarEventResizeState?.taskId === task.id ? ' event-resizing' : ''}`;
      item.dataset.taskId = task.id;
      item.draggable = !calendarEvent && !visuallyCompleted;
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.style.setProperty('--event-color', calendarEvent ? eventColorFor(task) : project.color);
      const calendarItemText = `${task.time ? `${task.time} ` : ''}${task.title}`;
      if (!calendarEvent) {
        const checked = task.completed || pendingCompletion;
        item.innerHTML = `<button class="calendar-todo-check${checked ? ' is-checked' : ''}" type="button" draggable="false" aria-label="${checked ? '恢复' : '完成'} ${escapeAttribute(task.title)}"></button><span class="calendar-item-label">${escapeAttribute(calendarItemText)}</span>`;
      } else {
        item.innerHTML = `<span class="calendar-item-label">${escapeAttribute(calendarItemText)}</span>`;
      }
      item.title = pendingCompletion
        ? `${task.title} · 已完成 · 再点方框可撤销`
        : (task.completed
          ? `${task.title} · 已完成 · 点击方框恢复`
          : (calendarEvent
            ? `${task.title} · 日程${external ? ' · Google Calendar（只读）' : ''}`
            : `${task.title} · 待办 · 点击文字修改安排，点击方框完成`));
      if (!calendarEvent) {
        const todoCheck = item.querySelector('.calendar-todo-check');
        todoCheck.addEventListener('pointerdown', (pointerEvent) => pointerEvent.stopPropagation());
        todoCheck.addEventListener('dblclick', (doubleClickEvent) => doubleClickEvent.stopPropagation());
        todoCheck.addEventListener('click', async (checkEvent) => {
          checkEvent.preventDefault();
          checkEvent.stopPropagation();
          await toggleTask(task.id, { preserveCalendar: true });
        });
      }
      if (calendarEvent && !external) {
        addCalendarEventResizeHandle(item, task, 'start');
        addCalendarEventResizeHandle(item, task, 'end');
      }

      item.addEventListener('dragstart', (dragEvent) => {
        if (calendarEvent || task.completed) {
          dragEvent.preventDefault();
          return;
        }
        draggedTaskId = task.id;
        item.classList.add('dragging');
        dragEvent.dataTransfer.effectAllowed = 'move';
        dragEvent.dataTransfer.setData('text/plain', task.id);
      });
      item.addEventListener('dragend', () => {
        draggedTaskId = null;
        item.classList.remove('dragging');
        document.querySelectorAll('.calendar-day.drag-over').forEach((day) => day.classList.remove('drag-over'));
      });
      item.addEventListener('click', (clickEvent) => {
        clickEvent.stopPropagation();
        if (calendarEvent) openCalendarDetail(key);
        else if (!task.completed) openCalendarTaskDialog(key, 'todo', task.id);
      });
      item.addEventListener('keydown', (keyEvent) => {
        if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
          keyEvent.preventDefault();
          if (calendarEvent) openCalendarDetail(key);
          else if (!task.completed) openCalendarTaskDialog(key, 'todo', task.id);
        }
      });
      events.appendChild(item);
    });

    cell.setAttribute('role', 'button');
    cell.setAttribute('tabindex', '0');
    cell.setAttribute('title', `${date.getMonth() + 1}月${date.getDate()}日 · 单击查看当天详情，双击添加事项`);
    cell.addEventListener('dragover', (dragEvent) => {
      if (!draggedTaskId) return;
      dragEvent.preventDefault();
      dragEvent.dataTransfer.dropEffect = 'move';
      cell.classList.add('drag-over');
    });
    cell.addEventListener('dragleave', (dragEvent) => {
      if (!cell.contains(dragEvent.relatedTarget)) cell.classList.remove('drag-over');
    });
    cell.addEventListener('drop', async (dropEvent) => {
      dropEvent.preventDefault();
      dropEvent.stopPropagation();
      cell.classList.remove('drag-over');
      const taskId = draggedTaskId || dropEvent.dataTransfer.getData('text/plain');
      draggedTaskId = null;
      if (taskId) await moveTaskToDate(taskId, key);
    });
    cell.addEventListener('click', () => openCalendarDetail(key));
    cell.addEventListener('dblclick', (event) => {
      if (event.target.closest('.day-event, .calendar-span-event, .day-overflow')) return;
      openCalendarTaskDialog(key);
    });
    cell.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === cell) {
        event.preventDefault();
        openCalendarDetail(key);
      }
    });
    host.appendChild(cell);
  }

  requestAnimationFrame(fitAllCalendarCells);
}

function setCalendarDetailView(mode) {
  calendarDetailViewMode = mode === 'editor' ? 'editor' : 'detail';
  $('#calendarDetailView')?.classList.toggle('hidden', calendarDetailViewMode !== 'detail');
  $('#calendarEditorView')?.classList.toggle('hidden', calendarDetailViewMode !== 'editor');
  requestAnimationFrame(positionCalendarDetail);
}

function closeCalendarDetail() {
  calendarDetailDate = null;
  calendarDetailViewMode = 'detail';
  editingCalendarEventId = null;
  closeTimePickers();
  const detail = $('#calendarDetail');
  $('#calendarPanel')?.classList.remove('calendar-detail-open');
  detail.classList.add('hidden');
  detail.setAttribute('aria-hidden', 'true');
  renderCalendar();
}

function positionCalendarDetail() {
  const detail = $('#calendarDetail');
  const panel = $('#calendarPanel');
  const selectedCell = calendarDetailDate
    ? panel?.querySelector(`.calendar-day[data-date="${calendarDetailDate}"]`)
    : null;
  if (!detail || !panel || !selectedCell || detail.classList.contains('hidden')) return;

  const panelRect = panel.getBoundingClientRect();
  const cellRect = selectedCell.getBoundingClientRect();
  const detailRect = detail.getBoundingClientRect();
  const gap = 10;
  const inset = 18;
  const width = detailRect.width;
  const height = detailRect.height;

  const spaceRight = panelRect.right - cellRect.right - inset;
  const spaceLeft = cellRect.left - panelRect.left - inset;
  let left;
  if (spaceRight >= width + gap || spaceRight >= spaceLeft) {
    left = cellRect.right - panelRect.left + gap;
  } else {
    left = cellRect.left - panelRect.left - width - gap;
  }
  left = Math.max(inset, Math.min(left, panelRect.width - width - inset));

  const preferredTop = cellRect.top - panelRect.top - 8;
  const minTop = 72;
  const maxTop = Math.max(minTop, panelRect.height - height - inset);
  const top = Math.max(minTop, Math.min(preferredTop, maxTop));

  detail.style.left = `${Math.round(left)}px`;
  detail.style.top = `${Math.round(top)}px`;
}

function openCalendarDetail(dateKey) {
  calendarDetailDate = dateKey;
  calendarDetailViewMode = 'detail';
  editingCalendarEventId = null;
  closeTimePickers();
  $('#calendarPanel')?.classList.add('calendar-detail-open');
  const selected = fromDateKey(dateKey);
  if (selected.getFullYear() !== calendarCursor.getFullYear() || selected.getMonth() !== calendarCursor.getMonth()) {
    calendarCursor = new Date(selected.getFullYear(), selected.getMonth(), 1);
  }
  renderCalendar();
  renderCalendarDetail();
  setCalendarDetailView('detail');
}

function renderCalendarDetail() {
  const detail = $('#calendarDetail');
  if (!detail || !calendarDetailDate || !expanded) {
    $('#calendarPanel')?.classList.remove('calendar-detail-open');
    detail?.classList.add('hidden');
    detail?.setAttribute('aria-hidden', 'true');
    return;
  }
  $('#calendarPanel')?.classList.add('calendar-detail-open');

  const selectedDate = fromDateKey(calendarDetailDate);
  const lunar = formatLunarDate(selectedDate);
  $('#calendarDetailTitle').textContent = `${selectedDate.getMonth() + 1}月${selectedDate.getDate()}日 周${WEEKDAYS[selectedDate.getDay()]}`;
  $('#calendarDetailLunar').textContent = lunar;
  detail.classList.remove('hidden');
  detail.setAttribute('aria-hidden', 'false');
  setCalendarDetailView(calendarDetailViewMode);

  const schedules = state.tasks
    .filter((task) => !task.completed && isCalendarEvent(task) && eventCoversDate(task, calendarDetailDate))
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

  const todos = state.tasks
    .filter((task) => !isCalendarEvent(task)
      && !task.completed
      && task.dueDate
      && task.dueDate <= calendarDetailDate)
    .sort((a, b) => {
      const dateDifference = (b.dueDate || '').localeCompare(a.dueDate || '');
      if (dateDifference) return dateDifference;
      if (a.time && b.time) return a.time.localeCompare(b.time);
      return projectTaskSort(a, b);
    });

  $('#calendarScheduleCount').textContent = schedules.length ? `(${schedules.length})` : '';
  $('#calendarTodoCount').textContent = todos.length ? `(${todos.length})` : '';

  const scheduleHost = $('#calendarScheduleList');
  scheduleHost.innerHTML = '';
  if (!schedules.length) {
    scheduleHost.innerHTML = '<p class="calendar-detail-empty">当天没有日程</p>';
  } else {
    schedules.forEach((task) => {
      const googleExternal = Boolean(task.googleCalendarExternal || task.syncTarget === 'external-calendar');
      const appleExternal = Boolean(task.icloudExternal);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'calendar-detail-schedule event-detail-row';
      row.style.setProperty('--detail-color', eventColorFor(task));
      row.innerHTML = `
        <span class="calendar-detail-dot"></span>
        <span class="calendar-detail-time">${escapeAttribute(eventRangeLabel(task))}</span>
        <span class="calendar-detail-task-title">${escapeAttribute(task.title)}</span>
        <span class="calendar-detail-project">${escapeAttribute(googleExternal ? (task.googleCalendarName || 'Google Calendar') : (appleExternal ? (task.icloudCalendarName || 'Apple 日历') : '日程'))}</span>
      `;
      row.title = googleExternal ? '来自 Google Calendar（只读）' : (appleExternal ? '来自 Apple 日历 · 点击编辑' : '点击编辑日程');
      row.classList.toggle('readonly', googleExternal);
      if (!googleExternal) row.addEventListener('click', () => openCalendarTaskDialog(task.dueDate, 'event', task.id));
      scheduleHost.appendChild(row);
    });
  }

  const todoHost = $('#calendarTodoList');
  todoHost.innerHTML = '';
  if (!todos.length) {
    todoHost.innerHTML = '<p class="calendar-detail-empty">没有未完成待办</p>';
  } else {
    todos.forEach((task) => {
      const project = projectById(task.projectId);
      const row = document.createElement('div');
      const pendingCompletion = isTaskPendingCompletion(task.id);
      row.className = `calendar-detail-todo-row${pendingCompletion ? ' pending-completion' : ''}`;
      row.style.setProperty('--detail-color', project.color);
      const overdue = task.dueDate < calendarDetailDate;
      row.innerHTML = `
        <button class="calendar-detail-check${pendingCompletion ? ' is-checked' : ''}" type="button" aria-label="${pendingCompletion ? '撤销完成' : '完成'} ${escapeAttribute(task.title)}"></button>
        <span class="calendar-detail-task-title">${escapeAttribute(task.time ? `${task.time} ${task.title}` : task.title)}</span>
        ${overdue ? '<span class="calendar-detail-overdue">之前</span>' : ''}
        <span class="calendar-detail-project">${escapeAttribute(project.name)}</span>
      `;
      row.title = '点击编辑待办';
      row.querySelector('.calendar-detail-check').addEventListener('click', (event) => {
        event.stopPropagation();
        toggleTask(task.id);
      });
      row.addEventListener('click', () => openCalendarTaskDialog(task.dueDate || calendarDetailDate, 'todo', task.id));
      todoHost.appendChild(row);
    });
  }
}

async function moveTaskToDate(taskId, dateKey) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || task.googleCalendarExternal || task.syncTarget === 'external-calendar' || task.dueDate === dateKey) return;
  task.dueDate = dateKey;
  task.updatedAt = Date.now();
  await persist();
  render();
}

function syncCalendarEventEndTimeState() {
  const endTimeInput = $('#calendarTaskEndTime');
  if (!endTimeInput) return;

  const eventMode = calendarCreateMode === 'event';
  const rawStart = String($('#calendarTaskTime')?.value || '').trim();
  const allDay = eventMode && (!rawStart || rawStart === '全天');

  endTimeInput.disabled = allDay;
  if (!eventMode) return;

  if (allDay) {
    endTimeInput.value = '全天';
    return;
  }

  const normalizedStart = normalizeTimeValue(rawStart);
  if (normalizedStart && (!endTimeInput.value || endTimeInput.value === '全天')) {
    endTimeInput.value = addMinutesToTime(normalizedStart, 30);
  }
}

function setCalendarItemMode(mode) {
  const nextMode = mode === 'event' ? 'event' : 'todo';
  calendarCreateMode = nextMode;

  if (nextMode === 'event') {
    const startInput = $('#calendarTaskTime');
    if (!String(startInput?.value || '').trim()) startInput.value = '全天';
    if (!$('#calendarTaskEndDate').value) $('#calendarTaskEndDate').value = $('#calendarTaskDate').value;
  } else if (String($('#calendarTaskTime')?.value || '').trim() === '全天') {
    $('#calendarTaskTime').value = '';
  }

  syncCalendarEventEndTimeState();
  updateCalendarItemDialogMode();
}

function updateCalendarItemDialogMode() {
  const eventMode = calendarCreateMode === 'event';
  $('#calendarTaskEndDateLabel').hidden = !eventMode;
  $('#calendarTaskEndTimeLabel').hidden = !eventMode;
  $('#calendarTaskProjectLabel').hidden = eventMode;
  $('#calendarEventColorLabel').hidden = !eventMode;

  document.querySelectorAll('[data-calendar-mode]').forEach((button) => {
    const active = button.dataset.calendarMode === calendarCreateMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  if (eventMode) renderEventColorChoices();
  syncCalendarEventEndTimeState();

  if (!editingCalendarEventId) {
    $('#calendarTaskDialogTitle').textContent = '新建事项';
    $('#calendarTaskTitleText').textContent = '事项内容';
    $('#calendarTaskSubmit').textContent = '添加事项';
  } else {
    $('#calendarTaskDialogTitle').textContent = eventMode ? '编辑日程' : '编辑待办';
    $('#calendarTaskTitleText').textContent = eventMode ? '日程内容' : '待办内容';
    $('#calendarTaskSubmit').textContent = eventMode ? '保存日程' : '保存待办';
  }

  $('#calendarTaskDateText').textContent = eventMode ? '开始日期' : '待办日期';
  $('#calendarTaskTimeText').textContent = eventMode ? '开始时间' : '时间';
  const editingItem = editingCalendarEventId ? state.tasks.find((task) => task.id === editingCalendarEventId) : null;
  $('#calendarItemTypeHint').textContent = eventMode
    ? (editingItem?.icloudExternal
      ? '来自 Apple 日历；保存后点击 Apple「同步」即可同步回 iPhone'
      : '日程可设为全天，也可以设置开始和结束时间，并支持跨日期')
    : '待办可以设置日期和具体时间，仍会保留在「我的待办」';
  $('#deleteCalendarEventButton').hidden = !editingCalendarEventId;
  if (editingCalendarEventId) $('#deleteCalendarEventButton').textContent = '删除事项';
}

function openCalendarTaskDialog(dateKey, mode = 'todo', itemId = null) {
  const editingItem = itemId
    ? state.tasks.find((task) => task.id === itemId && !task.googleCalendarExternal && task.syncTarget !== 'external-calendar')
    : null;
  const editingEvent = editingItem && isCalendarEvent(editingItem);

  calendarDetailDate = dateKey;
  calendarDetailViewMode = 'editor';
  $('#calendarPanel')?.classList.add('calendar-detail-open');

  const selected = fromDateKey(dateKey);
  if (selected.getFullYear() !== calendarCursor.getFullYear() || selected.getMonth() !== calendarCursor.getMonth()) {
    calendarCursor = new Date(selected.getFullYear(), selected.getMonth(), 1);
  }

  editingCalendarEventId = editingItem?.id || null;
  calendarCreateMode = editingItem
    ? (editingEvent ? 'event' : 'todo')
    : (mode === 'event' ? 'event' : 'todo');
  selectedEventColor = editingEvent ? eventColorFor(editingItem) : DEFAULT_EVENT_COLOR;

  $('#calendarTaskTitle').value = editingItem?.title || '';
  $('#calendarTaskDate').value = editingItem?.dueDate || dateKey;
  $('#calendarTaskEndDate').value = editingEvent
    ? (editingItem.endDate || editingItem.dueDate || dateKey)
    : dateKey;
  $('#calendarTaskTime').value = editingItem
    ? (editingEvent ? (editingItem.time || '全天') : (editingItem.time || ''))
    : (calendarCreateMode === 'event' ? '全天' : '');
  $('#calendarTaskEndTime').value = editingEvent
    ? (editingItem.time ? (editingItem.endTime || addMinutesToTime(editingItem.time, 30)) : '全天')
    : (calendarCreateMode === 'event' ? '全天' : '');
  $('#calendarTaskProject').innerHTML = projectOptions(editingItem && !editingEvent ? editingItem.projectId : 'inbox');

  renderCalendar();
  renderCalendarDetail();
  updateCalendarItemDialogMode();
  setCalendarDetailView('editor');
  requestAnimationFrame(() => $('#calendarTaskTitle').focus());
}

async function createCalendarTask(event) {
  event.preventDefault();
  const title = $('#calendarTaskTitle').value.trim();
  if (!title) return;

  const eventMode = calendarCreateMode === 'event';
  const rawStartTime = String($('#calendarTaskTime').value || '').trim();
  const allDay = eventMode && (!rawStartTime || rawStartTime === '全天');
  let time = '';

  if (!allDay && rawStartTime) {
    const normalized = normalizeTimeValue(rawStartTime);
    if (normalized === null) {
      $('#calendarTaskTime').setCustomValidity(eventMode
        ? '请选择“全天”或输入 00:00–23:59'
        : '请选择“无时间”或输入 00:00–23:59');
      $('#calendarTaskTime').reportValidity();
      return;
    }
    time = normalized;
  } else if (!eventMode && rawStartTime === '全天') {
    $('#calendarTaskTime').setCustomValidity('待办可以无时间或设置具体时间');
    $('#calendarTaskTime').reportValidity();
    return;
  }
  $('#calendarTaskTime').setCustomValidity('');

  const dueDate = $('#calendarTaskDate').value;
  let endDate = '';
  let endTime = '';

  if (eventMode) {
    endDate = $('#calendarTaskEndDate').value || dueDate;
    if (endDate < dueDate) {
      $('#calendarTaskEndDate').setCustomValidity('结束日期不能早于开始日期');
      $('#calendarTaskEndDate').reportValidity();
      return;
    }
    $('#calendarTaskEndDate').setCustomValidity('');

    if (!allDay) {
      const rawEndTime = String($('#calendarTaskEndTime').value || '').trim();
      endTime = normalizeTimeValue(rawEndTime) || '';
      if (!endTime) {
        endTime = addMinutesToTime(time, 30);
        $('#calendarTaskEndTime').value = endTime;
      }

      const startMoment = new Date(`${dueDate}T${time}:00`);
      const endMoment = new Date(`${endDate}T${endTime}:00`);
      if (endMoment <= startMoment) {
        $('#calendarTaskEndTime').setCustomValidity('结束时间必须晚于开始时间');
        $('#calendarTaskEndTime').reportValidity();
        return;
      }
    }
  }
  $('#calendarTaskEndTime').setCustomValidity('');

  if (editingCalendarEventId) {
    const task = state.tasks.find((item) => item.id === editingCalendarEventId);
    if (task && !task.googleCalendarExternal && task.syncTarget !== 'external-calendar') {
      task.title = title;
      task.dueDate = dueDate;
      task.completed = false;

      if (eventMode) {
        task.endDate = endDate;
        task.time = allDay ? '' : time;
        task.endTime = allDay ? '' : endTime;
        task.eventColor = selectedEventColor;
        task.itemType = 'event';
        task.projectId = task.icloudExternal ? 'apple-calendar' : 'inbox';
        task.syncTarget = 'calendar';
      } else {
        task.endDate = '';
        task.endTime = '';
        task.time = time;
        task.eventColor = '';
        task.itemType = 'todo';
        task.projectId = $('#calendarTaskProject').value || 'inbox';
        task.syncTarget = 'tasks';
      }

      task.updatedAt = Date.now();
      editingCalendarEventId = null;
      calendarDetailDate = dueDate;
      calendarDetailViewMode = 'detail';
      closeTimePickers();
      await persist();
      render();
      setCalendarDetailView('detail');
      return;
    }
  }

  const task = {
    id: uid(),
    title,
    projectId: eventMode ? 'inbox' : ($('#calendarTaskProject').value || 'inbox'),
    dueDate,
    endDate,
    endTime: eventMode && !allDay ? endTime : '',
    time: allDay ? '' : time,
    eventColor: eventMode ? selectedEventColor : '',
    itemType: eventMode ? 'event' : 'todo',
    completed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    order: Date.now(),
    syncTarget: eventMode ? 'calendar' : 'tasks',
  };

  state.tasks.push(task);
  calendarDetailDate = dueDate;
  calendarDetailViewMode = 'detail';
  closeTimePickers();
  await persist();
  render();
  setCalendarDetailView('detail');
}

async function deleteEditingCalendarEvent() {
  const taskId = editingCalendarEventId;
  if (!taskId) return;
  editingCalendarEventId = null;
  calendarDetailViewMode = 'detail';
  closeTimePickers();
  await deleteTask(taskId);
  setCalendarDetailView('detail');
}


const TIME_OPTIONS = Array.from({ length: 96 }, (_, index) => {
  const hour = Math.floor(index / 4);
  const minute = (index % 4) * 15;
  return `${pad(hour)}:${pad(minute)}`;
});

function normalizeTimeValue(raw) {
  const value = String(raw || '').trim().replaceAll('：', ':');
  if (!value) return '';
  let hour;
  let minute;
  let match = value.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (match) {
    hour = Number(match[1]);
    minute = match[2] == null ? 0 : Number(match[2]);
  } else if (/^\d{3,4}$/.test(value)) {
    hour = Number(value.slice(0, -2));
    minute = Number(value.slice(-2));
  } else {
    return null;
  }
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

function addMinutesToTime(time, minutes) {
  const normalized = normalizeTimeValue(time);
  if (!normalized) return '';
  const [hour, minute] = normalized.split(':').map(Number);
  const total = (hour * 60 + minute + minutes + 1440) % 1440;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function validatedTimeField(input) {
  const normalized = normalizeTimeValue(input.value);
  if (normalized === null) {
    input.setCustomValidity('请输入 00:00–23:59 之间的时间');
    input.reportValidity();
    return { valid: false, value: '' };
  }
  input.setCustomValidity('');
  input.value = normalized;
  return { valid: true, value: normalized };
}

function closeTimePickers(except = null) {
  document.querySelectorAll('.time-picker').forEach((picker) => {
    if (picker !== except) picker.hidden = true;
  });
}

function populateTimePicker(picker) {
  if (picker.dataset.ready === '1') return;
  picker.dataset.ready = '1';
  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'time-option time-option-none';
  none.dataset.time = '';
  none.textContent = '无时间';
  picker.appendChild(none);
  if (picker.closest('#calendarTaskForm')) {
    const allDay = document.createElement('button');
    allDay.type = 'button';
    allDay.className = 'time-option time-option-all-day';
    allDay.dataset.time = '全天';
    allDay.textContent = '全天';
    picker.appendChild(allDay);
  }
  TIME_OPTIONS.forEach((time) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'time-option';
    button.dataset.time = time;
    button.textContent = time;
    picker.appendChild(button);
  });
}

function openTimePicker(input) {
  const picker = input.closest('.time-field')?.querySelector('.time-picker');
  if (!picker || input.disabled) return;

  populateTimePicker(picker);
  closeTimePickers(picker);

  const isCalendarStart = input.id === 'calendarTaskTime';
  const isCalendarEnd = input.id === 'calendarTaskEndTime';
  const calendarEventTime = calendarCreateMode === 'event' && (isCalendarStart || isCalendarEnd);
  const allowAllDay = isCalendarStart && calendarCreateMode === 'event';
  const noneOption = picker.querySelector('.time-option-none');
  const allDayOption = picker.querySelector('.time-option-all-day');
  if (noneOption) noneOption.hidden = calendarEventTime;
  if (allDayOption) allDayOption.hidden = !allowAllDay;

  const rawValue = String(input.value || '').trim();
  const selected = allowAllDay && rawValue === '全天'
    ? '全天'
    : normalizeTimeValue(rawValue);

  picker.querySelectorAll('.time-option').forEach((option) => {
    option.classList.toggle('selected', option.dataset.time === (selected || ''));
  });

  picker.hidden = false;
  requestAnimationFrame(() => {
    if (allowAllDay && allDayOption) {
      picker.scrollTop = Math.max(0, allDayOption.offsetTop);
      return;
    }

    let target = selected ? picker.querySelector(`.time-option[data-time="${selected}"]`) : null;
    if (!target) {
      const now = new Date();
      const roundedMinutes = Math.min(45, Math.round(now.getMinutes() / 15) * 15);
      const roundedHour = roundedMinutes === 60 ? (now.getHours() + 1) % 24 : now.getHours();
      const minute = roundedMinutes === 60 ? 0 : roundedMinutes;
      const near = `${pad(roundedHour)}:${pad(minute)}`;
      target = picker.querySelector(`.time-option[data-time="${near}"]`);
    }
    target?.scrollIntoView({ block: 'center' });
  });
}

function bindTimePickers() {
  document.querySelectorAll('.time-text-input').forEach((input) => {
    const picker = input.closest('.time-field')?.querySelector('.time-picker');
    if (!picker) return;

    populateTimePicker(picker);
    input.addEventListener('focus', () => openTimePicker(input));
    input.addEventListener('click', () => openTimePicker(input));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        openTimePicker(input);
      } else if (event.key === 'Escape') {
        picker.hidden = true;
      }
    });

    input.addEventListener('blur', () => {
      const raw = String(input.value || '').trim();
      const allowAllDay = input.id === 'calendarTaskTime' && calendarCreateMode === 'event';
      if (allowAllDay && raw === '全天') {
        input.setCustomValidity('');
        syncCalendarEventEndTimeState();
        return;
      }

      const normalized = normalizeTimeValue(raw);
      if (normalized !== null) {
        input.value = normalized;
        input.setCustomValidity('');
      }
      if (input.id === 'calendarTaskTime') syncCalendarEventEndTimeState();
    });

    picker.addEventListener('pointerdown', (event) => event.preventDefault());
    picker.addEventListener('click', (event) => {
      const option = event.target.closest('.time-option');
      if (!option || option.hidden) return;

      input.value = option.dataset.time;
      input.setCustomValidity('');

      if (input.id === 'calendarTaskTime') {
        syncCalendarEventEndTimeState();
      }

      input.dispatchEvent(new Event('change', { bubbles: true }));
      picker.hidden = true;
      input.focus();
    });
  });

  $('#calendarTaskTime')?.addEventListener('input', syncCalendarEventEndTimeState);
  $('#calendarTaskTime')?.addEventListener('change', syncCalendarEventEndTimeState);

  document.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.time-field')) return;
    closeTimePickers();
  });
  $('#scheduleDialog')?.addEventListener('close', () => closeTimePickers());
}

function render() {
  renderHeader();
  renderProjects();
  renderCalendar();
  renderCalendarDetail();
}

async function addTaskToProject(projectId, input) {
  const raw = input.value.trim();
  if (!raw) return;
  const task = {
    id: uid(),
    title: raw,
    projectId,
    dueDate: taskDateFilter || dayOffset(0),
    time: '',
    itemType: 'todo',
    completed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    order: Date.now(),
    syncTarget: 'tasks',
  };
  state.tasks.push(task);
  input.value = '';
  activeQuickProjectId = null;
  await persist();
  render();
}

async function addTask() {
  await addTaskToProject('inbox', $('#quickInput'));
}

function isTaskPendingCompletion(id) {
  return pendingTaskCompletions.has(id);
}

function cancelPendingTaskCompletion(id) {
  const timer = pendingTaskCompletions.get(id);
  if (timer) clearTimeout(timer);
  pendingTaskCompletions.delete(id);
}

function syncCalendarTodoCompletionUi(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;

  const pendingCompletion = isTaskPendingCompletion(id);
  const visuallyCompleted = task.completed || pendingCompletion;

  document.querySelectorAll('.calendar-todo-item').forEach((item) => {
    if (item.dataset.taskId !== id) return;

    item.classList.toggle('completed-calendar-event', visuallyCompleted);
    item.classList.toggle('pending-completion', pendingCompletion);
    item.draggable = !visuallyCompleted;

    const check = item.querySelector('.calendar-todo-check');
    if (check) {
      check.classList.toggle('is-checked', visuallyCompleted);
      check.setAttribute('aria-label', `${visuallyCompleted ? '恢复' : '完成'} ${task.title}`);
    }

    item.title = pendingCompletion
      ? `${task.title} · 已完成 · 再点方框可撤销`
      : (task.completed
        ? `${task.title} · 已完成 · 点击方框恢复`
        : `${task.title} · 待办 · 点击文字修改安排，点击方框完成`);
  });
}

function renderTaskCompletionChange(id, preserveCalendar = false) {
  if (!preserveCalendar) {
    render();
    return;
  }

  renderHeader();
  renderProjects();
  syncCalendarTodoCompletionUi(id);
  renderCalendarDetail();
}

async function finalizeTaskCompletion(id, { preserveCalendar = false } = {}) {
  if (!pendingTaskCompletions.has(id)) return;
  pendingTaskCompletions.delete(id);

  const task = state.tasks.find((item) => item.id === id);
  if (!task || task.completed || task.googleCalendarExternal || task.syncTarget === 'external-calendar') return;

  task.completed = true;
  task.completedDate = dayOffset(0);
  task.updatedAt = Date.now();
  await persist();
  renderTaskCompletionChange(id, preserveCalendar);
}

async function toggleTask(id, { preserveCalendar = false } = {}) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task || task.googleCalendarExternal || task.syncTarget === 'external-calendar') return;

  // A second click during the grace period is the undo action.
  if (isTaskPendingCompletion(id)) {
    cancelPendingTaskCompletion(id);
    renderTaskCompletionChange(id, preserveCalendar);
    return;
  }

  // Tasks already stored in Completed restore immediately.
  if (task.completed) {
    task.completed = false;
    task.completedDate = null;
    task.updatedAt = Date.now();
    await persist();
    renderTaskCompletionChange(id, preserveCalendar);
    return;
  }

  // Show completion feedback immediately, but do not persist/move the task yet.
  const timer = setTimeout(() => {
    finalizeTaskCompletion(id, { preserveCalendar }).catch((error) => console.error('无法完成待办', error));
  }, COMPLETION_GRACE_MS);
  pendingTaskCompletions.set(id, timer);
  renderTaskCompletionChange(id, preserveCalendar);
}

async function updateTaskTitle(id, title) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task || task.googleCalendarExternal || task.syncTarget === 'external-calendar') return;
  task.title = title.trim() || task.title;
  task.updatedAt = Date.now();
  await persist();
  render();
}

async function moveTaskToProject(id, projectId) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task || isSystemCalendarProject(projectId) || task.googleCalendarExternal || task.syncTarget === 'external-calendar') return;
  task.projectId = projectId;
  task.updatedAt = Date.now();
  const targetOrders = state.tasks
    .filter((item) => item.projectId === projectId && item.id !== id)
    .map((item) => item.order ?? item.createdAt);
  task.order = targetOrders.length ? Math.max(...targetOrders) + 1 : 0;
  await persist();
  render();
}

async function reorderProject(draggedId, targetId, placeAfter) {
  const projects = [...state.projects].sort((a, b) => a.order - b.order);
  const dragged = projects.find((project) => project.id === draggedId);
  if (!dragged) return;
  const remaining = projects.filter((project) => project.id !== draggedId);
  const targetIndex = remaining.findIndex((project) => project.id === targetId);
  if (targetIndex < 0) return;
  remaining.splice(targetIndex + (placeAfter ? 1 : 0), 0, dragged);
  const updatedAt = Date.now();
  remaining.forEach((project, index) => {
    project.order = index;
    project.updatedAt = updatedAt;
  });
  state.projectsUpdatedAt = updatedAt;
  await persist();
  render();
}

async function reorderTask(draggedId, targetId, placeAfter, projectId) {
  const dragged = state.tasks.find((item) => item.id === draggedId);
  const target = state.tasks.find((item) => item.id === targetId);
  if (!dragged || !target || dragged.googleCalendarExternal || dragged.syncTarget === 'external-calendar') return;
  const siblings = state.tasks
    .filter((item) => item.projectId === projectId && !item.completed && item.id !== draggedId)
    .sort(projectTaskSort);
  const targetIndex = siblings.findIndex((item) => item.id === targetId);
  if (targetIndex < 0) return;
  dragged.projectId = projectId;
  siblings.splice(targetIndex + (placeAfter ? 1 : 0), 0, dragged);
  const updatedAt = Date.now();
  siblings.forEach((item, index) => {
    item.order = index;
    item.updatedAt = updatedAt;
  });
  await persist();
  render();
}

function closeTaskMenu() {
  activeTaskMenuId = null;
  $('#taskMenu').classList.add('hidden');
  $('#taskMenu').setAttribute('aria-hidden', 'true');
  document.querySelectorAll('.task-item.menu-open').forEach((item) => item.classList.remove('menu-open'));
  document.querySelectorAll('.task-more[aria-expanded="true"]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
}

function openTaskMenu(taskId, anchor) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const externalCalendar = Boolean(task.googleCalendarExternal || task.syncTarget === 'external-calendar');
  activeTaskMenuId = taskId;
  document.querySelectorAll('.task-item.menu-open').forEach((item) => item.classList.remove('menu-open'));
  document.querySelectorAll('.task-more[aria-expanded="true"]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  anchor.closest('.task-item')?.classList.add('menu-open');
  anchor.setAttribute('aria-expanded', 'true');
  $('#taskMenuTitle').textContent = task.title;
  $('#taskScheduleSummary').textContent = `${task.dueDate ? formatShortDate(task.dueDate) : '无日期'}${task.time ? ` · ${task.time}` : ''}`;
  $('#taskScheduleAction').hidden = externalCalendar;
  $('#taskProjectChoices').closest('.task-menu-section').hidden = externalCalendar;
  $('#taskDeleteAction').hidden = externalCalendar;
  $('#taskConvertEventAction').hidden = externalCalendar || task.completed || isCalendarEvent(task);
  $('#taskCalendarAction').disabled = externalCalendar;
  $('#taskCalendarAction').innerHTML = externalCalendar
    ? `<span>来自 ${escapeAttribute(task.googleCalendarName || 'Google Calendar')}</span><small>只读同步</small>`
    : `<span>同步到 Google Calendar</span><small>${state.settings.googleConnected ? (task.syncTarget === 'calendar' ? '已选择' : '未选择') : '未连接'}</small>`;
  const choices = $('#taskProjectChoices');
  choices.innerHTML = '';
  [...state.projects].filter((project) => project.id !== 'google-calendar').sort((a, b) => a.order - b.order).forEach((project) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `task-project-choice${project.id === task.projectId ? ' selected' : ''}`;
    button.innerHTML = `<i style="--choice-color:${project.color}"></i><span>${escapeAttribute(project.name)}</span>${project.id === task.projectId ? '<b>✓</b>' : ''}`;
    button.addEventListener('click', async () => {
      closeTaskMenu();
      await moveTaskToProject(task.id, project.id);
    });
    choices.appendChild(button);
  });
  const menu = $('#taskMenu');
  menu.classList.remove('hidden');
  menu.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(10, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 10));
    const top = Math.max(10, Math.min(rect.bottom + 6, window.innerHeight - menuRect.height - 10));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  });
}

async function convertTaskToCalendarEvent(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || task.completed || isCalendarEvent(task) || task.googleCalendarExternal || task.syncTarget === 'external-calendar') return;
  task.itemType = 'event';
  task.dueDate = task.dueDate || dayOffset(0);
  task.endDate = task.dueDate;
  task.endTime = task.time ? addMinutesToTime(task.time, 30) : '';
  task.eventColor = DEFAULT_EVENT_COLOR;
  task.syncTarget = 'calendar';
  task.updatedAt = Date.now();
  activeTaskMenuId = null;
  closeTaskMenu();
  await persist();
  render();
}

async function toggleTaskCalendar() {
  const task = state.tasks.find((item) => item.id === activeTaskMenuId);
  if (!task || task.googleCalendarExternal || task.syncTarget === 'external-calendar') return;
  if (!state.settings.googleConnected) {
    closeTaskMenu();
    $('#googleNote').textContent = 'Google Calendar 尚未连接。配置 Google OAuth 凭据后，才可以同步任务。';
    $('#settingsDialog').showModal();
    return;
  }
  task.syncTarget = task.syncTarget === 'calendar' ? 'tasks' : 'calendar';
  task.updatedAt = Date.now();
  closeTaskMenu();
  await persist();
  render();
}

async function deleteTask(id) {
  cancelPendingTaskCompletion(id);
  const task = state.tasks.find((item) => item.id === id);
  if (task?.googleCalendarExternal || task?.syncTarget === 'external-calendar') return;
  if (task && state.settings.googleConnected && (task.googleCalendarEventId || task.googleTaskId)) {
    try {
      await window.luma?.googleDeleteTask(task);
    } catch (error) {
      $('#googleNote').textContent = `Google 中的对应事项未能删除：${error.message}`;
    }
  }
  state.tasks = state.tasks.filter((task) => task.id !== id);
  await persist();
  render();
}

async function editTaskSchedule(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task || task.googleCalendarExternal || task.syncTarget === 'external-calendar') return;
  editingScheduleTaskId = id;
  $('#scheduleTaskTitle').textContent = task.title;
  $('#scheduleDate').value = task.dueDate || '';
  $('#scheduleTime').value = task.time || '';
  $('#scheduleDialog').showModal();
  requestAnimationFrame(() => $('#scheduleDate').focus());
}

async function saveTaskSchedule(event) {
  event.preventDefault();
  const task = state.tasks.find((item) => item.id === editingScheduleTaskId);
  if (!task || task.googleCalendarExternal || task.syncTarget === 'external-calendar') return;

  const timeResult = validatedTimeField($('#scheduleTime'));
  if (!timeResult.valid) return;

  task.dueDate = $('#scheduleDate').value;
  task.time = timeResult.value;
  task.itemType = 'todo';
  task.endDate = '';
  task.endTime = '';
  task.eventColor = '';
  task.updatedAt = Date.now();

  $('#scheduleDialog').close();
  editingScheduleTaskId = null;
  await persist();
  render();
}

async function clearTaskSchedule() {
  const task = state.tasks.find((item) => item.id === editingScheduleTaskId);
  if (!task || task.googleCalendarExternal || task.syncTarget === 'external-calendar') return;
  task.dueDate = '';
  task.time = '';
  task.reminder = null;
  task.syncTarget = 'tasks';
  task.updatedAt = Date.now();
  $('#scheduleDialog').close();
  editingScheduleTaskId = null;
  await persist();
  render();
}

async function toggleExpanded(force) {
  const nextExpanded = typeof force === 'boolean' ? force : !expanded;
  if (calendarTransitioning || nextExpanded === expanded) return;

  const app = $('#app');
  const calendarPanel = $('#calendarPanel');
  const toggleButton = $('#dateSummary');
  const todoWidth = document.querySelector('.todo-panel').getBoundingClientRect().width;

  calendarTransitioning = true;
  app.style.setProperty('--todo-column-width', `${Math.round(todoWidth)}px`);
  app.classList.add('calendar-transition');
  calendarPanel.setAttribute('aria-hidden', 'true');
  toggleButton.disabled = true;
  toggleButton.setAttribute('aria-busy', 'true');

  try {
    // Paint the hidden transition state before resizing the transparent window.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await window.luma?.setExpanded(nextExpanded);
    expanded = nextExpanded;
    if (!expanded) {
      calendarDetailDate = null;
      $('#calendarPanel')?.classList.remove('calendar-detail-open');
    }
    app.classList.toggle('expanded', expanded);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  } finally {
    app.classList.remove('calendar-transition');
    calendarPanel.setAttribute('aria-hidden', String(!expanded));
    const displayDate = taskDateFilter ? fromDateKey(taskDateFilter) : new Date();
    const lunar = formatLunarDate(displayDate);
    const dateText = `${displayDate.getMonth() + 1}月${displayDate.getDate()}日 周${WEEKDAYS[displayDate.getDay()]}`;
    toggleButton.title = `${displayDate.getFullYear()}年${dateText}${lunar ? ` · ${lunar}` : ''}`;
    toggleButton.setAttribute('aria-label', expanded ? '收起日历' : '展开日历');
    toggleButton.setAttribute('aria-expanded', String(expanded));
    toggleButton.classList.toggle('expanded', expanded);
    toggleButton.disabled = false;
    toggleButton.removeAttribute('aria-busy');
    calendarTransitioning = false;
  }
}

function renderColorChoices() {
  const host = $('#colorChoices');
  host.innerHTML = '';
  COLORS.forEach((color) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `color-choice${color === selectedProjectColor ? ' selected' : ''}`;
    button.dataset.color = color;
    button.setAttribute('aria-label', `选择分类颜色 ${color}`);
    button.setAttribute('aria-pressed', String(color === selectedProjectColor));
    button.style.background = color;
    button.style.color = color;
    button.addEventListener('click', () => {
      selectedProjectColor = color;
      host.querySelectorAll('.color-choice').forEach((choice) => {
        const selected = choice.dataset.color === color;
        choice.classList.toggle('selected', selected);
        choice.setAttribute('aria-pressed', String(selected));
      });
    });
    host.appendChild(button);
  });
}

async function saveProject(event) {
  event.preventDefault();
  const name = $('#projectName').value.trim();
  if (!name) return;
  const selectedButtonColor = $('#colorChoices .color-choice.selected')?.dataset.color;
  if (COLORS.includes(selectedButtonColor)) selectedProjectColor = selectedButtonColor;
  const updatedAt = Date.now();
  if (editingProjectId) {
    const project = state.projects.find((item) => item.id === editingProjectId);
    if (project) {
      project.name = name;
      project.color = selectedProjectColor;
      project.updatedAt = updatedAt;
    }
  } else {
    const project = { id: uid(), name, color: selectedProjectColor, order: state.projects.length, updatedAt };
    state.projects.push(project);
    const task = state.tasks.find((item) => item.id === projectCreationTaskId);
    if (task) {
      task.projectId = project.id;
      task.updatedAt = Date.now();
    }
  }
  state.projectsUpdatedAt = updatedAt;
  projectCreationTaskId = null;
  $('#projectName').value = '';
  $('#projectDialog').close();
  await persist();
  render();
}

function openProjectDialog(projectId = null, taskId = null) {
  editingProjectId = projectId;
  projectCreationTaskId = projectId ? null : taskId;
  const project = state.projects.find((item) => item.id === projectId);
  selectedProjectColor = project?.color || COLORS[state.projects.length % COLORS.length];
  $('#projectDialogTitle').textContent = project ? '编辑分类' : '添加分类';
  $('#projectSubmitButton').textContent = project ? '保存修改' : '创建分类';
  $('#projectName').value = project?.name || '';
  $('#deleteProjectButton').hidden = !project || project.id === 'inbox';
  renderColorChoices();
  $('#projectDialog').showModal();
  requestAnimationFrame(() => $('#projectName').focus());
}

async function deleteProject() {
  const project = state.projects.find((item) => item.id === editingProjectId);
  if (!project || project.id === 'inbox') return;
  if (!window.confirm(`删除分类“${project.name}”？其中的任务会移到“未分类”。`)) return;
  state.tasks.forEach((task) => {
    if (task.projectId === project.id) {
      task.projectId = 'inbox';
      task.updatedAt = Date.now();
    }
  });
  state.projects = state.projects.filter((item) => item.id !== project.id);
  state.projectsUpdatedAt = Date.now();
  $('#projectDialog').close();
  editingProjectId = null;
  await persist();
  render();
}

function googleErrorMessage(error) {
  return String(error?.message || error || '未知错误').replace(/^Error invoking remote method '[^']+':\s*/i, '');
}

function renderGoogleStatus(status) {
  const connected = Boolean(status?.connected);
  state.settings.googleConnected = connected;
  $('#googleStatusText').textContent = connected ? '已连接 · Tasks 与 Calendar' : '未连接';
  $('#connectGoogle').textContent = status?.requiresCalendarReauth ? '重新授权' : (connected ? '同步' : '连接');
  $('#disconnectGoogle').hidden = !connected;
  if (!status?.credentialsAvailable) {
    $('#googleNote').textContent = '项目目录中没有找到 credentials.json。';
    $('#connectGoogle').disabled = true;
  } else {
    $('#connectGoogle').disabled = false;
    if (status?.requiresCalendarReauth) {
      $('#googleNote').textContent = '同步多个 Google 日历需要新增权限，请点击“重新授权”。';
    }
  }
}

async function refreshGoogleStatus() {
  try {
    const status = await window.luma?.googleStatus();
    renderGoogleStatus(status);
    return status;
  } catch (error) {
    renderGoogleStatus({ connected: false, credentialsAvailable: false });
    $('#googleNote').textContent = `无法检查 Google 连接：${googleErrorMessage(error)}`;
    return { connected: false, credentialsAvailable: false };
  }
}

async function syncGoogle() {
  const button = $('#connectGoogle');
  button.disabled = true;
  $('#googleNote').textContent = '正在同步，请稍候…';
  try {
    const result = await window.luma?.googleSync(state);
    state = normalizeState(result.state);
    state.settings.googleConnected = true;
    await persist();
    render();
    const {
      uploaded = 0,
      downloaded = 0,
      deleted = 0,
      externalCalendarDownloaded = 0,
      projectsUploaded = 0,
      projectsDownloaded = 0,
    } = result.summary || {};
    const projectNote = projectsUploaded || projectsDownloaded
      ? `，分类上传 ${projectsUploaded} 组、下载 ${projectsDownloaded} 组`
      : '';
    const calendarNote = externalCalendarDownloaded ? `，其中 Google 日历事件 ${externalCalendarDownloaded} 项` : '';
    $('#googleNote').textContent = `同步完成：任务上传 ${uploaded} 项、下载 ${downloaded} 项、移除 ${deleted} 项${calendarNote}${projectNote}。`;
  } catch (error) {
    $('#googleNote').textContent = `同步失败：${googleErrorMessage(error)}。请确认 Calendar API 和 Tasks API 均已启用。`;
  } finally {
    button.disabled = false;
  }
}

async function connectOrSyncGoogle() {
  const button = $('#connectGoogle');
  button.disabled = true;
  try {
    let status = await window.luma?.googleStatus();
    if (!status.connected || status.requiresCalendarReauth) {
      $('#googleNote').textContent = '请在浏览器中选择 Google 账号并允许访问…';
      status = await window.luma?.googleConnect();
      status.credentialsAvailable = true;
      renderGoogleStatus(status);
      state.settings.googleConnected = true;
      await persist();
    }
    await syncGoogle();
  } catch (error) {
    $('#googleNote').textContent = `连接失败：${googleErrorMessage(error)}`;
    await refreshGoogleStatus();
  } finally {
    button.disabled = false;
  }
}

async function disconnectGoogle() {
  const button = $('#disconnectGoogle');
  button.disabled = true;
  try {
    const status = await window.luma?.googleDisconnect();
    renderGoogleStatus(status);
    state.settings.googleConnected = false;
    await persist();
    render();
    $('#googleNote').textContent = '已断开 Google；本地待办不会被删除。';
  } catch (error) {
    $('#googleNote').textContent = `断开失败：${googleErrorMessage(error)}`;
  } finally {
    button.disabled = false;
  }
}


function renderIcloudStatus(status) {
  const connected = Boolean(status && status.connected);
  const calendars = Array.isArray(status && status.calendars) ? status.calendars : [];
  const credentialPanel = $('#icloudCredentialPanel');
  const calendarPanel = $('#icloudCalendarPanel');
  const calendarSelect = $('#icloudCalendarSelect');
  const connectButton = $('#connectIcloud');

  $('#icloudStatusText').textContent = connected
    ? '已连接 · ' + calendars.length + ' 个日历'
    : ((status && status.demo) ? 'Demo 中不可连接' : '未连接');

  connectButton.hidden = false;
  connectButton.textContent = connected ? '同步' : '连接';
  $('#disconnectIcloud').hidden = !connected;
  credentialPanel.hidden = connected;
  calendarPanel.hidden = !connected;

  if (connected) {
    $('#icloudEmail').value = (status && status.email) || '';
    $('#icloudPassword').value = '';

    const currentValue = calendarSelect.value;
    calendarSelect.innerHTML = '<option value="">选择 iCloud 日历…</option>';
    calendars.forEach((calendar) => {
      const option = document.createElement('option');
      option.value = calendar.url;
      option.textContent = calendar.name || '未命名日历';
      calendarSelect.appendChild(option);
    });

    const preferred = (status && status.selectedCalendarUrl) || currentValue || '';
    if (preferred && calendars.some((calendar) => calendar.url === preferred)) {
      calendarSelect.value = preferred;
    }

    connectButton.disabled = false;
    $('#icloudNote').textContent = calendarSelect.value
      ? 'Luma 日程和有日期的待办将同步到所选 iCloud 日历。'
      : '请选择用于 Luma 日程和待办的 iCloud 日历。';
  } else if (status && status.demo) {
    $('#icloudNote').textContent = '演示模式不会连接真实 iCloud 账户；请用 npm run start:icloud 测试。';
    connectButton.disabled = true;
    calendarSelect.innerHTML = '<option value="">选择 iCloud 日历…</option>';
  } else {
    $('#icloudNote').textContent = '使用 Apple 账户邮箱和 App 专用密码连接。';
    connectButton.disabled = false;
    calendarSelect.innerHTML = '<option value="">选择 iCloud 日历…</option>';
  }
}

async function refreshIcloudStatus() {
  try {
    const status = await window.luma?.icloudStatus();
    renderIcloudStatus(status);
    return status;
  } catch (error) {
    renderIcloudStatus({ connected: false });
    $('#icloudNote').textContent = '无法检查 iCloud 连接：' + googleErrorMessage(error);
    return { connected: false };
  }
}

async function connectIcloud() {
  const button = $('#connectIcloud');
  const email = $('#icloudEmail').value.trim();
  const password = $('#icloudPassword').value.trim();
  if (!email || !password) {
    $('#icloudNote').textContent = '请先填写 Apple 账户邮箱和 App 专用密码。';
    return;
  }

  button.disabled = true;
  $('#icloudNote').textContent = '正在连接 iCloud 并发现日历…';
  try {
    const status = await window.luma?.icloudConnect({ email, password });
    renderIcloudStatus(status);
  } catch (error) {
    $('#icloudPassword').value = '';
    $('#icloudNote').textContent = '连接失败：' + googleErrorMessage(error);
  } finally {
    button.disabled = false;
  }
}

async function syncIcloud() {
  const button = $('#connectIcloud');
  const calendarUrl = $('#icloudCalendarSelect').value;
  if (!calendarUrl) {
    $('#icloudNote').textContent = '请先选择要写入的 iCloud 日历。';
    return;
  }

  button.disabled = true;
  $('#icloudNote').textContent = '正在同步 Luma 日程与待办到 iCloud…';
  try {
    const result = await window.luma?.icloudSync({ state, calendarUrl });
    state = normalizeState(result.state);
    await persist();
    render();
    const summary = result.summary || {};
    $('#icloudNote').textContent =
      '同步完成：从 iCloud 下载 ' + (summary.downloaded || 0) + ' 项、删除 ' + (summary.deleted || 0)
      + ' 项；上传新增 ' + (summary.created || 0) + '、更新 ' + (summary.updated || 0)
      + '。当前日程 ' + (summary.syncedEvents || 0) + ' 项，待办镜像 ' + (summary.mirroredTodos || 0) + ' 项。';
  } catch (error) {
    $('#icloudNote').textContent = '同步失败：' + googleErrorMessage(error);
  } finally {
    button.disabled = false;
  }
}

async function connectOrSyncIcloud() {
  const status = await window.luma?.icloudStatus();
  if (status && status.connected) {
    await syncIcloud();
    return;
  }
  await connectIcloud();
}

async function disconnectIcloud() {
  const button = $('#disconnectIcloud');
  button.disabled = true;
  try {
    const status = await window.luma?.icloudDisconnect();
    renderIcloudStatus(status);
    $('#icloudEmail').value = '';
    $('#icloudPassword').value = '';
    $('#icloudNote').textContent = '已断开 iCloud；Luma 本地日程不会被删除。';
  } catch (error) {
    $('#icloudNote').textContent = '断开失败：' + googleErrorMessage(error);
  } finally {
    button.disabled = false;
  }
}

function bindEvents() {
  document.addEventListener('pointerdown', (event) => {
    // Pin owns its own WorkerW detach/topmost transition. Running the generic
    // desktop activation first can reparent the native window during the same
    // pointer gesture and race the Pin click.
    if (event.target.closest('#pinWindowButton')) return;
    window.luma?.activate();
  }, { capture: true });
  document.addEventListener('pointerdown', (event) => {
    if (!activeQuickProjectId || event.target.closest('.project-quick-add, .project-add-task')) return;
    dismissEmptyProjectQuickAdd();
  });
  document.querySelectorAll('.resize-handle').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      window.luma?.resizeStart({ edge: handle.dataset.edge, x: event.screenX, y: event.screenY });
    });
    handle.addEventListener('pointermove', (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      window.luma?.resizeMove({ x: event.screenX, y: event.screenY });
    });
    handle.addEventListener('pointerup', (event) => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      window.luma?.resizeEnd();
    });
    handle.addEventListener('pointercancel', () => window.luma?.resizeEnd());
  });
  $('#addTask').addEventListener('click', addTask);
  $('#quickInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') addTask(); });
  $('#dateSummary').addEventListener('click', () => toggleExpanded());
  $('#pinWindowButton').addEventListener('click', toggleAlwaysOnTop);
  $('#hideButton').addEventListener('click', () => window.luma?.hide());
  $('#prevMonth').addEventListener('click', () => changeCalendarMonth(-1));
  $('#nextMonth').addEventListener('click', () => changeCalendarMonth(1));
  $('#todayMonth').addEventListener('click', goToCurrentCalendarMonth);
  $('#closeCalendarDetail').addEventListener('click', closeCalendarDetail);
  $('#backCalendarDetail').addEventListener('click', () => {
    editingCalendarEventId = null;
    closeTimePickers();
    setCalendarDetailView('detail');
    renderCalendarDetail();
  });

  document.addEventListener('pointermove', (event) => {
    if (calendarEventResizeState && event.pointerId === calendarEventResizeState.pointerId) {
      updateCalendarEventResize(event);
    }
  });
  document.addEventListener('pointerup', (event) => {
    if (calendarEventResizeState && event.pointerId === calendarEventResizeState.pointerId) {
      finishCalendarEventResize(false);
    }
  });
  document.addEventListener('pointercancel', (event) => {
    if (calendarEventResizeState && event.pointerId === calendarEventResizeState.pointerId) {
      finishCalendarEventResize(true);
    }
  });
  window.addEventListener('blur', () => {
    if (calendarEventResizeState) finishCalendarEventResize(true);
  });

  document.addEventListener('pointerdown', (event) => {
    if (!calendarDetailDate) return;
    if (event.target.closest('#calendarDetail')) return;
    if (event.target.closest('.calendar-day')) return;
    if (event.target.closest('.month-controls')) return;
    if (event.target.closest('#dateSummary')) return;
    if (!event.target.closest('#calendarPanel')) return;
    closeCalendarDetail();
  }, { capture: true });
  $('#addCalendarItem').addEventListener('click', () => {
    if (calendarDetailDate) openCalendarTaskDialog(calendarDetailDate);
  });

  $('#calendarPanel').addEventListener('wheel', (event) => {
    if (event.target.closest('#calendarDetail')) return;
    if (!expanded || event.ctrlKey || event.shiftKey || document.querySelector('dialog[open]')) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    const delta = event.deltaMode === 1
      ? event.deltaY * 16
      : event.deltaMode === 2
        ? event.deltaY * window.innerHeight
        : event.deltaY;
    if (Math.abs(delta) < 1) return;

    event.preventDefault();

    const now = performance.now();
    if (now < calendarWheelLockedUntil) return;

    calendarWheelDelta += delta;
    if (calendarWheelResetTimer) clearTimeout(calendarWheelResetTimer);
    calendarWheelResetTimer = setTimeout(() => {
      calendarWheelDelta = 0;
      calendarWheelResetTimer = null;
    }, 180);

    if (Math.abs(calendarWheelDelta) < 90) return;

    const direction = calendarWheelDelta > 0 ? 1 : -1;
    calendarWheelDelta = 0;
    calendarWheelLockedUntil = now + 300;
    changeCalendarMonth(direction);
  }, { passive: false });
  $('#newProjectButton').addEventListener('click', () => openProjectDialog());
  $('#cancelProjectButton').addEventListener('click', () => $('#projectDialog').close());
  $('#deleteProjectButton').addEventListener('click', deleteProject);
  $('#projectForm').addEventListener('submit', saveProject);
  $('#cancelScheduleButton').addEventListener('click', () => $('#scheduleDialog').close());
  $('#clearScheduleButton').addEventListener('click', clearTaskSchedule);
  $('#scheduleForm').addEventListener('submit', saveTaskSchedule);
  $('#cancelCalendarTaskButton').addEventListener('click', closeCalendarDetail);
  $('#deleteCalendarEventButton').addEventListener('click', deleteEditingCalendarEvent);
  $('#calendarTaskForm').addEventListener('submit', createCalendarTask);
  $('#calendarModeTodo').addEventListener('click', () => setCalendarItemMode('todo'));
  $('#calendarModeEvent').addEventListener('click', () => setCalendarItemMode('event'));
  $('#closeTaskMenu').addEventListener('click', closeTaskMenu);
  $('#taskScheduleAction').addEventListener('click', () => {
    const taskId = activeTaskMenuId;
    closeTaskMenu();
    if (taskId) editTaskSchedule(taskId);
  });
  $('#taskNewProjectAction').addEventListener('click', () => {
    const taskId = activeTaskMenuId;
    closeTaskMenu();
    openProjectDialog(null, taskId);
  });
  $('#taskCalendarAction').addEventListener('click', toggleTaskCalendar);
  $('#taskConvertEventAction').addEventListener('click', () => {
    const taskId = activeTaskMenuId;
    if (taskId) convertTaskToCalendarEvent(taskId);
  });
  $('#taskDeleteAction').addEventListener('click', () => {
    const taskId = activeTaskMenuId;
    closeTaskMenu();
    if (taskId) deleteTask(taskId);
  });
  document.addEventListener('click', (event) => {
    if (!$('#taskMenu').classList.contains('hidden') && !$('#taskMenu').contains(event.target) && !event.target.closest('.task-more')) closeTaskMenu();
  });

  document.querySelectorAll('[data-reminder]').forEach((button) => button.addEventListener('click', async () => {
    const task = state.tasks.find((item) => item.id === pendingReminderTaskId);
    if (task) task.reminder = button.dataset.reminder === 'none' ? null : Number(button.dataset.reminder);
    pendingReminderTaskId = null;
    $('#reminderPopover').classList.add('hidden');
    await persist();
    render();
  }));

  const settingsDialog = $('#settingsDialog');
  let settingsCloseTimer = null;
  const closeSettingsDialog = () => {
    if (!settingsDialog.open || settingsDialog.classList.contains('closing')) return;
    settingsDialog.classList.add('closing');
    settingsCloseTimer = setTimeout(() => {
      if (settingsDialog.open) settingsDialog.close();
      settingsDialog.classList.remove('closing');
      settingsCloseTimer = null;
    }, 150);
  };
  const openSettingsDialog = () => {
    if (settingsCloseTimer) clearTimeout(settingsCloseTimer);
    settingsCloseTimer = null;
    settingsDialog.classList.remove('closing');
    if (!settingsDialog.open) settingsDialog.show();
    requestAnimationFrame(() => {
      const anchor = $('#settingsButton').getBoundingClientRect();
      const bounds = settingsDialog.getBoundingClientRect();
      const left = Math.max(10, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 10));
      const top = Math.max(10, Math.min(anchor.bottom + 7, window.innerHeight - bounds.height - 10));
      settingsDialog.style.left = `${Math.round(left)}px`;
      settingsDialog.style.top = `${Math.round(top)}px`;
    });
  };

  $('#settingsButton').addEventListener('click', async () => {
    $('#autoStartToggle').checked = await window.luma?.getAutoStart();
    $('#lightModeToggle').checked = Boolean(state.settings.lightMode);
    $('#opacitySlider').value = state.settings.panelOpacity;
    applyPanelOpacity(state.settings.panelOpacity);
    openSettingsDialog();
    await Promise.all([refreshGoogleStatus(), refreshIcloudStatus()]);
  });
  $('#closeSettingsButton').addEventListener('click', closeSettingsDialog);
  settingsDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeSettingsDialog();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!settingsDialog.open || settingsDialog.classList.contains('closing')) return;
    if (settingsDialog.contains(event.target) || event.target.closest('#settingsButton')) return;
    closeSettingsDialog();
  });
  settingsDialog.addEventListener('close', () => {
    if (settingsCloseTimer) clearTimeout(settingsCloseTimer);
    settingsCloseTimer = null;
    settingsDialog.classList.remove('closing');
  });
  $('#opacitySlider').addEventListener('input', (event) => {
    state.settings.panelOpacity = applyPanelOpacity(event.target.value);
    schedulePanelOpacitySave();
  });
  $('#opacitySlider').addEventListener('change', flushPanelOpacitySave);
  $('#lightModeToggle').addEventListener('change', async (event) => {
    state.settings.lightMode = applyColorMode(event.target.checked);
    await persist();
  });
  $('#autoStartToggle').addEventListener('change', async (event) => {
    const actual = await window.luma?.setAutoStart(event.target.checked);
    event.target.checked = Boolean(actual);
    state.settings.autoStart = Boolean(actual);
    await persist();
  });
  $('#exportButton').addEventListener('click', async () => {
    const success = await window.luma?.exportData(state);
    if (success) $('#exportButton').textContent = '已导出 ✓';
    setTimeout(() => { $('#exportButton').textContent = '导出本地备份'; }, 1800);
  });
  $('#connectGoogle').addEventListener('click', connectOrSyncGoogle);
  $('#disconnectGoogle').addEventListener('click', disconnectGoogle);
  $('#connectIcloud').addEventListener('click', connectOrSyncIcloud);
  $('#disconnectIcloud').addEventListener('click', disconnectIcloud);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && settingsDialog.open) {
      closeSettingsDialog();
      return;
    }
    if (event.key === 'Escape' && dismissEmptyProjectQuickAdd()) return;
    if (event.key === 'Escape' && !$('#taskMenu').classList.contains('hidden')) {
      closeTaskMenu();
      return;
    }
    if (event.key === 'Escape' && calendarDetailDate && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      closeCalendarDetail();
      return;
    }
    if (event.key === 'Escape' && expanded && !document.querySelector('dialog[open]')) toggleExpanded(false);
  });
}

async function init() {
  const saved = await window.luma?.load();
  state = normalizeState(saved);
  collapsedProjects = new Set(state.settings.collapsedProjectIds);
  applyColorMode(state.settings.lightMode);
  applyPanelOpacity(state.settings.panelOpacity);
  bindEvents();
  bindTimePickers();
  renderColorChoices();
  render();
  await Promise.all([refreshGoogleStatus(), refreshIcloudStatus()]);
}

init();
