(async () => {
  const assertQa = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const title = '__LUMA_QA_TODO__' + Date.now();
  const input = document.querySelector('#quickInput');
  assertQa(input, 'Quick input is missing');

  input.value = title;
  await addTask();

  const task = state.tasks.find((item) => item.title === title);
  assertQa(task, 'Quick-add Todo was not created');
  const originalDate = task.dueDate;
  assertQa(task.itemType === 'todo', 'Quick-add item must be a Todo');
  assertQa(!task.completed, 'New Todo must start incomplete');

  // A Todo with a time must remain a Todo.
  task.time = '09:30';
  task.updatedAt = Date.now();
  await persist();
  calendarCursor = fromDateKey(originalDate);
  calendarCursor.setDate(1);
  renderCalendar();
  assertQa(!isCalendarEvent(task), 'Timed Todo was incorrectly converted to Event');

  let calendarItem = document.querySelector(
    '.calendar-todo-item[data-task-id="' + task.id + '"]'
  );
  assertQa(calendarItem, 'Timed Todo is missing from its calendar date');

  // First completion click enters the reversible grace period.
  await toggleTask(task.id, { preserveCalendar: true });
  assertQa(!task.completed, 'Todo persisted complete before grace period ended');
  assertQa(isTaskPendingCompletion(task.id), 'Completion grace period did not start');
  calendarItem = document.querySelector(
    '.calendar-todo-item[data-task-id="' + task.id + '"]'
  );
  assertQa(calendarItem, 'Todo disappeared from calendar during completion grace period');
  assertQa(
    calendarItem.classList.contains('pending-completion'),
    'Calendar Todo does not show pending completion state'
  );

  // Second click during grace period must undo.
  await toggleTask(task.id, { preserveCalendar: true });
  assertQa(!isTaskPendingCompletion(task.id), 'Second click did not cancel completion');
  assertQa(!task.completed, 'Undo during grace period still completed the Todo');

  // Let completion finalize, then verify date and calendar presence are preserved.
  await toggleTask(task.id, { preserveCalendar: true });
  await new Promise((resolve) => setTimeout(resolve, COMPLETION_GRACE_MS + 250));
  assertQa(task.completed, 'Todo did not finalize after completion grace period');
  assertQa(task.dueDate === originalDate, 'Completing Todo changed its due date');
  renderCalendar();
  calendarItem = document.querySelector(
    '.calendar-todo-item[data-task-id="' + task.id + '"]'
  );
  assertQa(calendarItem, 'Completed Todo disappeared from calendar');
  assertQa(
    calendarItem.classList.contains('completed-calendar-event'),
    'Completed calendar Todo is missing completed visual state'
  );

  // Stored completed Todo must restore from the same checkbox behavior.
  await toggleTask(task.id, { preserveCalendar: true });
  assertQa(!task.completed, 'Completed Todo did not restore');
  assertQa(!task.completedDate, 'Restored Todo retained completedDate');
  assertQa(task.dueDate === originalDate, 'Restoring Todo changed its due date');
  renderCalendar();
  calendarItem = document.querySelector(
    '.calendar-todo-item[data-task-id="' + task.id + '"]'
  );
  assertQa(calendarItem, 'Restored Todo disappeared from calendar');
  assertQa(task.itemType === 'todo' && !isCalendarEvent(task), 'Restored Todo changed type');

  // Exercise the real expand/collapse path, including main-process resize IPC.
  // Window background transparency must survive the native resize unchanged.
  const previousLightMode = Boolean(state.settings.lightMode);
  const previousPanelOpacity = Number(state.settings.panelOpacity);
  applyColorMode(true);
  applyPanelOpacity(20);

  const todoPanel = document.querySelector('.todo-panel');
  const calendarPanel = document.querySelector('.calendar-panel');
  const compactTodoBackground = getComputedStyle(todoPanel).backgroundColor;
  assertQa(
    getComputedStyle(document.documentElement).getPropertyValue('--panel-opacity').trim() === '0.2',
    'Low-opacity QA setup did not apply'
  );

  await toggleExpanded(true);
  assertQa(expanded, 'Calendar did not enter expanded state');
  assertQa(document.querySelector('#app').classList.contains('expanded'), 'Expanded class missing');
  assertQa(
    getComputedStyle(document.documentElement).getPropertyValue('--panel-opacity').trim() === '0.2',
    'Expanding Calendar changed panel opacity'
  );
  assertQa(
    getComputedStyle(todoPanel).backgroundColor === compactTodoBackground,
    'Expanding Calendar changed Todo panel background'
  );
  assertQa(
    getComputedStyle(calendarPanel).backgroundColor === compactTodoBackground,
    'Expanded Calendar does not use the same translucent panel background as Todo'
  );

  await toggleExpanded(false);
  assertQa(!expanded, 'Calendar did not return to compact state');
  assertQa(!document.querySelector('#app').classList.contains('expanded'), 'Expanded class remained');

  applyPanelOpacity(previousPanelOpacity);
  applyColorMode(previousLightMode);

  // Cleanup is demo-only and keeps repeated CI runs deterministic.
  state.tasks = state.tasks.filter((item) => item.id !== task.id);
  await persist();
  render();

  return {
    ok: true,
    tested: [
      'quick-add todo',
      'timed todo remains todo',
      'completion grace undo',
      'completed todo stays on calendar',
      'restore completed todo',
      'expand collapse',
      'opacity survives calendar expand'
    ]
  };
})()
