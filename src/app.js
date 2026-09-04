const COLORS = [
  '#d94f70', '#f06a3f', '#e2c94c', '#4fa56f', '#7289f5', '#8b6ef5',
  '#ef7180', '#f58a3d', '#c5cf52', '#4aa6a1', '#8796cf', '#a88478',
  '#e95736', '#f0a85a', '#82b45b', '#4da7c9', '#aa98cf', '#8b8e92',
  '#df8278', '#f3bd55', '#4fb58f', '#5d8de0', '#a878ad', '#b5a99b',
];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

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
    if (task.googleCalendarExternal) task.time = '';
    task.projectId ??= 'inbox';
    task.syncTarget ??= task.time ? 'calendar' : 'tasks';
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

function projectOptions(selectedId = 'inbox') {
  return [...state.projects]
    .filter((project) => project.id !== 'google-calendar')
    .sort((a, b) => a.order - b.order)
    .map((project) => `<option value="${escapeAttribute(project.id)}"${project.id === selectedId ? ' selected' : ''}>${escapeAttribute(project.name)}</option>`)
    .join('');
}

function daysLate(task) {
  if (!task.dueDate || task.completed) return 0;
  const due = fromDateKey(task.dueDate);
  const today = fromDateKey(dayOffset(0));
  return Math.max(0, Math.round((today - due) / 86400000));
}

