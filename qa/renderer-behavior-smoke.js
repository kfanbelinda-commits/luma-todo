(async () => {
  console.log('QA: Todo checks');
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

  // Apple conflict resolution is opened from Settings and must return to the
  // same Settings panel instead of triggering the generic outside-click close.
  const settingsDialog = document.querySelector('#settingsDialog');
  const conflictDialog = document.querySelector('#icloudConflictDialog');
  assertQa(settingsDialog && conflictDialog, 'Settings or iCloud conflict dialog is missing');
  if (!settingsDialog.open) settingsDialog.show();
  if (!conflictDialog.open) conflictDialog.showModal();
  const conflictButton = document.querySelector('#icloudKeepLocal');
  conflictButton.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  assertQa(settingsDialog.open, 'Interacting with Apple conflict dialog closed Settings');
  conflictDialog.close();

  const googleConflictDialog = document.querySelector('#googleConflictDialog');
  assertQa(googleConflictDialog, 'Google conflict dialog is missing');
  googleConflictDialog.showModal();
  document.querySelector('#googleKeepLocal').dispatchEvent(new Event('pointerdown', { bubbles: true }));
  assertQa(settingsDialog.open, 'Interacting with Google conflict dialog closed Settings');
  googleConflictDialog.close();
  settingsDialog.close();

  assertQa(document.querySelector('#privateExtensionDialog'), 'Extension host is missing');
  assertQa(document.querySelector('#privateExtensionActions').childElementCount === 0, 'Uninstalled extensions have visible actions');
  assertQa(document.querySelector('#privateExtensionPanel').shadowRoot.childElementCount === 0, 'Uninstalled extensions have visible UI');

  const cursorBeforeDrag = new Date(calendarCursor);
  console.log('QA: calendar event drag checks');
  const eventId = '__QA_EVENT_MOVE__';
  const spanId = '__QA_SPAN_MOVE__';
  const eventTask = {id:eventId,itemType:'event',title:'日程拖拽测试',dueDate:'2027-03-10',endDate:'2027-03-10',time:'10:00',endTime:'11:00',projectId:task.projectId,source:'icloud',icloudUid:'qa-uid',icloudHref:'/qa-event.ics'};
  const spanTask = {...eventTask,id:spanId,title:'跨日拖拽测试',dueDate:'2027-03-14',endDate:'2027-03-17',time:'',endTime:''};
  state.tasks.push(eventTask,spanTask);
  calendarCursor=fromDateKey('2027-03-01');renderCalendar();
  const dragTo = async (selector,targetDate) => {
    const source=document.querySelector(selector);
    assertQa(source?.draggable,'Event body is not draggable');
    const dataTransfer=new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer}));
    const target=document.querySelector('.calendar-day[data-date="'+targetDate+'"]');
    const over=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer});target.dispatchEvent(over);
    assertQa(over.defaultPrevented,'Calendar rejected the event drop');
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));
    source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer}));
    await new Promise(resolve=>setTimeout(resolve,100));
  };
  await dragTo('.calendar-event-item[data-task-id="'+eventId+'"]','2027-03-24');
  console.log('QA: single event moved');
  assertQa(eventTask.dueDate==='2027-03-24' && eventTask.endDate==='2027-03-24','Single event date did not move');
  assertQa(eventTask.time==='10:00' && eventTask.endTime==='11:00' && eventTask.icloudUid==='qa-uid','Moving changed time or sync identity');
  await dragTo('.calendar-day[data-date="2027-03-16"] .calendar-span-event[data-task-id="'+spanId+'"]','2027-03-22');
  console.log('QA: multi-day event moved');
  assertQa(spanTask.dueDate==='2027-03-20' && spanTask.endDate==='2027-03-23','Middle-segment move lost the date span');
  assertQa(document.querySelector('.calendar-day[data-date="2027-03-20"] .event-resize-start'),'Moving removed the start resize control');
  assertQa(document.querySelector('.calendar-day[data-date="2027-03-23"] .event-resize-end'),'Moving removed the end resize control');
  state.tasks=state.tasks.filter(item=>item.id!==eventId && item.id!==spanId);
  calendarCursor=cursorBeforeDrag;

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
      'opacity survives calendar expand',
      'iCloud conflict keeps settings open',
      'Google conflict keeps settings open',
      'Empty private extension host',
      'month event body drag',
      'multi-day middle-segment drag',
      'event times and Apple identity preserved',
      'event edge resize controls preserved'
    ]
  };
})()
