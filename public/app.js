import { buildMonthGrid, dateKey, eventDateKeys, formatDateRange, formatEmailTabLabel, formatSenderDisplay, formatTime, parseDateKey } from './calendar-model.js';
import { readSyncStream } from './sync-stream.js';
import { createSettingsSubmitHandler } from './settings-form.js';
import { getCompanySuggestions, getPositionSuggestions } from './application-suggestions.js';
import { progressFromForm } from './application-organization.js';
import { initApplicationOrganization, renderProgressHistory } from './application-organization-ui.js';

const WINDOW_START_KEY = 'career-mail-tracker.window-start';
const state = {
  settings: { providers: [], mailbox: null },
  dashboard: { recent: [], counts: {}, total: 0 },
  calendarRows: [],
  selectedProvider: null,
  selectedRows: new Set(),
  emailReader: { row: null, messages: [] },
  calendar: { year: new Date().getFullYear(), month: new Date().getMonth(), selectedDate: null },
  syncController: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, signal: options.signal || AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', ...(options.headers || {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || '请求失败');
    error.code = body.code;
    error.status = response.status;
    throw error;
  }
  return body;
}

function showNotice(message, type = 'success') { const notice = $('#notice'); notice.textContent = message; notice.classList.toggle('error', type === 'error'); notice.classList.toggle('warn', type === 'warn'); clearTimeout(showNotice.timer); showNotice.timer = setTimeout(() => { notice.textContent = ''; }, 5000); }

function setSyncLoading(on, { cancelling = false } = {}) {
  const b = $('#syncNowButton');
  b.disabled = cancelling;
  b.classList.toggle('cancel-sync', on);
  b.textContent = on ? (cancelling ? '取消中…' : '取消同步') : '↻ 同步并分析';
  $('#mailboxSync').setAttribute('aria-busy', String(on));
  $('#syncProgress').setAttribute('aria-hidden', String(!on));
}

function setSyncStatus(label) {
  const status = $('#syncStatus');
  status.textContent = label;
  // Keep the complete message available when the fixed status line truncates it.
  status.title = label;
  status.setAttribute('aria-label', label);
}

function renderSyncProgress(event) {
  const completed = event.completed || 0;
  const total = event.total || 0;
  const label = event.stage === 'analyzing' ? `Agent解析进度：${completed}/${total}`
    : ['fetching', 'parsing'].includes(event.stage) ? `邮件读取进度：${completed}/${total}` : event.label || '同步进行中';
  if ($('#syncStatus').textContent !== label) setSyncStatus(label);
  const progress = $('#syncProgress');
  progress.max = total || 1;
  if (total > 0) progress.value = completed;
  else progress.removeAttribute('value');
}
function pad(value) { return String(value).padStart(2, '0'); }
function todayInput() { const now = new Date(); return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; }
function toLocalDateTime(value = new Date()) { const date = new Date(value); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }

function setInitialWindow() {
  const savedStart = localStorage.getItem(WINDOW_START_KEY);
  if (savedStart) $('#windowFrom').value = savedStart;
  else { $('#windowFrom').value = `${new Date().getFullYear()}-01-01`; }
  $('#windowTo').value = todayInput();
}

function windowQuery() {
  const params = new URLSearchParams();
  if ($('#windowFrom').value) params.set('from', $('#windowFrom').value);
  if ($('#windowTo').value) params.set('to', $('#windowTo').value);
  return params.toString();
}

function statusTone(status) {
  if (status === '面试') return 'tone-interview';
  if (status === '测评中') return 'tone-assessment';
  if (status === 'Offer') return 'tone-offer';
  if (status === '已投递') return 'tone-submitted';
  if (status === '已结束') return 'tone-gray';
  return 'tone-blue';
}

function displayRows() { return state.dashboard.recent; }
function allDisplayRows() { return state.calendarRows; }

function getEventWindow(row) {
  const start = row.eventStart || row.latestReceivedAt || row.receivedAt;
  if (row.eventEnd) return { start, end: row.eventEnd, allDay: row.status === '测评中' };
  if (row.status === '测评中') { const end = new Date(start); end.setDate(end.getDate() + 3); end.setHours(23, 59, 0, 0); return { start, end: end.toISOString(), allDay: true }; }
  if (row.status === '面试') { const end = new Date(start); end.setMinutes(end.getMinutes() + 60); return { start, end: end.toISOString(), allDay: false }; }
  return { start, end: null, allDay: false };
}

function eventForRow(row) {
  if (!['测评中', '面试'].includes(row.status)) return null;
  const window = getEventWindow(row);
  return { row, ...window, type: row.status === '测评中' ? 'assessment' : 'interview', label: `${row.company || '未识别公司'} · ${row.position || row.status}`, dateKeys: eventDateKeys(window.start, window.end || window.start) };
}

function calendarEvents() { return allDisplayRows().map(eventForRow).filter(Boolean); }

