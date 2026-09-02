import { buildMonthGrid, dateKey, eventDateKeys, formatDateRange, formatTime, parseDateKey } from './calendar-model.js';

const WINDOW_START_KEY = 'career-mail-tracker.window-start';
const state = {
  settings: { providers: [], mailbox: null },
  dashboard: { recent: [], counts: {}, total: 0 },
  calendarRows: [],
  selectedProvider: null,
  selectedRows: new Set(),
  calendar: { year: new Date().getFullYear(), month: new Date().getMonth(), selectedDate: null },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
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

function setSyncLoading(on) {
  const b = $('#syncNowButton');
  b.disabled = on;
  b.classList.toggle('loading', on);
  b.innerHTML = on ? '<span class="spin">⟳</span> 同步中…' : '↻ 同步并分析';
  $('#lastSyncLabel').textContent = on ? '正在同步邮箱邮件…' : $('#lastSyncLabel').textContent;
}
function pad(value) { return String(value).padStart(2, '0'); }
function todayInput() { const now = new Date(); return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; }
function dateInputFromDate(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
function toLocalDateTime(value = new Date()) { const date = new Date(value); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
function fromDateInput(value, hour = '00:00:00.000Z') { return `${value}T${hour}`; }
function localDateFromInput(value) { const [year, month, day] = value.split('-').map(Number); return new Date(year, month - 1, day); }

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
  if (row.notes) return row.notes;
  const notes = [row.evidence || '邮件中未提取到备注'];
  if (row.needsReview || Number(row.confidence) < 0.75) notes.push('低置信度 · 建议人工确认');
  return notes.join(' · ');
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
    const emailCell = row.latestMessageId == null
      ? '<span class="email-link email-manual">手动记录</span>'
      : `<button class="email-link" type="button" data-email-id="${row.latestMessageId}" data-thread-id="${row.id}">查看邮件 ↗</button>`;
    return `<tr data-row-id="${row.id}"><td class="check-column"><label class="check-wrap"><input class="row-check" type="checkbox" data-row-id="${row.id}" ${state.selectedRows.has(row.id) ? 'checked' : ''} /><span></span></label></td><td class="company-cell"><strong>${escapeHtml(row.company || '未识别公司')}</strong>${row.source === 'manual' ? '<span class="source-label">手动</span>' : ''}</td><td class="position-cell">${escapeHtml(row.position || '未识别职位')}</td><td><span class="status-chip ${statusTone(row.status)}">${escapeHtml(row.status)}</span></td><td class="date-cell">${formatDateRange(window.start, window.end)}</td><td class="notes-cell">${escapeHtml(formatNotes(row))}</td><td>${emailCell}</td><td class="action-column"><button class="row-edit" type="button" data-edit-id="${row.id}" aria-label="编辑 ${escapeAttr(row.company || '')}">编辑</button></td></tr>`;
  }).join('');
  updateSelectionUI();
}

function renderProviders() {
  const providers = state.settings.providers || [];
  if (!state.selectedProvider || !providers.some((item) => item.id === state.selectedProvider)) state.selectedProvider = providers[0]?.id || null;
  $('#providerId').innerHTML = providers.map((provider) => `<option value="${escapeAttr(provider.id)}">${escapeHtml(provider.name)}</option>`).join('');
  $('#providerId').value = state.selectedProvider || '';
  applyProviderToForm();
}

function applyProviderToForm() { const provider = state.settings.providers.find((item) => item.id === $('#providerId').value); if (!provider) return; state.selectedProvider = provider.id; $('#providerName').value = provider.name; $('#providerBaseUrl').value = provider.baseUrl; $('#providerModel').value = provider.model; }
function renderMailbox() { const mailbox = state.settings.mailbox; $('#mailboxLabel').textContent = mailbox?.email || '尚未连接邮箱'; $('#mailboxForm [name="provider"]').value = mailbox?.provider || 'qq'; $('#mailboxForm [name="email"]').value = mailbox?.email || ''; }
function renderSelectedTime() { if ($('#windowFrom').value && $('#windowTo').value) $('#lastSyncLabel').textContent = `${formatDateRange(localDateFromInput($('#windowFrom').value), localDateFromInput($('#windowTo').value))} · ${displayRows().length} 条进展`; else $('#lastSyncLabel').textContent = '等待第一次同步'; }

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

function updateSelectionUI() { const visibleIds = $$('.row-check').map((input) => Number(input.dataset.rowId)); const selectedVisible = visibleIds.filter((id) => state.selectedRows.has(id)); $('#selectionLabel').textContent = selectedVisible.length ? `已选择 ${selectedVisible.length} 条` : '选择记录'; $('#deleteSelectedButton').disabled = selectedVisible.length === 0; $('#selectAll').checked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length; $('#selectAll').indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.length; }

