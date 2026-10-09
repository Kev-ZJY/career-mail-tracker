import { mergeSubmission, splitSelection, splitSubmission, groupSelection, splitPreviewSubmission, restoreSubmission } from './application-organization.js';

export function renderProgressHistory(container, history = [], { selectable = false, thread = null, openEmail = () => {}, formatDateTime = (value) => value || '未设置' } = {}) {
  container.replaceChildren();
  if (!history.length) { container.textContent = '暂无进展记录。'; return; }
  for (const entry of history) {
    const article = document.createElement('article');
    article.className = 'progress-history-entry';
    const heading = document.createElement(selectable ? 'label' : 'div');
    heading.className = 'progress-history-heading';
    if (selectable) {
      const input = document.createElement('input');
      input.type = 'checkbox'; input.name = 'historyIds'; input.value = String(entry.id);
      input.setAttribute('aria-label', [entry.status, entry.position, ...(entry.messages || []).map((message) => message.subject || '无主题邮件'), entry.eventStart ? formatDateTime(entry.eventStart) : ''].filter(Boolean).join(' · '));
      heading.append(input);
    }
    const title = document.createElement('strong');
    const start = entry.eventStart || entry.recordedAt || entry.receivedAt;
    title.textContent = `${entry.status || '进展记录'} · ${start ? formatDateTime(start) : '时间未设置'}${entry.eventEnd ? ` 至 ${formatDateTime(entry.eventEnd)}` : ''}`;
    heading.append(title); article.append(heading);
    if (entry.position || entry.company) {
      const context = document.createElement('small');
      context.className = 'progress-history-context';
      context.textContent = [entry.company, entry.position].filter(Boolean).join(' · ');
      article.append(context);
    }
    const mails = entry.messages || [];
    const evidence = document.createElement('div');
    evidence.className = 'progress-history-evidence';
    if (entry.kind === 'manual' && !mails.length && !(entry.messageIds || []).length) {
      const label = document.createElement('span'); label.className = 'manual-record-label'; label.textContent = '手动记录'; evidence.append(label);
    }
    if (mails.length) { const caption = document.createElement('small'); caption.className = 'progress-history-mail-count'; caption.textContent = `相关邮件 · ${mails.length} 封`; evidence.append(caption); }
    for (const message of mails) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'history-email-link';
      button.textContent = message.subject || '无主题邮件';
      button.title = `${formatDateTime(message.receivedAt)} · 查看邮件`;
      button.setAttribute('aria-label', `查看邮件：${message.subject || '无主题邮件'}`);
      button.addEventListener('click', () => openEmail(entry.threadId ? { ...thread, id: entry.threadId, company: entry.company || thread?.company, position: entry.position || thread?.position } : thread, message.id));
      evidence.append(button);
    }
    if (evidence.childNodes.length) article.append(evidence);
    if (entry.notes) {
      const note = document.createElement('p'); note.className = 'progress-history-note'; note.textContent = entry.notes; article.append(note);
    }
    container.append(article);
  }
}