function renderMetrics() {
  const rows = displayRows();
  const counts = rows.reduce((result, row) => { result[row.status] = (result[row.status] || 0) + 1; return result; }, {});
  $('#pipelineTotal').textContent = `${rows.length} 个申请`;
  $('#resultCount').textContent = `${rows.length} 条记录`;
  $('#countSubmitted').textContent = counts['已投递'] || 0;
  $('#countAssessment').textContent = counts['测评中'] || 0;
  $('#countInterview').textContent = counts['面试'] || 0;
  $('#countOffer').textContent = counts.Offer || 0;
}

function formatNotes(row) {
  return row.notes || '';
}

function renderRows() {
  const search = ($('#searchInput').value || '').trim().toLowerCase();
  const filter = $('#statusFilter').value;
  const rows = displayRows().filter((row) => { const text = `${row.company || ''} ${row.position || ''} ${row.subject || ''}`.toLowerCase(); return (!search || text.includes(search)) && (!filter || row.status === filter); });
  $('#emptyHint').hidden = rows.length > 0;
  const target = $('#applicationRows');
  if (!rows.length) { target.innerHTML = '<tr><td colspan="8" class="empty-cell">这个时间窗口还没有记录。</td></tr>'; updateSelectionUI(); return; }
  target.innerHTML = rows.map((row) => {
    const window = getEventWindow(row);
    const position = row.position || '未识别岗位';
    const notes = formatNotes(row);
    const emailCell = row.latestMessageId == null
      ? '<span class="email-link email-manual">手动记录</span>'
      : `<button class="email-link" type="button" data-email-id="${row.latestMessageId}" data-thread-id="${row.id}">查看邮件 ↗</button>`;
    return `<tr data-row-id="${row.id}"><td class="check-column"><label class="check-wrap"><input class="row-check" type="checkbox" data-row-id="${row.id}" ${state.selectedRows.has(row.id) ? 'checked' : ''} /><span></span></label></td><td class="company-cell"><strong>${escapeHtml(row.company || '未识别公司')}</strong></td><td class="position-cell"><span class="cell-two-lines" title="${escapeAttr(position)}">${escapeHtml(position)}</span></td><td><span class="status-chip ${statusTone(row.status)}">${escapeHtml(row.status)}</span></td><td class="date-cell">${formatDateRange(window.start, window.end)}</td><td class="notes-cell"><span class="cell-two-lines" title="${escapeAttr(notes)}">${escapeHtml(notes)}</span></td><td>${emailCell}</td><td class="action-column"><div class="row-actions"><button class="row-edit" type="button" data-edit-id="${row.id}" aria-label="编辑 ${escapeAttr(row.company || '')}">编辑</button><button class="row-organize" type="button" data-organize-id="${row.id}" aria-label="进展历史 ${escapeAttr(row.company || '')}">进展历史</button></div></td></tr>`;
  }).join('');
  updateSelectionUI();
}

function renderProviders() {
  const providers = state.settings.providers || [];
  if (!state.selectedProvider || !providers.some((item) => item.id === state.selectedProvider)) {
    state.selectedProvider = state.settings.activeProviderId || providers[0]?.id || null;
  }
  $('#providerId').innerHTML = providers.map((provider) => `<option value="${escapeAttr(provider.id)}">${escapeHtml(provider.name)}</option>`).join('');
  $('#providerId').value = state.selectedProvider || '';
  applyProviderToForm();
}

function applyProviderToForm() { const provider = state.settings.providers.find((item) => item.id === $('#providerId').value); if (!provider) return; state.selectedProvider = provider.id; $('#providerName').value = provider.name; $('#providerBaseUrl').value = provider.baseUrl; $('#providerModel').value = provider.model; }
function renderMailbox() { const mailbox = state.settings.mailbox; const label = mailbox?.email || '尚未连接邮箱'; $('#mailboxLabel').textContent = label; $('#mailboxLabel').title = label; $('#mailboxForm [name="provider"]').value = mailbox?.provider || 'qq'; $('#mailboxForm [name="email"]').value = mailbox?.email || ''; }

function setCalendarOptions() {
  const currentYear = new Date().getFullYear();
  const years = new Set(Array.from({ length: 7 }, (_, index) => currentYear - 3 + index));
  calendarEvents().forEach((event) => event.dateKeys.forEach((key) => years.add(Number(key.slice(0, 4)))));
  $('#calendarYear').innerHTML = [...years].sort((a, b) => a - b).map((year) => `<option value="${year}">${year}年</option>`).join('');
  $('#calendarYear').value = String(state.calendar.year);
  $('#calendarMonth').innerHTML = Array.from({ length: 12 }, (_, index) => `<option value="${index}">${index + 1}月</option>`).join('');
  $('#calendarMonth').value = String(state.calendar.month);
}

