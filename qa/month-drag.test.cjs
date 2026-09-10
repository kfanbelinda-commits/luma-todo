const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
const move=source.slice(source.indexOf('async function moveTaskToDate('),source.indexOf('function syncCalendarEventEndTimeState('));
function setup(overrides={}) {
  const task={id:'event',itemType:'event',dueDate:'2026-09-29',endDate:'2026-10-01',time:'22:30',endTime:'08:00',source:'icloud',icloudUid:'existing-uid',icloudHref:'/existing.ics',...overrides};
  let saves=0;
  const context=vm.createContext({state:{tasks:[task]},isCalendarEvent:t=>t.itemType==='event',fromDateKey:k=>new Date(k+'T12:00:00'),toDateKey:d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'),persist:async()=>{saves++;},render(){}});
  vm.runInContext(move,context);
  return {task,move:(date,anchor)=>context.moveTaskToDate(task.id,date,anchor),saves:()=>saves};
}
test('moving a timed event across months retains its duration, times and Apple identity',async()=>{
  const h=setup();await h.move('2026-10-04');
  assert.equal(h.task.dueDate,'2026-10-04');assert.equal(h.task.endDate,'2026-10-06');
  assert.equal(h.task.time,'22:30');assert.equal(h.task.endTime,'08:00');
  assert.equal(h.task.icloudUid,'existing-uid');assert.equal(h.task.icloudHref,'/existing.ics');assert.equal(h.task.itemType,'event');
  assert.equal(h.saves(),1);
});
test('dragging a middle segment uses the grabbed day as its anchor',async()=>{
  const h=setup({time:'',endTime:''});await h.move('2026-09-29','2026-09-30');
  assert.equal(h.task.dueDate,'2026-09-28');assert.equal(h.task.endDate,'2026-09-30');assert.equal(h.task.time,'');
});
test('same-cell, completed and external event drops do not save',async()=>{
  for(const fields of [{},{completed:true},{googleCalendarExternal:true},{syncTarget:'external-calendar'}]) {
    const h=setup(fields);await h.move(Object.keys(fields).length?'2026-10-04':'2026-09-30','2026-09-30');assert.equal(h.saves(),0);
  }
});
test('a timed Todo remains a Todo when moved',async()=>{
  const h=setup({itemType:'todo',endDate:''});await h.move('2026-10-04');
  assert.equal(h.task.itemType,'todo');assert.equal(h.task.dueDate,'2026-10-04');assert.equal(h.task.endDate,'');assert.equal(h.task.time,'22:30');
});