function isTodayTask(task) {
  return !task.completed && (!task.dueDate || task.dueDate <= dayOffset(0));
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
  const item = document.createElement('article');
  item.className = `task-item${task.completed ? ' completed' : ''}${externalCalendar ? ' external-calendar-event' : ''}${activeTaskMenuId === task.id ? ' menu-open' : ''}`;
  item.draggable = !task.completed && !externalCalendar;
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
    <button class="check" aria-label="${externalCalendar ? 'Google Calendar 事件' : (task.completed ? '恢复任务' : '完成任务')}"${externalCalendar ? ' disabled' : ''}></button>
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
    const relevant = state.tasks.filter((task) => task.projectId === project.id && (!taskDateFilter || task.dueDate === taskDateFilter));
    const googleCalendarProject = project.id === 'google-calendar';
    if (googleCalendarProject && (!taskDateFilter || !relevant.length)) continue;
    const active = relevant.filter((task) => !task.completed).sort(projectTaskSort);
    const completed = relevant.filter((task) => task.completed);
    const projectCollapsed = collapsedProjects.has(project.id);
    const group = document.createElement('section');
    group.className = `project-group${projectCollapsed ? ' collapsed' : ''}`;
    group.style.setProperty('--group-color', project.color);
    group.innerHTML = `
      <header class="project-header">
        <div class="project-title" role="button" tabindex="0" draggable="true" title="拖拽排序，双击编辑分类"><button class="project-collapse" type="button" aria-label="${projectCollapsed ? '展开' : '折叠'}${escapeAttribute(project.name)}" aria-expanded="${String(!projectCollapsed)}"></button><span class="project-name">${escapeAttribute(project.name)}</span><span class="project-progress">${completed.length}/${relevant.length || 0}</span></div>
        <div class="project-header-actions">
          <button class="project-add-task" type="button" aria-label="在${escapeAttribute(project.name)}中添加待办" title="添加待办">＋</button>
        </div>
      </header>
      <div class="task-list" data-project-id="${project.id}"></div>
      ${activeQuickProjectId === project.id ? `<div class="project-quick-add">
        <input class="project-quick-input" autocomplete="off" aria-label="在${escapeAttribute(project.name)}中添加待办" placeholder="在此分类中快速添加待办…" />
        <button class="project-quick-submit" type="button" aria-label="添加到${escapeAttribute(project.name)}">＋</button>
      </div>` : ''}
      ${completed.length ? `<button class="completed-toggle">已完成 ${completed.length} ${expandedCompleted.has(project.id) ? '⌃' : '⌄'}</button><div class="completed-list ${expandedCompleted.has(project.id) ? '' : 'collapsed'}"></div>` : ''}`;

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
    collapseButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (collapsedProjects.has(project.id)) collapsedProjects.delete(project.id);
      else collapsedProjects.add(project.id);
      activeQuickProjectId = null;
      state.settings.collapsedProjectIds = [...collapsedProjects];
      await persist();
      renderProjects();
    });
    collapseButton.addEventListener('dblclick', (event) => event.stopPropagation());
    projectTitle.draggable = !googleCalendarProject;
    projectTitle.addEventListener('dragstart', (event) => {
      draggedProjectId = project.id;
      group.classList.add('project-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', project.id);
    });
    projectTitle.addEventListener('dragend', () => {
      draggedProjectId = null;
      group.classList.remove('project-dragging');
      document.querySelectorAll('.project-group.project-drop-before, .project-group.project-drop-after').forEach((item) => item.classList.remove('project-drop-before', 'project-drop-after'));
    });
    if (!googleCalendarProject) projectTitle.addEventListener('dblclick', () => openProjectDialog(project.id));
    projectTitle.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !googleCalendarProject) openProjectDialog(project.id);
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
    projectAddButton.hidden = googleCalendarProject;
    projectAddButton.addEventListener('click', async () => {
      if (googleCalendarProject) return;
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
    .filter((task) => !task.completed && task.dueDate > dayOffset(0))
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
    const tasks = state.tasks.filter((task) => !task.completed && task.dueDate === key).sort(taskSort);
    const cell = document.createElement('div');
    cell.dataset.date = key;
    cell.className = `calendar-day${date.getMonth() !== month ? ' muted' : ''}${key === dayOffset(0) ? ' today' : ''}${key === calendarDetailDate ? ' selected-date' : ''}`;
    if (tasks.length > 4) cell.classList.add('crowded');
    if (tasks.some((task) => task.id === highlightedTaskId)) cell.classList.add('focused-date');
    const dayLabel = date.getMonth() !== month ? `${date.getMonth() + 1}/${date.getDate()}` : String(date.getDate());
    cell.innerHTML = `<span class="day-number">${dayLabel}</span><div class="day-events"></div>`;
    const events = cell.querySelector('.day-events');
    tasks.slice(0, 3).forEach((task) => {
      const event = document.createElement('div');
      const project = projectById(task.projectId);
      const externalCalendar = Boolean(task.googleCalendarExternal || task.syncTarget === 'external-calendar');
      event.className = `day-event${task.id === highlightedTaskId ? ' highlighted' : ''}${externalCalendar ? ' google-calendar-event' : ''}`;
      event.draggable = !externalCalendar;
      event.setAttribute('role', 'button');
      event.setAttribute('tabindex', '0');
      event.style.setProperty('--event-color', project.color);
      event.textContent = `${task.time ? `${task.time} ` : ''}${task.title}`;
      event.title = externalCalendar ? `${task.title} · 来自 Google Calendar（只读）` : `${task.title} · 点击修改安排`;
      event.addEventListener('dragstart', (dragEvent) => {
        draggedTaskId = task.id;
        event.classList.add('dragging');
        dragEvent.dataTransfer.effectAllowed = 'move';
        dragEvent.dataTransfer.setData('text/plain', task.id);
      });
      event.addEventListener('dragend', () => {
        draggedTaskId = null;
        event.classList.remove('dragging');
        document.querySelectorAll('.calendar-day.drag-over').forEach((day) => day.classList.remove('drag-over'));
      });
      event.addEventListener('click', (clickEvent) => {
        clickEvent.stopPropagation();
        if (!externalCalendar) editTaskSchedule(task.id);
      });
      event.addEventListener('keydown', (keyEvent) => {
        if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
          keyEvent.preventDefault();
          if (!externalCalendar) editTaskSchedule(task.id);
        }
      });
      events.appendChild(event);
    });
    if (tasks.length > 3) {
      const overflow = document.createElement('div');
      overflow.className = 'day-overflow';
      overflow.textContent = `+${tasks.length - 3}`;
      overflow.title = `还有 ${tasks.length - 3} 项待办，点击日期查看`;
      events.appendChild(overflow);
    }
    cell.setAttribute('role', 'button');
    cell.setAttribute('tabindex', '0');
    cell.setAttribute('title', `${date.getMonth() + 1}月${date.getDate()}日 · 单击查看当天详情，双击添加待办`);
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
    cell.addEventListener('dblclick', () => openCalendarTaskDialog(key));
    cell.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === cell) {
        event.preventDefault();
        openCalendarDetail(key);
      }
    });
    host.appendChild(cell);
  }
}