function renderCalendar() {
  setCalendarOptions();
  const events = calendarEvents();
  const cells = buildMonthGrid(state.calendar.year, state.calendar.month, events);
  const today = dateKey(new Date());
  $('#calendarGrid').innerHTML = cells.map((cell) => `<button class="calendar-cell ${cell.inMonth ? '' : 'outside-month'} ${cell.key === today ? 'today-cell' : ''}" type="button" data-calendar-date="${cell.key}"><span class="calendar-day-number">${cell.date.getDate()}</span><span class="calendar-events">${cell.events.slice(0, 3).map((event) => `<span class="calendar-event ${event.type}" title="${escapeAttr(event.label)}"><i></i>${escapeHtml(event.label)}</span>`).join('')}${cell.events.length > 3 ? `<span class="more-events">+${cell.events.length - 3} 个</span>` : ''}</span></button>`).join('');
}

function renderDayDetail(date) {
  const day = parseDateKey(date);
  $('#dayDetailTitle').textContent = `${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日`;
  $('#dayDetailWeekday').textContent = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(day);
  const events = calendarEvents().filter((event) => event.dateKeys.includes(date));
  $('#dayDetailTimeline').innerHTML = events.length ? events.map((event) => `<div class="timeline-row"><div class="timeline-time">${event.allDay ? '全天' : formatTime(event.start)}</div><div class="timeline-event ${event.type}"><strong>${escapeHtml(event.label)}</strong><small>${escapeHtml(formatNotes(event.row))}</small>${event.row.latestMessageId == null ? '<span class="email-link email-manual">手动记录</span>' : `<button class="email-link" type="button" data-email-id="${event.row.latestMessageId}" data-thread-id="${event.row.id}">查看相关邮件 ↗</button>`}</div></div>`).join('') : '<div class="day-empty">这一天没有测评或面试安排。</div>';
}

function openDayDetail(date) { state.calendar.selectedDate = date; $('#calendarMonthView').hidden = true; $('#dayDetailView').hidden = false; renderDayDetail(date); }
function closeDayDetail() { state.calendar.selectedDate = null; $('#calendarMonthView').hidden = false; $('#dayDetailView').hidden = true; }

function visibleSelectedRows() {
  const visibleIds = new Set($$('.row-check').filter((input) => input.checked).map((input) => Number(input.dataset.rowId)));
  return displayRows().filter((row) => visibleIds.has(Number(row.id)) && state.selectedRows.has(Number(row.id)));
}
function updateSelectionUI() {
  const visibleIds = $$('.row-check').map((input) => Number(input.dataset.rowId));
  const selectedVisible = visibleIds.filter((id) => state.selectedRows.has(id));
  $('#selectionLabel').textContent = selectedVisible.length ? `已选择 ${selectedVisible.length} 条` : '选择记录';
  $('#deleteSelectedButton').disabled = selectedVisible.length === 0;
  $('#mergeSelectedButton').disabled = selectedVisible.length < 2;
  $('#selectAll').checked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
  $('#selectAll').indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.length;
}

function openDialog(id) { const dialog = $(`#${id}`); if (!dialog.open) dialog.showModal(); }
function closeDialog(id) { const dialog = $(`#${id}`); if (dialog.open && dialog.dataset.saving !== 'true') dialog.close(); }
let progressHistoryRequest = 0;
let manualEditorVersion = 0;
let manualEditorSnapshot = null;
async function loadProgressHistory(threadId) {
  const requestId = ++progressHistoryRequest;
  $('#progressHistory').hidden = !threadId;
  $('#progressHistoryList').replaceChildren();
  $('#progressHistoryStatus').textContent = threadId ? '正在读取进展历史…' : '';
  if (!threadId) return;
  try {
    const data = await api(`/api/progress/${threadId}/structure`);
    if (requestId !== progressHistoryRequest) return;
    renderProgressHistory($('#progressHistoryList'), data.history, { thread: data.thread, openEmail, formatDateTime });
    $('#progressHistoryStatus').textContent = '';
  } catch {
    if (requestId === progressHistoryRequest) $('#progressHistoryStatus').textContent = '进展历史暂时无法读取，可继续编辑。';
  }
}

function fillEditor(row = null) {
  const form = $('#manualForm');
  manualEditorVersion += 1;
  closeApplicationSuggestions();
  form.reset();
  form.elements.id.value = row?.id || '';
  const account = state.settings.mailbox?.email;
  const targets = allDisplayRows().filter((candidate) => candidate.accountId === account || candidate.accountId === 'manual');
  if (row && !targets.some((candidate) => candidate.id === row.id)) targets.unshift(row);
  form.elements.threadId.innerHTML = (row ? '' : '<option value="">新增独立申请</option>')
    + targets.map((candidate) => `<option value="${candidate.id}">${escapeHtml(candidate.company)} · ${escapeHtml(candidate.position || '未识别岗位')} · ${escapeHtml(candidate.status)} · ${formatDateTime(candidate.eventStart || candidate.latestReceivedAt || candidate.manualUpdatedAt)}</option>`).join('');
  form.elements.threadId.value = row?.id || '';
  $('#manualTargetField').hidden = false;
  form.elements.company.readOnly = false;
  form.elements.position.required = !row;
  form.elements.company.value = row?.company || '';
  form.elements.position.value = row?.position || '';
  form.elements.status.value = row?.status || '面试';
  const window = row ? getEventWindow(row) : getEventWindow({ status: '面试', receivedAt: new Date().toISOString() });
  form.elements.eventStart.value = toLocalDateTime(window.start);
  const end = row ? row.eventEnd : window.end;
  form.elements.eventEnd.value = end ? toLocalDateTime(end) : '';
  form.elements.notes.value = row ? formatNotes(row) : '';
  manualEditorSnapshot = row ? {original:structuredClone(row),displayed:{eventStart:form.elements.eventStart.value,
    eventEnd:form.elements.eventEnd.value,notes:form.elements.notes.value}} : null;
  $('#manualSaveStatus').textContent = '';
  $('#progressDialogTitle').textContent = row ? '编辑招聘进展' : '添加一条进展';
  openDialog('manualDialog');
  loadProgressHistory(row?.id);
}

