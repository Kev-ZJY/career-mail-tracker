import { ALLOWED_PROGRESS_STATUSES } from '../domain/statuses.js';
import { buildProgressNotes } from '../domain/progress-notes.js';

const fail = (message, code = 'INVALID_PROGRESS') => { throw Object.assign(new Error(message), { code }); };
const placeholders = ids => ids.map(() => '?').join(',');
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const uniqueIds = (value, label, allowEmpty = false) => {
  if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) fail(`${label}必须是有效记录编号`);
  const ids = [...new Set(value.map(Number))];
  if ((!allowEmpty && !ids.length) || ids.length > 200) fail(`${label}数量无效`);
  return ids;
};
const progressFields = ['company','position','status','eventStart','eventEnd','notes'];
const progressOf = entry => Object.fromEntries(progressFields.map(key => [key,entry[key] ?? (key === 'position' ? '' : null)]));
const chronological = entries => entries.sort((a,b) => b.recordedAt.localeCompare(a.recordedAt)
  || Number(b.kind === 'manual')-Number(a.kind === 'manual') || Number(b.id.split(':')[1])-Number(a.id.split(':')[1]));

export function migrateApplicationStructure(db) {
  const addColumn = (table,name,type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(col => col.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  addColumn('application_threads','manual_separate','INTEGER NOT NULL DEFAULT 0');
  addColumn('manual_progress_events','entry_kind',"TEXT NOT NULL DEFAULT 'manual'");
  addColumn('manual_progress_events','message_id','INTEGER REFERENCES mail_messages(id) ON DELETE CASCADE');
  db.exec(`CREATE TABLE IF NOT EXISTS manual_message_routes (
    message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
    thread_id INTEGER NOT NULL REFERENCES application_threads(id) ON DELETE CASCADE,
    PRIMARY KEY(message_id,thread_id)
  );
  CREATE TABLE IF NOT EXISTS application_structure_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, source_ids TEXT NOT NULL,
    target_thread_id INTEGER NOT NULL, detail_json TEXT NOT NULL, recorded_at TEXT NOT NULL
  );`);
  addColumn('manual_message_routes','progress_json','TEXT');
  // Old organization snapshots are audit evidence, not user-created recruitment progress.
  const affected = new Set();
  const events = db.prepare('SELECT * FROM application_structure_events ORDER BY id').all();
  const candidates = db.prepare(`SELECT id,thread_id FROM manual_progress_events
    WHERE entry_kind='manual' AND recorded_at=? AND company=? AND position=? AND status=?
      AND event_start IS ? AND event_end IS ? AND notes IS ?`);
  for (const event of events.filter(event=>['merge','split'].includes(event.kind))) {
    const detail = parse(event.detail_json);
    for (const row of detail?.after ? (Array.isArray(detail.after) ? detail.after : [detail.after]) : []) {
      for (const candidate of candidates.all(event.recorded_at,row.company,row.position || '',row.status,row.eventStart ?? null,row.eventEnd ?? null,row.notes ?? null)) {
        // Follow only documented movements of this snapshot, never a matching record in another application.
        const owners = new Set([row.id]);
        for (const later of events.filter(item=>item.id>event.id)) {
          const movement=parse(later.detail_json); const sources=parse(later.source_ids) || [];
          if (later.kind==='merge' && sources.some(id=>owners.has(id))) owners.add(later.target_thread_id);
          if (later.kind==='split' && movement?.manualEventIds?.includes(candidate.id) && sources.some(id=>owners.has(id))) owners.add(later.target_thread_id);
          if (later.kind==='restore' && movement?.reversedEventIds?.includes(event.id) && movement.archivedChildId) owners.add(movement.archivedChildId);
        }
        if (!owners.has(candidate.thread_id)) continue;
        db.prepare("UPDATE manual_progress_events SET entry_kind='organization' WHERE id=?").run(candidate.id);
        affected.add(candidate.thread_id);
      }
    }
  }
  const confirmed=db.prepare('UPDATE manual_message_routes SET progress_json=? WHERE message_id=? AND thread_id=?');
  for (const route of db.prepare(`SELECT route.message_id,route.thread_id,m.company,m.position,m.status,
    m.event_start AS eventStart,m.event_end AS eventEnd,m.notes FROM manual_message_routes route
    JOIN mail_messages m ON m.id=route.message_id WHERE route.progress_json IS NULL`).all()) {
    confirmed.run(JSON.stringify(progressOf(route)),route.message_id,route.thread_id);
  }
  return [...affected];
}

// Recruitment history is made of correspondence and genuine user records.
// Ownership operations only write application_structure_events.
export function createApplicationStructureMethods(db) {
  const activeThread = (repository,id) => {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) fail('申请编号无效');
    const row = repository.getThread(Number(id));
    if (!row || row.mergedIntoThreadId) fail('申请不存在或已归入其他申请','PROGRESS_NOT_FOUND');
    return row;
  };
  const verifyVersions = (rows,expected) => {
    if (expected == null) return;
    if (typeof expected !== 'object' || Array.isArray(expected) || rows.some(row => expected[row.id] !== row.updatedAt)) fail('申请已更新，请重新查看预览后再操作','PROGRESS_STALE');
  };
  const transaction = run => {
    db.exec('BEGIN IMMEDIATE');
    try { const result=run(); db.exec('COMMIT'); return result; }
    catch(error) {
      db.exec('ROLLBACK');
      if (error?.errcode===2067) fail('公司和岗位与其他申请冲突，请一并合并，或保留为独立申请','PROGRESS_CONFLICT');
      throw error;
    }
  };
  const manualRows = threadId => db.prepare(`SELECT id,thread_id AS threadId,company,position,status,
    event_start AS eventStart,event_end AS eventEnd,notes,recorded_at AS recordedAt,entry_kind AS entryKind,message_id AS messageId
    FROM manual_progress_events WHERE thread_id=? ORDER BY recorded_at DESC,id DESC`).all(threadId);
  const mailRows = threadId => db.prepare(`SELECT m.id,m.company,m.position,m.status,m.event_start AS eventStart,
    m.event_end AS eventEnd,m.notes,m.received_at AS receivedAt,m.subject,route.progress_json AS confirmedProgress
    FROM application_thread_messages link JOIN mail_messages m ON m.id=link.message_id
    LEFT JOIN manual_message_routes route ON route.message_id=m.id AND route.thread_id=link.thread_id
    WHERE link.thread_id=? ORDER BY m.received_at DESC,m.id DESC`).all(threadId);
  const makeHistory = (threadId,messages,edits) => chronological([
    ...messages.map(mail => {
      const confirmed = parse(mail.confirmedProgress) || mail;
      const correction = edits.find(edit => edit.entryKind==='correction' && edit.messageId===mail.id);
      const progress = correction ? progressOf(correction) : progressOf(confirmed);
      return {...progress,id:`email:${mail.id}`,kind:'email',threadId,recordedAt:mail.receivedAt,
        messageIds:[mail.id],messages:[{id:mail.id,subject:mail.subject,receivedAt:mail.receivedAt}]};
    }),
    ...edits.filter(edit => edit.entryKind==='manual').map(edit => ({...progressOf(edit),id:`manual:${edit.id}`,kind:'manual',
      threadId,recordedAt:edit.recordedAt,messageIds:[],messages:[]})),
  ]);
  const history = id => makeHistory(id,mailRows(id),manualRows(id));
  const summary = (entries,identity) => {
    if (!entries.length) fail('申请必须至少保留一条真实进展');
    const latest=chronological([...entries])[0];
    return {...progressOf(latest),...identity,history:entries,
      emailCount:new Set(entries.flatMap(entry=>entry.messageIds)).size,manualCount:entries.filter(entry=>entry.kind==='manual').length};
  };
  const validateProgress = (base,patch={}) => {
    const progress=progressOf(base);
    for (const key of progressFields) if (patch[key]!==undefined) progress[key]=patch[key];
    if (typeof progress.company!=='string' || !progress.company.trim()) fail('请填写公司名称');
    if (typeof progress.position!=='string') fail('岗位名称无效');
    progress.company=progress.company.trim(); progress.position=progress.position.trim();
    if (!ALLOWED_PROGRESS_STATUSES.has(progress.status)) fail('申请状态无效');
    if (progress.eventStart && !Number.isFinite(Date.parse(progress.eventStart))) fail('事件开始时间无效');
    if (progress.eventEnd && (!progress.eventStart || !Number.isFinite(Date.parse(progress.eventEnd)) || Date.parse(progress.eventEnd)<Date.parse(progress.eventStart))) fail('事件结束时间无效');
    progress.eventStart=progress.eventStart ? new Date(progress.eventStart).toISOString() : null;
    progress.eventEnd=progress.eventEnd ? new Date(progress.eventEnd).toISOString() : null;
    if (progress.notes!=null && typeof progress.notes!=='string') fail('备注无效');
    if ((patch.notes!==undefined && patch.notes!==base.notes) || (patch.status!==undefined && patch.status!==base.status)
      || (patch.eventEnd!==undefined && patch.eventEnd!==base.eventEnd)) progress.notes=buildProgressNotes({status:progress.status,notes:progress.notes,eventEnd:progress.eventEnd});
    return progress;
  };
  const membership = id => ({threadId:id,
    messageIds:mailRows(id).map(row=>row.id),manualEventIds:manualRows(id).filter(row=>row.entryKind!=='organization').map(row=>row.id)});
  const latestMerge = id => db.prepare("SELECT * FROM application_structure_events WHERE target_thread_id=? AND kind='merge' ORDER BY id DESC LIMIT 1").get(id);
  const pinOwners = messageIds => {
    for (const id of messageIds) {
      const previous=db.prepare('SELECT thread_id,progress_json FROM manual_message_routes WHERE message_id=? ORDER BY thread_id').all(id);
      const archive=db.prepare(`SELECT company,position,status,event_start AS eventStart,event_end AS eventEnd,notes FROM mail_messages WHERE id=?`).get(id);
      const owners=db.prepare(`SELECT link.thread_id AS id FROM application_thread_messages link JOIN application_threads t ON t.id=link.thread_id
        WHERE link.message_id=? AND t.merged_into_thread_id IS NULL`).all(id);
      db.prepare('DELETE FROM manual_message_routes WHERE message_id=?').run(id);
      for (const owner of owners) {
        const progress=previous.find(row=>row.thread_id===owner.id)?.progress_json || previous.find(row=>row.progress_json)?.progress_json || JSON.stringify(archive);
        db.prepare('INSERT INTO manual_message_routes(message_id,thread_id,progress_json) VALUES(?,?,?)').run(id,owner.id,progress);
      }
    }
  };
  const updateLatestProgress = (id,patch) => {
    const entries=history(id); const latest=entries[0];
    if (!latest || !['status','eventStart','eventEnd','notes'].some(key=>patch[key]!==undefined && patch[key]!==latest[key])) return;
    const next=validateProgress(latest,patch);
    if (latest.kind==='manual') db.prepare('UPDATE manual_progress_events SET status=?,event_start=?,event_end=?,notes=? WHERE id=?')
      .run(next.status,next.eventStart,next.eventEnd,next.notes,Number(latest.id.split(':')[1]));
    else db.prepare(`INSERT INTO manual_progress_events(thread_id,company,position,status,event_start,event_end,notes,recorded_at,entry_kind,message_id)
      VALUES(?,?,?,?,?,?,?,?,'correction',?)`).run(id,next.company,next.position,next.status,next.eventStart,next.eventEnd,next.notes,new Date().toISOString(),latest.messageIds[0]);
  };
  const writeSummary = (repository,id,identity={}) => {
    const row=repository.getThread(id); const entries=history(id);
    const next=summary(entries,{company:identity.company ?? row.company,position:identity.position ?? row.position});
    const messages=mailRows(id); const latestMail=messages[0];
    const manualTime=entries.filter(entry=>entry.kind==='manual').map(entry=>entry.recordedAt).sort().at(-1) || null;
    repository.updateThread(id,{...progressOf(next),confidence:1,needsReview:false,manualPositionOverride:row.manualPositionOverride || identity.position!==undefined,
      manualUpdatedAt:manualTime,source:messages.length ? 'email' : 'manual'});
    db.prepare('UPDATE application_threads SET latest_message_id=?,latest_received_at=? WHERE id=?')
      .run(latestMail?.id ?? null,latestMail?.receivedAt || entries[0].recordedAt,id);
    return repository.getThread(id);
  };
  const selection = (structure,input) => {
    let ids;
    if (input.historyIds!==undefined) {
      if (!Array.isArray(input.historyIds) || input.historyIds.length>200 || input.historyIds.some(id=>typeof id!=='string')) fail('请选择有效进展');
      ids=[...new Set(input.historyIds)];
    } else ids=[...uniqueIds(input.messageIds || [],'选中邮件',true).map(id=>`email:${id}`),
      ...uniqueIds(input.manualEventIds || [],'选中手动记录',true).map(id=>`manual:${id}`)];
    if (!ids.length) fail('请选择要拆出的进展');
    const known=new Set(structure.history.map(row=>row.id));
    if (ids.some(id=>!known.has(id))) fail('选中进展不属于当前申请');
    if (ids.length>=known.size) fail('原申请至少保留一条真实进展；全部移动请使用合并申请');
    const picked=new Set(ids);
    return {selected:structure.history.filter(row=>picked.has(row.id)),remaining:structure.history.filter(row=>!picked.has(row.id))};
  };
  const restorePlan = (repository,input) => {
    const target=activeThread(repository,input.threadId);
    verifyVersions([target],input.expectedUpdatedAt==null ? null : {[target.id]:input.expectedUpdatedAt});
    const event=latestMerge(target.id); const detail=parse(event?.detail_json);
    if (!event || !Array.isArray(detail?.members)) fail('这次合并没有完整的原申请分组，无法自动恢复','PROGRESS_CONFLICT');
    if (input.mergeEventId!=null && Number(input.mergeEventId)!==event.id) fail('合并记录已变化，请重新预览','PROGRESS_STALE');
    const current=membership(target.id); const messages=new Set(current.messageIds); const edits=new Set(current.manualEventIds);
    const before=detail.before;
    if (detail.members.some(member=>member.messageIds.some(id=>!messages.has(id)) || member.manualEventIds.some(id=>!edits.has(id)))) fail('合并后部分进展已移出，不能完整恢复；请按现有历史拆分','PROGRESS_CONFLICT');
    for (const member of detail.members) {
      const row=repository.getThread(member.threadId);
      if (!row || (row.id!==target.id && row.mergedIntoThreadId!==target.id)) fail('原申请已变化，不能完整恢复','PROGRESS_CONFLICT');
    }
    const originalMessages=new Set(detail.members.flatMap(member=>member.messageIds));
    const originalEdits=new Set(detail.members.flatMap(member=>member.manualEventIds));
    const currentMails=mailRows(target.id); const currentManual=manualRows(target.id);
    const groups=detail.members.map(member=>{
      const original=before.find(row=>row.id===member.threadId);
      const mids=new Set(member.messageIds); const eids=new Set(member.manualEventIds);
      if (member.threadId===target.id) {
        for (const id of messages) if (!originalMessages.has(id)) mids.add(id);
        for (const edit of currentManual) if (!originalEdits.has(edit.id) && edit.entryKind!=='correction') eids.add(edit.id);
      }
      for (const edit of currentManual) if (edit.entryKind==='correction' && mids.has(edit.messageId)) eids.add(edit.id);
      const entries=makeHistory(target.id,currentMails.filter(row=>mids.has(row.id)),currentManual.filter(row=>eids.has(row.id)));
      return {id:member.threadId,...summary(entries,{company:original.company,position:original.position}),
        messageIds:[...mids],manualEventIds:[...eids]};
    });
    return {target,event,detail,groups,mergeEventId:event.id,expectedUpdatedAt:target.updatedAt};
  };
  return {
    confirmThreadMessageRoutes(threadId) { pinOwners(mailRows(threadId).map(row=>row.id)); },
    refreshThreadFromHistory(threadId) { return writeSummary(this,threadId); },
    listManualThreadRoutesForMessage(messageId) {
      return db.prepare(`SELECT t.id FROM manual_message_routes route JOIN application_threads t ON t.id=route.thread_id
        WHERE route.message_id=? AND t.merged_into_thread_id IS NULL ORDER BY t.id`).all(Number(messageId)).map(row=>this.getThread(row.id));
    },
    getOriginalApplications(threadId) {
      return db.prepare(`SELECT company,position FROM application_threads WHERE merged_into_thread_id=?
        UNION SELECT company,position FROM manual_progress_events WHERE thread_id=? AND entry_kind!='organization'
        UNION SELECT company,position FROM mail_messages WHERE id IN (SELECT message_id FROM application_thread_messages WHERE thread_id=?)`)
        .all(threadId,threadId,threadId);
    },
    getThreadStructure(threadId) {
      const thread=activeThread(this,threadId); const entries=history(thread.id);
      const event=latestMerge(thread.id); const detail=parse(event?.detail_json);
      const groups=(detail?.members || []).map(member=>{
        const original=detail.before.find(row=>row.id===member.threadId);
        return {id:member.threadId,company:original.company,position:original.position,
          historyIds:entries.filter(entry=>entry.kind==='email' ? member.messageIds.includes(entry.messageIds[0])
            : member.manualEventIds.includes(Number(entry.id.split(':')[1]))).map(entry=>entry.id)};
      });
      let restore={eventId:event?.id ?? null,available:false,reason:'没有可恢复的完整合并记录'};
      if (event) { try { restorePlan(this,{threadId:thread.id});restore={eventId:event.id,available:true,reason:''}; }
        catch(error) {restore.reason=error.message;} }
      return {thread,history:entries,groups,restore,
        messages:mailRows(thread.id).map(({id,subject,receivedAt})=>({id,subject,receivedAt})),manualEvents:this.listManualProgress(thread.id)};
    },
    previewThreadMerge({targetId,sourceIds,progress}) {
      const target=activeThread(this,targetId); const ids=uniqueIds(sourceIds,'待合并申请');
      if (ids.includes(target.id)) fail('保留申请不能同时作为待合并申请');
      const sources=ids.map(id=>activeThread(this,id)); const rows=[target,...sources];
      if (new Set(rows.map(row=>row.accountId).filter(account=>account!=='manual')).size>1) fail('不能跨邮箱合并申请','FORBIDDEN');
      const combined=chronological([...new Map(rows.flatMap(row=>history(row.id)).map(entry=>[entry.id,entry])).values()]);
      const named=[...new Set(rows.map(row=>row.position).filter(Boolean))];
      const base=summary(combined,{company:target.company,position:target.position || (named.length===1 ? named[0] : '')});
      const proposed=validateProgress(base,progress);
      return {target,sources,proposed,history:combined,emailCount:base.emailCount,manualCount:base.manualCount,
        expectedUpdatedAt:Object.fromEntries(rows.map(row=>[row.id,row.updatedAt]))};
    },
    mergeThreads({targetId,sourceIds,progress,expectedUpdatedAt}) {
      return transaction(()=>{
        const preview=this.previewThreadMerge({targetId,sourceIds,progress}); const rows=[preview.target,...preview.sources];
        verifyVersions(rows,expectedUpdatedAt); const target=preview.target; const ids=preview.sources.map(row=>row.id);
        const members=rows.map(row=>membership(row.id)); const affected=[...new Set(members.flatMap(member=>member.messageIds))];
        const priorMerged=db.prepare(`SELECT id,merged_into_thread_id AS parent FROM application_threads WHERE merged_into_thread_id IN (${placeholders(ids)})`).all(...ids);
        db.prepare(`UPDATE application_threads SET merged_into_thread_id=? WHERE id IN (${placeholders(ids)}) OR merged_into_thread_id IN (${placeholders(ids)})`).run(target.id,...ids,...ids);
        db.prepare(`INSERT OR IGNORE INTO application_thread_messages(thread_id,message_id,linked_at)
          SELECT ?,message_id,linked_at FROM application_thread_messages WHERE thread_id IN (${placeholders(ids)})`).run(target.id,...ids);
        db.prepare(`DELETE FROM application_thread_messages WHERE thread_id IN (${placeholders(ids)})`).run(...ids);
        db.prepare(`UPDATE manual_progress_events SET thread_id=? WHERE thread_id IN (${placeholders(ids)})`).run(target.id,...ids);
        const account=rows.find(row=>row.accountId!=='manual')?.accountId;
        if (account) db.prepare('UPDATE application_threads SET account_id=? WHERE id=?').run(account,target.id);
        pinOwners(affected);
        updateLatestProgress(target.id,preview.proposed);
        const saved=writeSummary(this,target.id,preview.proposed);
        db.prepare('INSERT INTO application_structure_events(kind,source_ids,target_thread_id,detail_json,recorded_at) VALUES(?,?,?,?,?)')
          .run('merge',JSON.stringify(ids),target.id,JSON.stringify({before:rows,after:saved,members,priorMerged,messageIds:affected}),new Date().toISOString());
        return saved;
      });
    },
    previewThreadSplit(input) {
      const source=activeThread(this,input.threadId);
      verifyVersions([source],input.expectedUpdatedAt==null ? null : {[source.id]:input.expectedUpdatedAt});
      const structure=this.getThreadStructure(source.id); const {selected,remaining}=selection(structure,input);
      const inferred=[...new Set(selected.map(row=>row.position).filter(Boolean))];
      const derived=summary(selected,{company:input.company ?? source.company,
        position:input.position ?? (inferred.length===1 ? inferred[0] : '')});
      const proposed=validateProgress(derived,input);
      if (['status','eventStart','eventEnd','notes'].some(key=>(proposed[key] || null)!==(derived[key] || null))) {
        fail('拆分只调整进展归属；请在拆分后编辑需要修正的进展');
      }
      const original=summary(remaining,{company:source.company,position:source.position});
      const newApplication={...summary(selected,proposed),...proposed};
      return {original,newApplication,expectedUpdatedAt:source.updatedAt};
    },
    splitThread(input) {
      return transaction(()=>{
        const source=activeThread(this,input.threadId); const preview=this.previewThreadSplit(input);
        const next=preview.newApplication;
        const selectedMessages=[...new Set(next.history.flatMap(entry=>entry.messageIds))];
        const selectedEvents=next.history.filter(entry=>entry.kind==='manual').map(entry=>Number(entry.id.split(':')[1]));
        const allMessages=mailRows(source.id).map(row=>row.id); const now=new Date().toISOString();
        const result=db.prepare(`INSERT INTO application_threads(account_id,company,position,status,confidence,needs_review,
          event_start,event_end,notes,latest_received_at,source,manual_position_override,updated_at,manual_separate)
          VALUES(?,?,?,?,1,0,?,?,?,?,?,1,?,1)`).run(source.accountId,next.company,next.position,next.status,next.eventStart,next.eventEnd,next.notes,next.history[0].recordedAt,selectedMessages.length?'email':'manual',now);
        const newId=Number(result.lastInsertRowid);
        for (const id of selectedMessages) {
          db.prepare('INSERT INTO application_thread_messages(thread_id,message_id,linked_at) VALUES(?,?,?)').run(newId,id,now);
          db.prepare('DELETE FROM application_thread_messages WHERE thread_id=? AND message_id=?').run(source.id,id);
          db.prepare("UPDATE manual_progress_events SET thread_id=? WHERE thread_id=? AND entry_kind='correction' AND message_id=?").run(newId,source.id,id);
        }
        if (selectedEvents.length) db.prepare(`UPDATE manual_progress_events SET thread_id=? WHERE thread_id=? AND id IN (${placeholders(selectedEvents)})`).run(newId,source.id,...selectedEvents);
        pinOwners(allMessages);
        const saved=writeSummary(this,newId,next); const kept=writeSummary(this,source.id);
        db.prepare('INSERT INTO application_structure_events(kind,source_ids,target_thread_id,detail_json,recorded_at) VALUES(?,?,?,?,?)')
          .run('split',JSON.stringify([source.id]),newId,JSON.stringify({before:source,after:[kept,saved],messageIds:selectedMessages,manualEventIds:selectedEvents}),now);
        return saved;
      });
    },
    previewRestoreMerge(input) {
      const plan=restorePlan(this,input);
      return {groups:plan.groups,mergeEventId:plan.mergeEventId,expectedUpdatedAt:plan.expectedUpdatedAt};
    },
    restoreMerge(input) {
      return transaction(()=>{
        const plan=restorePlan(this,input); const target=plan.target;
        const allMessages=membership(target.id).messageIds;
        for (const group of plan.groups) {
          const original=plan.detail.before.find(row=>row.id===group.id);
          db.prepare('UPDATE application_threads SET merged_into_thread_id=NULL,manual_separate=? WHERE id=?').run(original.manualSeparate?1:0,group.id);
          this.updateThread(group.id,{company:original.company,position:original.position});
        }
        db.prepare('DELETE FROM application_thread_messages WHERE thread_id=?').run(target.id);
        for (const group of plan.groups) {
          for (const id of group.messageIds) db.prepare('INSERT OR IGNORE INTO application_thread_messages(thread_id,message_id,linked_at) VALUES(?,?,?)').run(group.id,id,new Date().toISOString());
          if (group.manualEventIds.length) db.prepare(`UPDATE manual_progress_events SET thread_id=? WHERE id IN (${placeholders(group.manualEventIds)})`).run(group.id,...group.manualEventIds);
        }
        for (const row of plan.detail.priorMerged || []) db.prepare('UPDATE application_threads SET merged_into_thread_id=? WHERE id=?').run(row.parent,row.id);
        pinOwners(allMessages);
        const restored=plan.groups.map(group=>writeSummary(this,group.id,group));
        db.prepare('INSERT INTO application_structure_events(kind,source_ids,target_thread_id,detail_json,recorded_at) VALUES(?,?,?,?,?)')
          .run('restore',JSON.stringify(restored.map(row=>row.id)),target.id,JSON.stringify({mergeEventId:plan.event.id,before:target,after:restored}),new Date().toISOString());
        return {restored};
      });
    },
  };
}