function openDialog(id) { const dialog = $(`#${id}`); if (!dialog.open) dialog.showModal(); }
function closeDialog(id) { const dialog = $(`#${id}`); if (dialog.open) dialog.close(); }
function fillEditor(row = null) { const form = $('#manualForm'); form.reset(); form.elements.id.value = row?.id || ''; form.elements.company.value = row?.company || ''; form.elements.position.value = row?.position || ''; form.elements.status.value = row?.status || '面试'; const window = row ? getEventWindow(row) : getEventWindow({ status: '面试', receivedAt: new Date().toISOString() }); form.elements.eventStart.value = toLocalDateTime(window.start); form.elements.eventEnd.value = window.end && !window.allDay ? toLocalDateTime(window.end) : (window.end ? toLocalDateTime(window.end) : ''); form.elements.notes.value = row ? formatNotes(row) : ''; $('#progressDialogTitle').textContent = row ? '编辑招聘进展' : '添加一条进展'; openDialog('manualDialog'); }

async function openEmail(row) {
  if (!row) return;
  $('#emailSender').textContent = '招聘团队';
  $('#emailSubject').textContent = `${row.company || '招聘'}${row.position ? ` · ${row.position}` : ''}进展通知`;
  $('#emailReceivedAt').textContent = formatDateTime(row.latestReceivedAt || row.receivedAt);
  const bodyHost = $('#emailBody');
  bodyHost.innerHTML = '<div class="email-body-empty">正在读取原始邮件…</div>';
  $('#openMailboxLink').href = row.provider === 'netease' ? 'https://email.163.com/' : 'https://mail.qq.com/';
  openDialog('emailReaderDialog');
  try {
    const detail = await api(`/api/progress/${row.latestMessageId}/email`);
    $('#emailSender').textContent = detail.sender || '招聘团队';
    $('#emailSubject').textContent = detail.subject || $('#emailSubject').textContent;
    $('#emailReceivedAt').textContent = formatDateTime(detail.receivedAt || row.latestReceivedAt || row.receivedAt);
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
    }
    $('#emailLinkHint').textContent = row.webUrl || detail.webUrl ? '以下方按钮打开邮箱查看原邮件' : 'IMAP 只提供邮件身份，打开邮箱后可用主题搜索原邮件';
  } catch {
    bodyHost.innerHTML = '<div class="email-body-empty">本地未保存这封邮件的正文。<br />可点击下方按钮到邮箱中按主题搜索原邮件。</div>';
    $('#emailLinkHint').textContent = 'IMAP 只提供邮件身份，打开邮箱后可用主题搜索原邮件';
  }
}

async function refreshDashboard() { state.dashboard = await api(`/api/dashboard?${windowQuery()}`); renderMetrics(); renderRows(); renderSelectedTime(); }
async function refreshCalendarData() { const data = await api('/api/dashboard'); state.calendarRows = data.recent; renderCalendar(); }
async function refreshSettings() { state.settings = await api('/api/settings'); renderProviders(); renderMailbox(); }
async function refreshAll() { await Promise.all([refreshSettings(), refreshDashboard(), refreshCalendarData()]); }