$('#manualThreadId').addEventListener('change', () => {
  const form = $('#manualForm');
  closeApplicationSuggestions();
  const target = allDisplayRows().find((row) => String(row.id) === form.elements.threadId.value);
  form.elements.company.readOnly = Boolean(target) && !form.elements.id.value;
  form.elements.position.required = !target;
  form.elements.company.value = target?.company || '';
  form.elements.position.value = target ? (target.position || form.elements.position.value) : '';
  loadProgressHistory(target?.id);
});

function createNameSuggestions(input, listbox, getSuggestions, describe) {
  let candidates = [];
  let activeIndex = -1;
  function close() {
    listbox.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  }
  function update() {
    if (input.readOnly || input.disabled || document.activeElement !== input) { close(); return; }
    candidates = getSuggestions();
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
    listbox.replaceChildren();
    for (const [index, candidate] of candidates.entries()) {
      const option = document.createElement('div');
      option.id = `${listbox.id}-${index}`;
      option.className = 'application-suggestion';
      option.dataset.suggestionIndex = String(index);
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      const name = document.createElement('strong');
      name.textContent = candidate.value;
      name.title = candidate.value;
      const context = document.createElement('small');
      context.textContent = describe(candidate);
      context.title = context.textContent;
      option.append(name, context);
      listbox.append(option);
    }
    listbox.scrollTop = 0;
    listbox.hidden = candidates.length === 0;
    input.setAttribute('aria-expanded', String(candidates.length > 0));
  }
  function activate(index) {
    activeIndex = index;
    [...listbox.children].forEach((option, optionIndex) => option.setAttribute('aria-selected', String(optionIndex === index)));
    const option = listbox.children[index];
    if (!option) return;
    input.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
  }
  function select(index) {
    const candidate = candidates[index];
    if (!candidate) return;
    input.value = candidate.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close();
  }
  input.addEventListener('focus', update);
  input.addEventListener('input', update);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Escape' && !listbox.hidden) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (input.readOnly || input.disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (listbox.hidden) update();
      if (!candidates.length) return;
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const next = activeIndex < 0 ? (direction > 0 ? 0 : candidates.length - 1) : (activeIndex + direction + candidates.length) % candidates.length;
      activate(next);
    } else if (event.key === 'Enter' && !listbox.hidden && activeIndex >= 0) {
      event.preventDefault();
      select(activeIndex);
    }
  });
  listbox.addEventListener('pointerdown', (event) => {
    // Keep keyboard focus on the combobox so a click can choose an option before blur.
    if (event.target.closest('[data-suggestion-index]')) event.preventDefault();
  });
  listbox.addEventListener('click', (event) => {
    const option = event.target.closest('[data-suggestion-index]');
    if (option) select(Number(option.dataset.suggestionIndex));
  });
  return { close };
}

const companyNameSuggestions = createNameSuggestions($('#manualCompany'), $('#companySuggestions'),
  () => getCompanySuggestions(allDisplayRows(), $('#manualCompany').value), () => '已有申请中的公司名称');
const positionNameSuggestions = createNameSuggestions($('#manualPosition'), $('#positionSuggestions'),
  () => getPositionSuggestions(allDisplayRows(), { company: $('#manualCompany').value, query: $('#manualPosition').value }),
  (candidate) => candidate.matchesCompany ? '当前公司已有岗位' : candidate.companies.join('、') || '已有申请中的岗位名称');
function closeApplicationSuggestions() { companyNameSuggestions.close(); positionNameSuggestions.close(); }
$('#manualCompany').addEventListener('input', () => positionNameSuggestions.close());
$('#manualDialog').addEventListener('close', () => { manualEditorVersion += 1; progressHistoryRequest += 1; closeApplicationSuggestions(); });

const splitCompanyNameSuggestions = createNameSuggestions($('#splitCompany'), $('#splitCompanySuggestions'),
  () => getCompanySuggestions(allDisplayRows(), $('#splitCompany').value), () => '已有申请中的公司名称');
