module.exports = function runSyncProtocolSmokeTests({
  taskToIcloudIcs,
  parseIcloudEvent,
  calendarBody,
  applyCalendarEvent,
}) {
  const qaAssert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const fixedUpdatedAt = Date.parse('2026-09-05T00:00:00Z');
  const calendar = { name: 'QA Calendar', url: 'https://qa.invalid/calendar/' };

  const timedTodo = {
    id: 'qa-timed-todo',
    title: 'QA, Todo; path\\line',
    projectId: 'inbox',
    dueDate: '2026-09-05',
    time: '09:30',
    itemType: 'todo',
    completed: false,
    updatedAt: fixedUpdatedAt,
    createdAt: fixedUpdatedAt,
    order: 1,
  };
  const todoIcs = taskToIcloudIcs(timedTodo, 'qa-timed-todo@luma');
  qaAssert(todoIcs.includes('X-LUMA-ITEM-TYPE:todo'), 'iCloud timed Todo lost todo metadata');
  qaAssert(todoIcs.includes('X-LUMA-COMPLETED:false'), 'iCloud timed Todo completion metadata is wrong');
  qaAssert(todoIcs.includes('SUMMARY:□ QA\\, Todo\\; path\\\\line'), 'iCloud Todo summary escaping/prefix is wrong');
  const parsedTodo = parseIcloudEvent(todoIcs, '/qa/todo.ics', '"todo-etag"', calendar);
  qaAssert(parsedTodo?.lumaItemType === 'todo', 'Parsed iCloud Todo changed item type');
  qaAssert(parsedTodo?.lumaTaskId === timedTodo.id, 'Parsed iCloud Todo lost Luma task id');
  qaAssert(parsedTodo?.dueDate === timedTodo.dueDate, 'Parsed iCloud Todo changed date');
  qaAssert(parsedTodo?.time === timedTodo.time, 'Parsed iCloud Todo changed time');
  qaAssert(parsedTodo?.endDate === timedTodo.dueDate, 'Parsed iCloud Todo changed mirror end date');
  qaAssert(parsedTodo?.endTime === '10:00', 'Timed Todo mirror must remain 30 minutes');

  const completedTodo = { ...timedTodo, id: 'qa-completed-todo', completed: true };
  const completedIcs = taskToIcloudIcs(completedTodo, 'qa-completed-todo@luma');
  qaAssert(completedIcs.includes('SUMMARY:✓ '), 'Completed iCloud Todo is missing completed summary prefix');
  qaAssert(completedIcs.includes('X-LUMA-COMPLETED:true'), 'Completed iCloud Todo metadata is wrong');

  const allDayEvent = {
    id: 'qa-all-day-event',
    title: 'QA all-day event',
    projectId: 'inbox',
    dueDate: '2026-09-05',
    endDate: '2026-09-07',
    time: '',
    endTime: '',
    itemType: 'event',
    eventColor: '#91a9c7',
    completed: false,
    updatedAt: fixedUpdatedAt,
    createdAt: fixedUpdatedAt,
    order: 2,
  };
  const allDayIcs = taskToIcloudIcs(allDayEvent, 'qa-all-day-event@luma');
  qaAssert(allDayIcs.includes('X-LUMA-ITEM-TYPE:event'), 'iCloud Event lost event metadata');
  qaAssert(allDayIcs.includes('DTSTART;VALUE=DATE:20260905'), 'All-day Event start date is wrong');
  qaAssert(allDayIcs.includes('DTEND;VALUE=DATE:20260908'), 'All-day Event must use exclusive end date');
  const parsedAllDay = parseIcloudEvent(allDayIcs, '/qa/all-day.ics', '"event-etag"', calendar);
  qaAssert(parsedAllDay?.dueDate === '2026-09-05', 'Parsed all-day Event start changed');
  qaAssert(parsedAllDay?.endDate === '2026-09-07', 'Parsed all-day Event inclusive end changed');
  qaAssert(parsedAllDay?.time === '' && parsedAllDay?.endTime === '', 'All-day Event gained a time');
  qaAssert(parsedAllDay?.eventColor === '#91a9c7', 'Parsed iCloud Event lost color');

  const overnightEvent = {
    ...allDayEvent,
    id: 'qa-overnight-event',
    title: 'QA overnight event',
    dueDate: '2026-09-05',
    endDate: '2026-09-06',
    time: '23:30',
    endTime: '01:00',
    eventColor: '#8b6ef5',
  };
  const overnightIcs = taskToIcloudIcs(overnightEvent, 'qa-overnight-event@luma');
  const parsedOvernight = parseIcloudEvent(overnightIcs, '/qa/overnight.ics', '"overnight-etag"', calendar);
  qaAssert(parsedOvernight?.dueDate === overnightEvent.dueDate, 'Overnight Event start date changed');
  qaAssert(parsedOvernight?.time === overnightEvent.time, 'Overnight Event start time changed');
  qaAssert(parsedOvernight?.endDate === overnightEvent.endDate, 'Overnight Event end date changed');
  qaAssert(parsedOvernight?.endTime === overnightEvent.endTime, 'Overnight Event end time changed');

  const nativeIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:native-apple-event',
    'SUMMARY:Native Apple Event',
    'DTSTART;VALUE=DATE:20260910',
    'DTEND;VALUE=DATE:20260912',
    'END:VEVENT',
    'END:VCALENDAR',
    ''
  ].join('\r\n');
  const parsedNative = parseIcloudEvent(nativeIcs, '/qa/native.ics', '"native-etag"', calendar);
  qaAssert(parsedNative?.uid === 'native-apple-event', 'Native Apple Event UID parse failed');
  qaAssert(parsedNative?.lumaTaskId === '', 'Native Apple Event was incorrectly linked to a Luma task');
  qaAssert(parsedNative?.lumaItemType === '', 'Native Apple Event was incorrectly assigned a Luma item type');
  qaAssert(parsedNative?.dueDate === '2026-09-10' && parsedNative?.endDate === '2026-09-11', 'Native Apple all-day range parse failed');

  const qaState = {
    projects: [{ id: 'inbox', name: '未分类', color: '#7289f5', order: 0 }],
    tasks: []
  };
  const googleTodoBody = calendarBody(qaState, timedTodo);
  qaAssert(googleTodoBody.extendedProperties?.private?.lumaItemType === 'todo', 'Google timed Todo lost todo metadata');
  qaAssert(
    new Date(googleTodoBody.end.dateTime).getTime() - new Date(googleTodoBody.start.dateTime).getTime() === 30 * 60000,
    'Google timed Todo mirror must remain 30 minutes'
  );

  const googleEventBody = calendarBody(qaState, allDayEvent);
  qaAssert(googleEventBody.extendedProperties?.private?.lumaItemType === 'event', 'Google Event lost event metadata');
  qaAssert(googleEventBody.start?.date === '2026-09-05', 'Google all-day Event start date is wrong');
  qaAssert(googleEventBody.end?.date === '2026-09-08', 'Google all-day Event exclusive end date is wrong');

  const appliedEvent = {
    id: 'qa-google-roundtrip',
    title: '',
    projectId: 'inbox',
    itemType: 'todo',
    dueDate: '',
    time: '',
    endDate: '',
    endTime: '',
    eventColor: '',
    completed: false,
  };
  applyCalendarEvent(appliedEvent, {
    ...googleEventBody,
    extendedProperties: googleEventBody.extendedProperties
  });
  qaAssert(appliedEvent.itemType === 'event', 'Google Event round-trip changed item type');
  qaAssert(appliedEvent.dueDate === allDayEvent.dueDate && appliedEvent.endDate === allDayEvent.endDate, 'Google Event round-trip changed date range');

  return [
    'iCloud timed Todo round-trip',
    'iCloud completed Todo metadata',
    'iCloud all-day Event round-trip',
    'iCloud overnight Event round-trip',
    'native Apple Event parse',
    'Google timed Todo mirror',
    'Google Event round-trip'
  ];

};
