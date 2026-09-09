const test=require('node:test');
const assert=require('node:assert/strict');
const {syncExtensionEvents,isExtensionEvent}=require('../main/extension-calendar.cjs');
const event=(uid='test-1',dateKey='2026-09-17')=>({uid,dateKey,title:'Marker',ics:['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:'+uid,'SUMMARY:Marker','DTSTART;VALUE=DATE:'+dateKey.replaceAll('-',''),'X-LUMA-EXAMPLE:TRUE','END:VEVENT','END:VCALENDAR',''].join('\r\n')});
const range={startDate:'2026-09-01',endDate:'2026-09-30'};
function options(existing,events) {
 const writes=[],deletes=[];
 return {range,payload:{events},identify:e=>e.owned?{uid:e.uid,dateKey:e.dueDate}:null,list:async()=>existing,put:async(e,c)=>writes.push([e,c]),remove:async e=>deletes.push(e),writes,deletes};
}
test('extension boolean markers remain excluded without an installed plugin',()=>{
 assert.equal(isExtensionEvent({extensionProperties:{'X-LUMA-EXAMPLE':'TRUE'}}),true);
 assert.equal(isExtensionEvent({extensionProperties:{}}),false);
});
test('stable identity preserves existing markers and ignores ordinary and out-of-range events',async()=>{
 const old={uid:'test-1',dueDate:'2026-09-17',title:'Marker',owned:true};
 const args=options([old,{uid:'ordinary',dueDate:'2026-09-17'},{uid:'old',owned:true,dueDate:'2025-01-01'}],[event()]);
 assert.deepEqual(await syncExtensionEvents(args),{created:0,updated:0,deleted:0,unchanged:1});
 assert.equal(args.writes.length,0);assert.equal(args.deletes.length,0);
});
test('reconciliation updates, creates and removes only owned markers',async()=>{
 const args=options([{uid:'test-1',dueDate:'2026-09-17',title:'Old',owned:true},{uid:'stale',dueDate:'2026-09-18',owned:true}],[event(),event('test-2','2026-09-18')]);
 assert.deepEqual(await syncExtensionEvents(args),{created:1,updated:1,deleted:1,unchanged:0});
 assert.equal(args.deletes[0].uid,'stale');
});
test('invalid or duplicate payload cannot cause remote changes',async()=>{
 for(const payload of [{}, {events:[event(),event()]},{events:[{...event(),ics:'invalid'}]}]) {
   const args=options([{uid:'old',owned:true,dueDate:'2026-09-17'}],[]);args.payload=payload;
   await assert.rejects(syncExtensionEvents(args));assert.equal(args.writes.length,0);assert.equal(args.deletes.length,0);
 }
});