const splitPositionNameSuggestions = createNameSuggestions($('#splitPosition'), $('#splitPositionSuggestions'),
  () => getPositionSuggestions(allDisplayRows(), { company: $('#splitCompany').value, query: $('#splitPosition').value }),
  (candidate) => candidate.matchesCompany ? '当前公司已有岗位' : candidate.companies.join('、') || '已有申请中的岗位名称');
function closeSplitSuggestions() { splitCompanyNameSuggestions.close(); splitPositionNameSuggestions.close(); }
$('#splitCompany').addEventListener('input', () => splitPositionNameSuggestions.close());

function organizationStatus(id, text, error = false) {
  const element = $(`#${id}`);
  element.textContent = text;
  element.classList.toggle('error', error);
}
function setDialogSaving(id) {
  const dialog = $(`#${id}`);
  const controls = [...dialog.querySelectorAll('input, select, textarea, button')].map((control) => [control, control.disabled]);
  dialog.dataset.saving = 'true';
  dialog.setAttribute('aria-busy', 'true');
  controls.forEach(([control]) => { control.disabled = true; });
  return () => {
    delete dialog.dataset.saving;
    dialog.setAttribute('aria-busy', 'false');
    controls.forEach(([control, disabled]) => { control.disabled = disabled; });
  };
}
for (const id of ['manualDialog', 'mergeDialog', 'structureDialog']) {
  $(`#${id}`).addEventListener('cancel', (event) => {
    if (event.currentTarget.dataset.saving === 'true') event.preventDefault();
  });
}
async function refreshAfterOrganization(message) {
  state.selectedRows.clear();
  try {
    await refreshAll();
    $('.table-wrap').scrollTop = 0;
    showNotice(message);
  } catch (error) {
    showNotice(`${message} 列表刷新失败，请刷新页面查看：${error.message}`, 'warn');
  }
}
const { openMergeDialog, openStructure } = initApplicationOrganization({
  api, openDialog, closeDialog, setDialogSaving, refresh: refreshAfterOrganization,
  selectedRows: visibleSelectedRows, closeNameSuggestions: closeApplicationSuggestions,
  closeSplitSuggestions, openEmail, formatDateTime,
  onEditorMerge: () => { closeDialog('manualDialog'); $('#manualForm').reset(); },
});