async function syncCurrentWindow({ auto = false } = {}) {
  const mailbox = state.settings.mailbox;
  if (!mailbox?.email || !mailbox?.credentialConfigured) {
    showNotice('请先在「设置 → 邮箱连接」中配置邮箱与 IMAP 授权码，再同步邮件。', 'warn');
    if (auto) return;
    $('#openSettings').click();
    return;
  }
  const body = auto ? { auto: true } : { from: $('#windowFrom').value, to: $('#windowTo').value };
  if (!auto && (!body.from || !body.to)) throw Object.assign(new Error('请先选择时间窗口'), { code: 'GENERIC' });
  setSyncLoading(true);
  try {
    const result = await api('/api/sync/run', { method: 'POST', body });
    await Promise.all([refreshDashboard(), refreshCalendarData()]);
    if (result.modelFailed > 0) showNotice('部分邮件分析失败，请检查模型配置后重试', 'warn');
    else if (!auto || result.inserted > 0) showNotice(`同步完成：新增 ${result.inserted} 条，跳过 ${result.skipped} 条。`);
  } catch (error) {
    if (error.code === 'MODEL_UNAVAILABLE') {
      showNotice('尚未配置分析模型：请打开「设置 → 模型供应商」配置 LLM 后再同步邮件。', 'warn');
    } else if (error.code === 'MAILBOX_CONFIG') {
      showNotice(auto ? '邮箱自动同步失败（请检查邮箱配置或网络后重试）' : '邮箱连接失败：请检查「设置 → 邮箱连接」的配置与授权码。', 'error');
    } else if (!auto) {
      showNotice(error.message, 'error');
    } else {
      console.warn('auto sync failed:', error.message);
    }
    throw error;
  } finally { setSyncLoading(false); }
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
$('#applicationRows').addEventListener('click', (event) => { const emailButton = event.target.closest('[data-thread-id]'); if (emailButton) { openEmail(allDisplayRows().find((row) => String(row.id) === emailButton.dataset.threadId)); return; } const editId = event.target.closest('[data-edit-id]')?.dataset.editId; if (editId) fillEditor(allDisplayRows().find((row) => String(row.id) === editId)); });
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
$('#refreshButton').addEventListener('click', () => refreshAll().then(() => showNotice('本地进度已刷新。')).catch((error) => showNotice(error.message, 'error')));
$('#syncNowButton').addEventListener('click', () => syncCurrentWindow().catch((error) => showNotice(error.message, 'error')));

$('#calendarPrev').addEventListener('click', () => { state.calendar.month -= 1; if (state.calendar.month < 0) { state.calendar.month = 11; state.calendar.year -= 1; } renderCalendar(); });
$('#calendarNext').addEventListener('click', () => { state.calendar.month += 1; if (state.calendar.month > 11) { state.calendar.month = 0; state.calendar.year += 1; } renderCalendar(); });
$('#calendarToday').addEventListener('click', () => { const now = new Date(); state.calendar.year = now.getFullYear(); state.calendar.month = now.getMonth(); closeDayDetail(); renderCalendar(); });
$('#calendarYear').addEventListener('change', (event) => { state.calendar.year = Number(event.target.value); closeDayDetail(); renderCalendar(); });
$('#calendarMonth').addEventListener('change', (event) => { state.calendar.month = Number(event.target.value); closeDayDetail(); renderCalendar(); });
$('#calendarGrid').addEventListener('click', (event) => { const date = event.target.closest('[data-calendar-date]')?.dataset.calendarDate; if (date) openDayDetail(date); });
$('#calendarBack').addEventListener('click', closeDayDetail);
$('#dayDetailTimeline').addEventListener('click', (event) => { const emailButton = event.target.closest('[data-thread-id]'); if (emailButton) openEmail(allDisplayRows().find((row) => String(row.id) === emailButton.dataset.threadId)); });

$('#providerForm').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/settings/provider', { method: 'POST', body: Object.fromEntries(new FormData(event.currentTarget)) }); await refreshSettings(); event.currentTarget.querySelector('[name="apiKey"]').value = ''; showNotice('模型配置已保存。API key 只在当前进程内保留。'); } catch (error) { showNotice(error.message, 'error'); } });
$('#mailboxForm').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/settings/mailbox', { method: 'POST', body: Object.fromEntries(new FormData(event.currentTarget)) }); await refreshSettings(); event.currentTarget.querySelector('[name="authorizationCode"]').value = ''; showNotice('邮箱连接草稿已保存。'); } catch (error) { showNotice(error.message, 'error'); } });
$('#manualForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const id = form.get('id'); const values = Object.fromEntries(form); if (values.eventEnd && values.eventEnd < values.eventStart) { showNotice('结束时间不能早于开始时间。', 'error'); return; } try { if (id) { await api(`/api/progress/${id}`, { method: 'PUT', body: { company: values.company, position: values.position, status: values.status, eventStart: new Date(values.eventStart).toISOString(), eventEnd: values.eventEnd ? new Date(values.eventEnd).toISOString() : null, notes: values.notes, evidence: values.notes || '手动更新', nextAction: '由用户手动维护' } }); await refreshAll(); showNotice('这条进展已更新。'); } else { await api('/api/progress/manual', { method: 'POST', body: { company: values.company, position: values.position, status: values.status, receivedAt: values.eventStart, evidence: values.notes || '手动记录', nextAction: '由用户手动维护' } }); await refreshAll(); showNotice('手动进展已添加。'); } closeDialog('manualDialog'); event.currentTarget.reset(); } catch (error) { showNotice(error.message, 'error'); } });

setInitialWindow();
refreshAll().then(() => {
  if (state.settings.mailbox?.credentialConfigured && state.settings.mailbox?.email) {
    syncCurrentWindow({ auto: true }).catch(() => {});
  }
}).catch((error) => showNotice(`无法连接本地服务：${error.message}`, 'error'));