function closeCalendarDetail() {
  calendarDetailDate = null;
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
  if (calendarDetailDate === dateKey) {
    closeCalendarDetail();
    return;
  }
  calendarDetailDate = dateKey;
  $('#calendarPanel')?.classList.add('calendar-detail-open');
  const selected = fromDateKey(dateKey);
  if (selected.getFullYear() !== calendarCursor.getFullYear() || selected.getMonth() !== calendarCursor.getMonth()) {
    calendarCursor = new Date(selected.getFullYear(), selected.getMonth(), 1);
  }
  renderCalendar();
  renderCalendarDetail();
  requestAnimationFrame(positionCalendarDetail);
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
  requestAnimationFrame(positionCalendarDetail);

  const schedules = state.tasks
    .filter((task) => !task.completed
      && task.dueDate === calendarDetailDate
      && (task.time || task.syncTarget === 'calendar' || task.googleCalendarExternal || task.syncTarget === 'external-calendar'))
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

  const todos = state.tasks
    .filter((task) => !task.completed
      && task.dueDate
      && task.dueDate <= calendarDetailDate
      && !task.time
      && task.syncTarget !== 'calendar'
      && !task.googleCalendarExternal
      && task.syncTarget !== 'external-calendar')
    .sort((a, b) => {
      const dateDifference = (b.dueDate || '').localeCompare(a.dueDate || '');
      return dateDifference || projectTaskSort(a, b);
    });

  $('#calendarScheduleCount').textContent = schedules.length ? `(${schedules.length})` : '';
  $('#calendarTodoCount').textContent = todos.length ? `(${todos.length})` : '';

  const scheduleHost = $('#calendarScheduleList');
  scheduleHost.innerHTML = '';
  if (!schedules.length) {
    scheduleHost.innerHTML = '<p class="calendar-detail-empty">当天没有有时间的日程</p>';
  } else {
    schedules.forEach((task) => {
      const project = projectById(task.projectId);
      const external = Boolean(task.googleCalendarExternal || task.syncTarget === 'external-calendar');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'calendar-detail-schedule';
      row.style.setProperty('--detail-color', project.color);
      row.innerHTML = `
        <span class="calendar-detail-dot"></span>
        <span class="calendar-detail-time">${escapeAttribute(task.time || '日程')}</span>
        <span class="calendar-detail-task-title">${escapeAttribute(task.title)}</span>
        <span class="calendar-detail-project">${escapeAttribute(project.name)}</span>
      `;
      row.title = external ? '来自 Google Calendar（只读）' : '点击修改安排';
      if (external) row.classList.add('readonly');
      else row.addEventListener('click', () => editTaskSchedule(task.id));
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
      row.className = 'calendar-detail-todo-row';
      row.style.setProperty('--detail-color', project.color);
      const overdue = task.dueDate < calendarDetailDate;
      row.innerHTML = `
        <button class="calendar-detail-check" type="button" aria-label="完成 ${escapeAttribute(task.title)}"></button>
        <span class="calendar-detail-task-title">${escapeAttribute(task.title)}</span>
        ${overdue ? '<span class="calendar-detail-overdue">之前</span>' : ''}
        <span class="calendar-detail-project">${escapeAttribute(project.name)}</span>
      `;
      row.querySelector('.calendar-detail-check').addEventListener('click', () => toggleTask(task.id));
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

function openCalendarTaskDialog(dateKey) {
  $('#calendarTaskTitle').value = '';
  $('#calendarTaskDate').value = dateKey;
  $('#calendarTaskTime').value = '';
  $('#calendarTaskProject').innerHTML = projectOptions('inbox');
  $('#calendarTaskDialog').showModal();
  requestAnimationFrame(() => $('#calendarTaskTitle').focus());
}

async function createCalendarTask(event) {
  event.preventDefault();
  const title = $('#calendarTaskTitle').value.trim();
  if (!title) return;
  const timeResult = validatedTimeField($('#calendarTaskTime'));
  if (!timeResult.valid) return;
  const task = {
    id: uid(),
    title,
    projectId: $('#calendarTaskProject').value || 'inbox',
    dueDate: $('#calendarTaskDate').value,
    time: timeResult.value,
    completed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    order: Date.now(),
    syncTarget: timeResult.value ? 'calendar' : 'tasks',
  };
  state.tasks.push(task);
  $('#calendarTaskDialog').close();
  await persist();
  render();
  if (task.time) {
    pendingReminderTaskId = task.id;
    $('#reminderPopover').classList.remove('hidden');
  }
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
  if (!picker) return;
  populateTimePicker(picker);
  closeTimePickers(picker);
  const selected = normalizeTimeValue(input.value);
  picker.querySelectorAll('.time-option').forEach((option) => {
    option.classList.toggle('selected', option.dataset.time === (selected || ''));
  });
  picker.hidden = false;
  requestAnimationFrame(() => {
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
      const normalized = normalizeTimeValue(input.value);
      if (normalized !== null) {
        input.value = normalized;
        input.setCustomValidity('');
      }
    });
    picker.addEventListener('pointerdown', (event) => event.preventDefault());
    picker.addEventListener('click', (event) => {
      const option = event.target.closest('.time-option');
      if (!option) return;
      input.value = option.dataset.time;
      input.setCustomValidity('');
      input.dispatchEvent(new Event('change', { bubbles: true }));
      picker.hidden = true;
      input.focus();
    });
  });
  document.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.time-field')) return;
    closeTimePickers();
  });
  document.querySelectorAll('#scheduleDialog, #calendarTaskDialog').forEach((dialog) => {
    dialog.addEventListener('close', () => closeTimePickers());
  });
}