function renderEmailMessage(index) {
  const row = state.emailReader.row;
  const detail = state.emailReader.messages[index];
  if (!row || !detail) return;
  $$('#emailHistoryTabs [data-email-history-index]').forEach((button) => {
    const active = Number(button.dataset.emailHistoryIndex) === index;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const sender = formatSenderDisplay(detail.sender);
  const subject = detail.subject || `${row.company || '招聘'}${row.position ? ` · ${row.position}` : ''}进展通知`;
  const receivedAt = formatDateTime(detail.receivedAt || row.latestReceivedAt || row.receivedAt);
  $('#emailSender').textContent = sender;
  $('#emailSender').title = sender;
  $('#emailSubject').textContent = subject;
  $('#emailSubject').title = subject;
  $('#emailReceivedAt').textContent = receivedAt;
  $('#emailReceivedAt').title = receivedAt;
  const bodyHost = $('#emailBody');
  if (detail.bodyHtml) {
    bodyHost.innerHTML = '';
    const frame = document.createElement('iframe');
    frame.className = 'email-frame';
    frame.setAttribute('sandbox', '');
    frame.referrerPolicy = 'no-referrer';
    bodyHost.appendChild(frame);
    frame.srcdoc = detail.bodyHtml;
  } else if (detail.bodyText) {
    const textNode = document.createElement('div');
    textNode.className = 'email-body-text';
    textNode.textContent = detail.bodyText;
    bodyHost.innerHTML = '';
    bodyHost.appendChild(textNode);
  } else {
    bodyHost.innerHTML = '<div class="email-body-empty">本地未保存这封邮件的正文。</div>';
  }
}

let emailReaderRequest = 0;
$('#emailReaderDialog').addEventListener('close', () => { emailReaderRequest += 1; state.emailReader = { row: null, messages: [] }; });
async function openEmail(row, requestedMessageId = null) {
  if (!row) return;
  const request = ++emailReaderRequest;
  const reader = { row, messages: [] };
  state.emailReader = reader;
  $('#emailHistoryTabs').innerHTML = '<span class="email-history-loading">正在读取邮件历史…</span>';
  $('#emailSender').textContent = '招聘团队';
  $('#emailSubject').textContent = `${row.company || '招聘'}${row.position ? ` · ${row.position}` : ''}进展通知`;
  $('#emailReceivedAt').textContent = formatDateTime(row.latestReceivedAt || row.receivedAt);
  $('#emailBody').innerHTML = '<div class="email-body-empty">正在读取原始邮件…</div>';
  openDialog('emailReaderDialog');
  try {
    const history = await api(`/api/progress/${row.id}/emails`);
    if (request !== emailReaderRequest || state.emailReader !== reader) return;
    state.emailReader.messages = history.messages || [];
    if (!state.emailReader.messages.length) throw new Error('邮件历史为空');
    const selectedIndex = Math.max(0, state.emailReader.messages.findIndex((mail) => Number(mail.id) === Number(requestedMessageId)));
    $('#emailHistoryTabs').innerHTML = state.emailReader.messages.map((mail, index) => `<button class="email-history-tab ${index === selectedIndex ? 'active' : ''}" type="button" data-email-history-index="${index}" aria-pressed="${index === selectedIndex}">${escapeHtml(formatEmailTabLabel(mail.receivedAt))}</button>`).join('');
    renderEmailMessage(selectedIndex);
  } catch {
    if (request !== emailReaderRequest || state.emailReader !== reader) return;
    $('#emailHistoryTabs').innerHTML = '';
    $('#emailBody').innerHTML = '<div class="email-body-empty">本地未保存这条申请的邮件正文。<br />可到邮箱中按主题搜索原邮件。</div>';
  }
}

async function refreshDashboard() { state.dashboard = await api(`/api/dashboard?${windowQuery()}`); renderMetrics(); renderRows(); }
async function refreshCalendarData() { const data = await api('/api/dashboard'); state.calendarRows = data.recent; renderCalendar(); }
async function refreshSettings() { state.settings = await api('/api/settings'); renderProviders(); renderMailbox(); }
async function refreshAll() { await Promise.all([refreshSettings(), refreshDashboard(), refreshCalendarData()]); }

async function syncCurrentWindow({ auto = false } = {}) {
  if (state.syncController) return;
  const mailbox = state.settings.mailbox;
  if (!mailbox?.email || !mailbox?.credentialConfigured) {
    showNotice('请先在「设置 → 邮箱连接」中配置邮箱与 IMAP 授权码，再同步邮件。', 'warn');
    if (auto) return;
    $('#openSettings').click();
    return;
  }
  const body = auto ? { auto: true } : { from: $('#windowFrom').value, to: $('#windowTo').value };
  if (!auto && (!body.from || !body.to)) throw Object.assign(new Error('请先选择时间窗口'), { code: 'GENERIC' });
  const controller = new AbortController();
  state.syncController = controller;
  $('#syncProgress').removeAttribute('value');
  setSyncLoading(true);
  setSyncStatus('邮箱连接中');
  let dashboardDirty = false;
  let refreshBusy = false;
  let lastRefresh = Promise.resolve();
  // Refresh committed rows at most twice a second and never overlap refreshes.
  const refreshTimer = setInterval(() => {
    if (!dashboardDirty || refreshBusy) return;
    dashboardDirty = false;
    refreshBusy = true;
    lastRefresh = Promise.all([refreshDashboard(), refreshCalendarData()])
      .catch((error) => { console.warn('progress refresh failed:', error.message); })
      .finally(() => { refreshBusy = false; });
  }, 500);
  try {
    const result = await readSyncStream({ body, signal: controller.signal, onEvent: (event) => {
      if (event.type === 'progress' && !controller.signal.aborted) { renderSyncProgress(event); if (event.changed) dashboardDirty = true; }
    } });
    setSyncStatus(result.stopReason === 'SYNC_RUN_TIMEOUT' ? '本轮已达时间上限，可重新同步继续'
      : result.stopReason === 'MODEL_RATE_LIMITED' ? '模型限流，本轮已停止'
      : result.stopReason === 'SYNC_CANCELLED' ? '同步已取消'
      : result.stopReason ? `同步停止：${result.failures?.find((failure) => failure.error === result.stopReason)?.message || result.stopReason}`
      : result.modelFailed > 0 ? '同步完成，部分邮件分析失败'
      : result.sourceFetched === 0 && result.sourceDeferred === 0 ? '同步完成，无待处理邮件' : '同步完成');
    const rateLimited = result.failures?.some((failure) => failure.error === 'MODEL_RATE_LIMITED');
    if (rateLimited) showNotice('模型额度或调用频率已达上限；未处理邮件会在下次同步时继续分析。', 'warn');
    else if (result.stopReason === 'SYNC_CANCELLED') showNotice('同步已取消，已写入记录保留；下次同步继续处理未完成邮件。', 'warn');
    else if (result.stopReason === 'SYNC_RUN_TIMEOUT') showNotice('本轮同步达到时间上限，已写入结果保留；重新同步将继续处理剩余邮件。', 'warn');
    else if (result.modelFailed > 0) showNotice('部分邮件分析失败，请检查模型配置后重试', 'warn');
    else if (!auto || result.inserted > 0) showNotice(`同步完成：新增 ${result.inserted} 封分析结果，跳过 ${(result.sourceCached || 0) + result.skipped} 封已检查邮件。`);
  } catch (error) {
    setSyncStatus(error.code === 'SYNC_CANCELLED' ? '同步已取消，已写入记录保留' : `同步停止：${error.message}`);
    if (error.code === 'SYNC_CANCELLED') {
      showNotice('同步已取消，已写入记录保留；下次同步继续处理未完成邮件。', 'warn');
    } else if (error.code === 'MODEL_UNAVAILABLE') {
      showNotice('尚未配置分析模型：请打开「设置 → 模型供应商」配置 LLM 后再同步邮件。', 'warn');
    } else if (error.code === 'MAILBOX_CONFIG') {
      showNotice(auto ? '邮箱自动同步失败（请检查邮箱配置或网络后重试）' : '邮箱连接失败：请检查「设置 → 邮箱连接」的配置与授权码。', 'error');
    } else if (!auto) {
      showNotice(error.message, 'error');
    } else {
      console.warn('auto sync failed:', error.message);
    }
  } finally {
    clearInterval(refreshTimer);
    state.syncController = null;
    setSyncLoading(false);
    await lastRefresh;
    await Promise.allSettled([refreshDashboard(), refreshCalendarData()]);
  }
}

function formatDateTime(value) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)).replaceAll('/', '-'); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
function escapeAttr(value) { return escapeHtml(value); }