export function initApplicationOrganization({ api, openDialog, closeDialog, setDialogSaving, refresh, selectedRows, closeNameSuggestions, closeSplitSuggestions, openEmail, formatDateTime, onEditorMerge }) {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  let mergeSession = null;
  let structureSession = null;
  function status(id, message, error = false) { const node = $(`#${id}`); node.textContent = message; node.classList.toggle('error', error); }
  function applicationLabel(row) {
    const date = row.eventStart || row.latestReceivedAt || row.manualUpdatedAt;
    return `${row.company || '未识别公司'} · ${row.position || '未识别岗位'}${row.status ? ` · ${row.status}` : ''}${date ? ` · ${formatDateTime(date)}` : ''}`;
  }
  function eventRange(row) { return `${row.eventStart ? formatDateTime(row.eventStart) : '未设置'}${row.eventEnd ? ` 至 ${formatDateTime(row.eventEnd)}` : ''}`; }
  function renderSummary(target, proposed) {
    target.replaceChildren();
    for (const [name, value] of [['公司', proposed.company], ['职位', proposed.position || '未识别岗位'], ['当前状态', proposed.status], ['事件时间', eventRange(proposed)], ['备注', proposed.notes || '无']]) {
      const term = document.createElement('dt'); term.textContent = name;
      const detail = document.createElement('dd'); detail.textContent = value || '';
      target.append(term, detail);
    }
  }
  function renderHistory(target, history, thread, selectable = false) {
    renderProgressHistory(target, history, { thread, selectable, openEmail, formatDateTime });
  }
  function renderMergePreview(session, preview) {
    for (const row of [preview.target, ...preview.sources]) {
      const option = [...$('#mergeTarget').options].find((candidate) => candidate.value === String(row.id));
      if (option) option.textContent = applicationLabel(row);
    }
    $('#mergeSourceList').replaceChildren();
    for (const row of preview.sources) { const li = document.createElement('li'); li.textContent = applicationLabel(row); $('#mergeSourceList').append(li); }
    $('#mergeEvidenceSummary').textContent = `共 ${(preview.history || []).length} 条进展、${preview.emailCount} 封相关邮件${preview.manualCount ? `，含 ${preview.manualCount} 条手动记录` : ''}。`;
    renderSummary($('#mergeProposed'), preview.proposed);
    renderHistory($('#mergeHistory'), preview.history, preview.target);
    $('#mergeEditedHint').hidden = !session.progress;
    $('#mergePreview').hidden = false;
  }
  async function loadMergePreview(session = mergeSession) {
    if (!session || session.busy || session !== mergeSession) return;
    const request = ++session.request;
    const targetId = Number($('#mergeTarget').value);
    const sourceIds = session.rows.filter((row) => Number(row.id) !== targetId).map((row) => Number(row.id));
    session.submission = null;
    $('#mergePreview').hidden = true; $('#mergeConfirmButton').disabled = true; $('#mergeRefreshButton').disabled = true;
    $('#mergePreview').setAttribute('aria-busy', 'true');
    status('mergeStatus', '正在读取合并预览…');
    try {
      const params = new URLSearchParams({ targetId: String(targetId), sourceIds: sourceIds.join(',') });
      const preview = session.progress
        ? await api('/api/progress/merge-preview', { method: 'POST', body: { targetId, sourceIds, progress: session.progress } })
        : await api(`/api/progress/merge-preview?${params}`);
      if (session !== mergeSession || request !== session.request) return;
      session.submission = mergeSubmission(preview, preview.proposed);
      renderMergePreview(session, preview);
      $('#mergeConfirmButton').disabled = false;
      status('mergeStatus', '请核对最终申请及完整进展历史，确认后执行合并。');
    } catch (error) {
      if (session === mergeSession && request === session.request) status('mergeStatus', `无法预览：${error.message}`, true);
    } finally {
      if (session === mergeSession && request === session.request) { $('#mergeRefreshButton').disabled = false; $('#mergePreview').setAttribute('aria-busy', 'false'); }
    }
  }
  async function openMergeDialog({ rows, targetId = rows[0]?.id, progress = null, origin = 'selection' }) {
    if (rows.length < 2) return;
    closeNameSuggestions();
    const session = { rows: [...rows], progress: progress ? { ...progress } : null, origin, submission: null, request: 0, busy: false };
    mergeSession = session;
    $('#mergeTarget').replaceChildren();
    for (const row of rows) { const option = document.createElement('option'); option.value = String(row.id); option.textContent = applicationLabel(row); $('#mergeTarget').append(option); }
    $('#mergeTarget').value = String(targetId); $('#mergeTarget').disabled = origin === 'editor';
    $('#mergePreview').hidden = true; $('#mergeConfirmButton').disabled = true;
    openDialog('mergeDialog');
    await loadMergePreview(session);
  }
  $('#mergeTarget').addEventListener('change', () => loadMergePreview());
  $('#mergeRefreshButton').addEventListener('click', () => loadMergePreview());
  $('#mergeSelectedButton').addEventListener('click', () => openMergeDialog({ rows: selectedRows() }));
  $('#mergeDialog').addEventListener('close', () => { mergeSession = null; });
  $('#mergeForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = mergeSession;
    if (!session?.submission || session.busy || $('#mergeConfirmButton').disabled) return;
    const body = structuredClone(session.submission);
    session.busy = true;
    let release = setDialogSaving('mergeDialog');
    status('mergeStatus', '正在合并，全部进展和相关邮件会一起保留…');
    try {
      await api('/api/progress/merge', { method: 'POST', body });
      release(); release = null;
      closeDialog('mergeDialog');
      if (session.origin === 'editor') onEditorMerge();
      await refresh('申请已合并，全部进展和相关邮件已保留。');
    } catch (error) {
      if (session !== mergeSession) return;
      if (error.code === 'PROGRESS_STALE') { session.submission = null; $('#mergePreview').hidden = true; status('mergeStatus', '申请已发生变化，请重新预览后确认。', true); }
      else if (error.code === 'PROGRESS_CONFLICT') { session.submission = null; status('mergeStatus', `合并失败：${error.message}。请重新选择包含冲突申请的记录。`, true); }
      else status('mergeStatus', `合并失败：${error.message}`, true);
    } finally { release?.(); session.busy = false; if (session === mergeSession) $('#mergeConfirmButton').disabled = !session.submission; }
  });

  function selection() { return { historyIds: $$('#structureHistory input:checked').map((input) => input.value), ...(structureSession?.groupId ? { groupId: structureSession.groupId } : {}) }; }
  function invalidateSplitPreview() {
    if (structureSession) { structureSession.preview = null; structureSession.previewRequest += 1; }
    $('#splitPreview').hidden = true; $('#splitConfirmButton').disabled = true; $('#splitConfirmButton').hidden = true;
    if (structureSession) { structureSession.restorePreview = null; structureSession.restoreRequest += 1; }
    $('#restorePreview').hidden = true;
    $('#restoreMergeButton').disabled = Boolean(structureSession?.busy);
  }
  function updateSplitSelection() {
    const session = structureSession;
    const checked = splitSelection(session?.data, selection());
    $('#splitSelectionSummary').textContent = session?.data ? `已选 ${checked.selected} 条进展（${checked.emailCount} 封相关邮件）；原申请保留 ${checked.remaining} 条进展。` : '';
    $('#splitExpandButton').disabled = !checked.valid || session?.busy;
    $('#splitPreviewButton').disabled = !checked.valid || !session?.expanded || session?.busy;
    $('#splitConfirmButton').disabled = !checked.valid || !session?.preview || session?.busy;
  }
  function expandSplit() {
    if (!structureSession?.data || !splitSelection(structureSession.data, selection()).valid) return false;
    structureSession.expanded = true; $('#splitFields').hidden = false; $('#splitFields').disabled = false;
    updateSplitSelection();
    return true;
  }
  function fillSplitIdentity(values) { $('#splitCompany').value = values.company || ''; $('#splitPosition').value = values.position || ''; }
  function renderGroups(session) {
    const container = $('#structureGroups'); container.replaceChildren();
    const groups = session.data.groups || [];
    $('#structureGroupsSection').hidden = groups.length === 0;
    for (const group of groups) {
      const card = document.createElement('div'); card.className = 'structure-group';
      const heading = document.createElement('strong'); heading.textContent = `${group.company || '未识别公司'} · ${group.position || '未识别岗位'}`;
      const count = document.createElement('small'); count.textContent = `${(group.historyIds || []).length} 条进展`;
      const actions = document.createElement('div'); actions.className = 'structure-group-actions';
      const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'quiet-button'; choose.textContent = '选中这组';
      const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'secondary-button'; restore.textContent = '按这组拆分';
      const enabled = splitSelection(session.data, { historyIds: group.historyIds || [] }).valid;
      choose.disabled = restore.disabled = !enabled;
      async function selectGroup(withPreview) {
        if (session !== structureSession || session.busy) return;
        try {
          const picked = groupSelection(session.data, group.id);
          const selected = new Set(picked.historyIds);
          $$('#structureHistory input').forEach((input) => { input.checked = selected.has(input.value); });
          session.groupId = picked.groupId; fillSplitIdentity(picked); invalidateSplitPreview(); updateSplitSelection();
          if (withPreview && expandSplit()) await loadSplitPreview(session);
        } catch (error) { status('structureStatus', error.message, true); }
      }
      choose.addEventListener('click', () => selectGroup(false)); restore.addEventListener('click', () => selectGroup(true));
      actions.append(choose, restore); card.append(heading, count, actions); container.append(card);
    }
  }
  function renderSplitCard(container, title, result, thread) {
    container.replaceChildren();
    const heading = document.createElement('h3'); heading.textContent = title;
    const details = document.createElement('dl'); details.className = 'organization-proposed';
    const summary = result.proposed || result.thread || result;
    renderSummary(details, summary);
    const count = document.createElement('p'); count.className = 'organization-evidence';
    count.textContent = `${(result.history || []).length} 条进展 · ${result.emailCount ?? new Set((result.history || []).flatMap((row) => row.messageIds || [])).size} 封相关邮件`;
    const history = document.createElement('div'); history.className = 'progress-history-list'; renderHistory(history, result.history || [], thread);
    container.append(heading, details, count, history);
  }
  async function loadSplitPreview(session = structureSession) {
    if (!session?.data || session.busy || session !== structureSession || !session.expanded) return;
    let body;
    try { body = splitSubmission(session.data, Object.fromEntries(new FormData($('#splitForm'))), selection()); }
    catch (error) { status('structureStatus', error.message, true); return; }
    invalidateSplitPreview();
    const request = ++session.previewRequest;
    $('#splitPreviewButton').disabled = true; status('structureStatus', '正在根据所选进展计算双方申请…');
    try {
      const data = await api(`/api/progress/${session.threadId}/split-preview`, { method: 'POST', body });
      if (session !== structureSession || request !== session.previewRequest) return;
      const preview = { ...data, submission: { ...body, expectedUpdatedAt: data.expectedUpdatedAt } };
      splitPreviewSubmission(preview);
      renderSplitCard($('#splitOriginalPreview'), '原申请保留', preview.original, session.data.thread);
      renderSplitCard($('#splitCreatedPreview'), '新申请得到', preview.newApplication, session.data.thread);
      session.preview = preview;
      $('#splitPreview').hidden = false; $('#splitConfirmButton').hidden = false;
      status('structureStatus', '请核对双方的进展和相关邮件，确认后拆分。');
    } catch (error) {
      if (session === structureSession && request === session.previewRequest) {
        if (error.code === 'PROGRESS_STALE') { session.data = null; status('structureStatus', '申请已发生变化，请重新读取进展后选择。', true); }
        else status('structureStatus', `预览失败：${error.message}`, true);
      }
    } finally { if (session === structureSession && request === session.previewRequest) updateSplitSelection(); }
  }
  async function loadStructure(session = structureSession) {
    if (!session || session.busy || session !== structureSession) return;
    const request = ++session.request;
    session.data = null; session.expanded = false; session.groupId = null;
    closeSplitSuggestions(); invalidateSplitPreview();
    $('#structureRecords').hidden = true; $('#structureGroupsSection').hidden = true;
    $('#restoreMergeButton').hidden = true; $('#restoreUnavailableReason').hidden = true;
    $('#splitFields').hidden = true; $('#splitFields').disabled = true; $('#structureReloadButton').disabled = true;
    $('#structureHistory').replaceChildren(); updateSplitSelection(); status('structureStatus', '正在读取进展历史…');
    try {
      const data = await api(`/api/progress/${session.threadId}/structure`);
      if (session !== structureSession || request !== session.request) return;
      session.data = data;
      $('#structureSource').textContent = applicationLabel(data.thread);
      renderHistory($('#structureHistory'), data.history, data.thread, true); renderGroups(session);
      fillSplitIdentity(data.thread); $('#structureRecords').hidden = false;
      $('#restoreMergeButton').hidden = !data.restore?.available;
      $('#restoreUnavailableReason').textContent = data.restore?.reason || '';
      $('#restoreUnavailableReason').hidden = Boolean(data.restore?.available) || !data.restore?.reason || !data.groups?.length;
      updateSplitSelection();
      status('structureStatus', data.history.length > 1 ? '勾选要拆出的进展，或按原申请分组选择。' : '当前只有一条进展，原申请至少需保留一条，暂无法拆分。');
    } catch (error) { if (session === structureSession && request === session.request) status('structureStatus', `读取失败：${error.message}`, true); }
    finally { if (session === structureSession && request === session.request) $('#structureReloadButton').disabled = false; }
  }
  function openStructure(row) {
    if (!row) return;
    closeNameSuggestions(); closeSplitSuggestions(); $('#splitForm').reset();
    const session = { threadId: Number(row.id), data: null, request: 0, previewRequest: 0, restoreRequest: 0, restorePreview: null, expanded: false, preview: null, groupId: null, busy: false };
    structureSession = session; $('#structureSource').textContent = applicationLabel(row); openDialog('structureDialog'); loadStructure(session);
  }
  async function loadRestorePreview() {
    const session = structureSession;
    if (!session?.data?.restore?.available || session.busy) return;
    invalidateSplitPreview();
    const request = ++session.restoreRequest;
    $('#restoreMergeButton').disabled = true;
    status('structureStatus', '正在读取合并前的申请分组…');
    try {
      const preview = await api(`/api/progress/${session.threadId}/restore-preview`, { method: 'POST', body: { mergeEventId: session.data.restore.eventId } });
      if (session !== structureSession || request !== session.restoreRequest) return;
      restoreSubmission(preview);
      session.restorePreview = preview;
      $('#restoreGroupsPreview').replaceChildren();
      for (const group of preview.groups) {
        const card = document.createElement('section'); card.className = 'restore-group-preview';
        const heading = document.createElement('h3'); heading.textContent = `${group.company || '未识别公司'} · ${group.position || '未识别岗位'}`;
        const summary = document.createElement('dl'); summary.className = 'organization-proposed'; renderSummary(summary, group.proposed || group);
        const evidence = document.createElement('p'); evidence.className = 'organization-evidence';
        evidence.textContent = `${group.emailCount} 封相关邮件${group.manualCount ? ` · ${group.manualCount} 条手动记录` : ''}`;
        card.append(heading, summary, evidence);
        if (group.history) { const history = document.createElement('div'); history.className = 'progress-history-list'; renderHistory(history, group.history, session.data.thread); card.append(history); }
        $('#restoreGroupsPreview').append(card);
      }
      $('#restorePreview').hidden = false;
      status('structureStatus', '请核对各条申请的进展和相关邮件，确认后恢复。');
    } catch (error) {
      if (session === structureSession && request === session.restoreRequest) status('structureStatus', `无法预览恢复结果：${error.message}`, true);
    } finally { if (session === structureSession && request === session.restoreRequest) $('#restoreMergeButton').disabled = false; }
  }
  $('#restoreMergeButton').addEventListener('click', loadRestorePreview);
  $('#restoreCancelButton').addEventListener('click', () => { invalidateSplitPreview(); updateSplitSelection(); status('structureStatus', '可以继续选择进展进行拆分。'); });
  $('#restoreConfirmButton').addEventListener('click', async () => {
    const session = structureSession;
    if (!session?.restorePreview || session.busy) return;
    let body;
    try { body = restoreSubmission(session.restorePreview); } catch (error) { status('structureStatus', error.message, true); return; }
    session.busy = true;
    let release = setDialogSaving('structureDialog');
    status('structureStatus', '正在恢复原申请及其进展和相关邮件…');
    try {
      await api(`/api/progress/${session.threadId}/restore`, { method: 'POST', body });
      release(); release = null; closeDialog('structureDialog');
      await refresh('已恢复合并前的申请，进展和相关邮件已回到各自申请中。');
    } catch (error) {
      if (session !== structureSession) return;
      if (error.code === 'PROGRESS_STALE') { session.data = null; invalidateSplitPreview(); status('structureStatus', '申请已发生变化，请重新读取后预览恢复。', true); }
      else status('structureStatus', `恢复失败：${error.message}`, true);
    } finally { release?.(); session.busy = false; if (session === structureSession) updateSplitSelection(); }
  });
  $('#structureHistory').addEventListener('change', () => { if (structureSession) structureSession.groupId = null; invalidateSplitPreview(); updateSplitSelection(); });
  $('#structureReloadButton').addEventListener('click', () => loadStructure());
  $('#splitExpandButton').addEventListener('click', () => { if (expandSplit()) $('#splitCompany').focus(); });
  $('#splitFields').addEventListener('input', () => { if (structureSession) structureSession.groupId = null; invalidateSplitPreview(); updateSplitSelection(); });
  $('#splitPreviewButton').addEventListener('click', () => loadSplitPreview());
  $('#structureDialog').addEventListener('close', () => { structureSession = null; closeSplitSuggestions(); });
  $('#splitForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = structureSession;
    if (!session?.preview || session.busy || $('#splitConfirmButton').disabled) return;
    let body;
    try { body = splitPreviewSubmission(session.preview); } catch (error) { status('structureStatus', error.message, true); return; }
    session.busy = true; closeSplitSuggestions();
    let release = setDialogSaving('structureDialog'); status('structureStatus', '正在移动所选进展及其全部相关邮件…');
    try {
      await api(`/api/progress/${session.threadId}/split`, { method: 'POST', body });
      release(); release = null; closeDialog('structureDialog');
      await refresh('申请已拆分，所选进展及全部相关邮件已移入新申请。');
    } catch (error) {
      if (session !== structureSession) return;
      if (error.code === 'PROGRESS_STALE') { session.data = null; invalidateSplitPreview(); status('structureStatus', '申请已发生变化，请重新读取进展后选择。', true); }
      else status('structureStatus', `拆分失败：${error.message}`, true);
    } finally { release?.(); session.busy = false; if (session === structureSession) updateSplitSelection(); }
  });
  return { openMergeDialog, openStructure };
}