function render() {
  renderHeader();
  renderProjects();
  renderCalendar();
  renderCalendarDetail();
}

function parseQuickInput(raw) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let date = new Date(now);
  let hasDate = false;
  let matchedDateText = '';

  const relative = [
    { regex: /后天/, offset: 2 },
    { regex: /明天/, offset: 1 },
    { regex: /今天|今日/, offset: 0 },
  ].find((item) => item.regex.test(raw));
  if (relative) {
    date.setDate(date.getDate() + relative.offset);
    hasDate = true;
    matchedDateText = raw.match(relative.regex)?.[0] || '';
  }

  const weekdayMatch = raw.match(/(?:周|星期)([一二三四五六日天])/);
  if (weekdayMatch) {
    const target = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[weekdayMatch[1]];
    let diff = (target - now.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    date.setDate(date.getDate() + diff);
    hasDate = true;
    matchedDateText = weekdayMatch[0];
  }

  const absoluteMatch = raw.match(/(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})日?/);
  if (absoluteMatch) {
    const year = Number(absoluteMatch[1] || now.getFullYear());
    date = new Date(year, Number(absoluteMatch[2]) - 1, Number(absoluteMatch[3]));
    if (!absoluteMatch[1] && date < now) date.setFullYear(date.getFullYear() + 1);
    hasDate = true;
    matchedDateText = absoluteMatch[0];
  }

  let time = '';
  let matchedTimeText = '';
  const colonTime = raw.match(/(?:上午|早上|中午|下午|晚上|凌晨)?\s*(\d{1,2}):(\d{2})/);
  const chineseTime = raw.match(/(上午|早上|中午|下午|晚上|凌晨)?\s*(\d{1,2})\s*点(?:(半)|(\d{1,2})\s*分?)?/);
  if (colonTime || chineseTime) {
    const match = colonTime || chineseTime;
    const period = match[0].match(/上午|早上|中午|下午|晚上|凌晨/)?.[0] || '';
    let hour = Number(colonTime ? colonTime[1] : chineseTime[2]);
    const minute = Number(colonTime ? colonTime[2] : (chineseTime[3] ? 30 : chineseTime[4] || 0));
    if (['下午', '晚上'].includes(period) && hour < 12) hour += 12;
    if (period === '中午' && hour < 11) hour += 12;
    if (period === '凌晨' && hour === 12) hour = 0;
    time = `${pad(hour)}:${pad(minute)}`;
    matchedTimeText = match[0].trim();
    if (!hasDate) hasDate = true;
  }

  let title = raw.replace(matchedDateText, '').replace(matchedTimeText, '').replace(/加入(?:谷歌|Google)?日历/gi, '').trim();
  title = title.replace(/^[，,。\s]+|[，,。\s]+$/g, '') || raw.trim();
  return { title, dueDate: hasDate ? toDateKey(date) : dayOffset(0), time };
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

async function toggleTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task || task.googleCalendarExternal || task.syncTarget === 'external-calendar') return;
  task.completed = !task.completed;
  task.completedDate = task.completed ? dayOffset(0) : null;
  task.updatedAt = Date.now();
  await persist();
  render();
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
  if (!task || projectId === 'google-calendar' || task.googleCalendarExternal || task.syncTarget === 'external-calendar') return;
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
  task.syncTarget = task.time ? 'calendar' : 'tasks';
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
  $('#connectGoogle').textContent = status?.requiresCalendarReauth ? '重新授权' : (connected ? '立即同步' : '连接');
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

function bindEvents() {
  document.addEventListener('pointerdown', () => window.luma?.activate(), { capture: true });
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

  document.addEventListener('pointerdown', (event) => {
    if (!calendarDetailDate) return;
    if (event.target.closest('#calendarDetail')) return;
    if (event.target.closest('.calendar-day')) return;
    if (event.target.closest('.month-controls')) return;
    if (event.target.closest('#dateSummary')) return;
    if (!event.target.closest('#calendarPanel')) return;
    closeCalendarDetail();
  }, { capture: true });
  $('#addCalendarSchedule').addEventListener('click', () => {
    if (calendarDetailDate) openCalendarTaskDialog(calendarDetailDate);
  });
  $('#addCalendarTodo').addEventListener('click', () => {
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
  $('#cancelCalendarTaskButton').addEventListener('click', () => $('#calendarTaskDialog').close());
  $('#calendarTaskForm').addEventListener('submit', createCalendarTask);
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
    await refreshGoogleStatus();
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
  await refreshGoogleStatus();
}

init();