$('#openSettings').addEventListener('click', () => openDialog('settingsDialog'));
$('#addProgressButton').addEventListener('click', () => fillEditor());
$$('[data-close]').forEach((button) => button.addEventListener('click', () => closeDialog(button.dataset.close)));
$$('.settings-tab').forEach((button) => button.addEventListener('click', () => { $$('.settings-tab').forEach((tab) => tab.classList.toggle('active', tab === button)); $$('.settings-section').forEach((panel) => panel.classList.toggle('active', panel.dataset.settingsPanel === button.dataset.settingsTab)); }));
$('#providerId').addEventListener('change', applyProviderToForm);
$('#searchInput').addEventListener('input', renderRows);
$('#statusFilter').addEventListener('change', renderRows);
$('#selectAll').addEventListener('change', (event) => { $$('.row-check').forEach((input) => { const id = Number(input.dataset.rowId); if (event.target.checked) state.selectedRows.add(id); else state.selectedRows.delete(id); input.checked = event.target.checked; }); updateSelectionUI(); });
$('#applicationRows').addEventListener('change', (event) => { if (!event.target.classList.contains('row-check')) return; const id = Number(event.target.dataset.rowId); if (event.target.checked) state.selectedRows.add(id); else state.selectedRows.delete(id); updateSelectionUI(); });
$('#applicationRows').addEventListener('click', (event) => {
  const emailButton = event.target.closest('[data-thread-id]');
  if (emailButton) { openEmail(allDisplayRows().find((row) => String(row.id) === emailButton.dataset.threadId)); return; }
  const organizeId = event.target.closest('[data-organize-id]')?.dataset.organizeId;
  if (organizeId) { openStructure(allDisplayRows().find((row) => String(row.id) === organizeId)); return; }
  const editId = event.target.closest('[data-edit-id]')?.dataset.editId;
  if (editId) fillEditor(allDisplayRows().find((row) => String(row.id) === editId));
});
$('#deleteSelectedButton').addEventListener('click', async () => { const ids = [...state.selectedRows]; if (!ids.length || !window.confirm(`确认删除选中的 ${ids.length} 条进展吗？`)) return; try { const result = await api('/api/progress/delete', { method: 'POST', body: { ids } }); state.selectedRows.clear(); await refreshAll(); showNotice(`已删除 ${result.deleted} 条进展。`); } catch (error) { showNotice(error.message, 'error'); } });

async function applyWindowSelection() {
  if ($('#windowFrom').value > $('#windowTo').value) { showNotice('开始日期不能晚于结束日期。', 'error'); return; }
  localStorage.setItem(WINDOW_START_KEY, $('#windowFrom').value);
  $('#windowTo').value = todayInput();
  try { await refreshDashboard(); } catch (error) { showNotice(error.message, 'error'); }
}
$('#windowForm').addEventListener('submit', async (event) => { event.preventDefault(); await applyWindowSelection(); showNotice('时间窗口已更新。'); });
$('#windowFrom').addEventListener('change', applyWindowSelection);
$('#windowTo').addEventListener('change', applyWindowSelection);
$('#syncNowButton').addEventListener('click', () => {
  if (state.syncController) {
    if (state.syncController.signal.aborted) return;
    setSyncLoading(true, { cancelling: true });
    setSyncStatus('正在取消同步');
    state.syncController.abort(Object.assign(new Error('同步已取消，已写入的记录保留'), { code: 'SYNC_CANCELLED' }));
    return;
  }
  syncCurrentWindow().catch((error) => showNotice(error.message, 'error'));
});

$('#calendarPrev').addEventListener('click', () => { state.calendar.month -= 1; if (state.calendar.month < 0) { state.calendar.month = 11; state.calendar.year -= 1; } renderCalendar(); });
$('#calendarNext').addEventListener('click', () => { state.calendar.month += 1; if (state.calendar.month > 11) { state.calendar.month = 0; state.calendar.year += 1; } renderCalendar(); });
$('#calendarToday').addEventListener('click', () => { const now = new Date(); state.calendar.year = now.getFullYear(); state.calendar.month = now.getMonth(); closeDayDetail(); renderCalendar(); });
$('#calendarYear').addEventListener('change', (event) => { state.calendar.year = Number(event.target.value); closeDayDetail(); renderCalendar(); });
$('#calendarMonth').addEventListener('change', (event) => { state.calendar.month = Number(event.target.value); closeDayDetail(); renderCalendar(); });
$('#calendarGrid').addEventListener('click', (event) => { const date = event.target.closest('[data-calendar-date]')?.dataset.calendarDate; if (date) openDayDetail(date); });
$('#calendarBack').addEventListener('click', closeDayDetail);
$('#dayDetailTimeline').addEventListener('click', (event) => { const emailButton = event.target.closest('[data-thread-id]'); if (emailButton) openEmail(allDisplayRows().find((row) => String(row.id) === emailButton.dataset.threadId)); });
$('#emailHistoryTabs').addEventListener('click', (event) => { const button = event.target.closest('[data-email-history-index]'); if (button) renderEmailMessage(Number(button.dataset.emailHistoryIndex)); });

$('#providerForm').addEventListener('submit', createSettingsSubmitHandler({
  save: async (body) => {
    await api('/api/settings/provider', { method: 'POST', body });
    $('#modelTestStatus').textContent = '配置已更新，尚未测试';
    if (!state.syncController) {
      setSyncStatus('模型配置已更新，请测试后重新同步');
    }
  },
  refresh: refreshSettings, notify: showNotice, secretField: 'apiKey',
  successMessage: '模型配置已保存，可测试已保存模型后再同步。',
}));

async function testSavedConnection(button, status, path, successLabel) {
  if (button.disabled) return;
  button.disabled = true;
  status.textContent = '连接测试中…';
  try {
    const result = await api(path, { method: 'POST', body: {}, signal: AbortSignal.timeout(20_000) });
    status.textContent = successLabel(result);
    showNotice(status.textContent);
  } catch (error) {
    status.textContent = error.message;
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}
$('#testModelButton').addEventListener('click', () => testSavedConnection(
  $('#testModelButton'), $('#modelTestStatus'), '/api/model/test',
  (result) => `模型连接正常：${result.model} · ${(result.elapsedMs / 1000).toFixed(1)} 秒`,
));
$('#testMailboxButton').addEventListener('click', () => testSavedConnection(
  $('#testMailboxButton'), $('#mailboxTestStatus'), '/api/mailbox/test', () => '邮箱连接正常',
));
$('#mailboxForm').addEventListener('submit', createSettingsSubmitHandler({
  save: (body) => api('/api/settings/mailbox', { method: 'POST', body }),
  refresh: refreshSettings, notify: showNotice, secretField: 'authorizationCode',
  successMessage: '邮箱配置已保存。',
}));
$('#manualForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  if (button.disabled) return;
  const values = Object.fromEntries(new FormData(form));
  const editorVersion = manualEditorVersion;
  const threadId = values.threadId ? Number(values.threadId) : null;
  const sourceId = values.id ? Number(values.id) : null;
  let body;
  try { body = progressFromForm(values, manualEditorSnapshot || {}); }
  catch (error) { organizationStatus('manualSaveStatus', error.message, true); return; }
  closeApplicationSuggestions();
  let release = setDialogSaving('manualDialog');
  organizationStatus('manualSaveStatus', sourceId && sourceId !== threadId ? '正在准备合并预览…' : '正在保存进展…');
  try {
    if (sourceId && sourceId !== threadId) {
      const source = allDisplayRows().find((row) => Number(row.id) === sourceId);
      const target = allDisplayRows().find((row) => Number(row.id) === threadId);
      if (!source || !target) throw new Error('申请已变化，请重新打开编辑窗口。');
      release(); release = null;
      await openMergeDialog({ rows: [target, source], targetId: threadId,
        progress: {company:body.company,position:body.position}, origin: 'editor' });
      if (editorVersion === manualEditorVersion) organizationStatus('manualSaveStatus', '请在合并预览中确认；取消后可以继续编辑。');
      return;
    }
    if (sourceId) await api(`/api/progress/${sourceId}`, { method: 'PUT', body });
    else await api('/api/progress/manual', { method: 'POST', body: { ...body, threadId, evidence: '用户手动记录', nextAction: '由用户手动维护' } });
    release(); release = null;
    closeDialog('manualDialog');
    form.reset();
    await refreshAfterOrganization(threadId ? '已有申请已更新，相关邮件保留。' : '独立申请已添加。');
  } catch (error) {
    organizationStatus('manualSaveStatus', error.message, true);
    showNotice(error.message, 'error');
  } finally {
    release?.();
  }
});

setInitialWindow();
refreshAll().then(() => {
  if (state.settings.mailbox?.credentialConfigured && state.settings.mailbox?.email) {
    syncCurrentWindow({ auto: true }).catch(() => {});
  }
}).catch((error) => showNotice(`无法连接本地服务：${error.message}`, 'error'));
