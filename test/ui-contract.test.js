import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const indexHtml = readFileSync(join(process.cwd(), 'public/index.html'), 'utf8');
const stylesCss = readFileSync(join(process.cwd(), 'public/styles.css'), 'utf8');
const appJs = readFileSync(join(process.cwd(), 'public/app.js'), 'utf8');

test('the recruitment workspace exposes the calendar-first progress contract', () => {
  assert.match(indexHtml, /id="calendarCard"/);
  assert.match(indexHtml, /id="calendarYear"/);
  assert.match(indexHtml, /id="calendarMonth"/);
  assert.match(indexHtml, /id="dayDetailView"/);
  assert.match(indexHtml, /id="emailReaderDialog"/);
  assert.match(indexHtml, /class="window-inline"/);
  assert.match(indexHtml, /id="calendarBack"[^>]*aria-label="返回日历">←<\/button>/);
  assert.match(indexHtml, /<th>公司<\/th><th>职位<\/th><th>当前状态<\/th>/);
  assert.doesNotMatch(indexHtml, /公司 \/ 职位/);
  assert.doesNotMatch(indexHtml, /CAREER CONTROL ROOM/);
  assert.doesNotMatch(indexHtml, /APPLICATIONS <span>·<\/span> 02/);
  assert.doesNotMatch(indexHtml, /下一步动作/);
  assert.doesNotMatch(indexHtml, /class="window-bar"/);
  assert.doesNotMatch(indexHtml, /应用窗口/);
  assert.doesNotMatch(indexHtml, /class="overview-strip"/);
  assert.match(indexHtml, /class="table-col-company"/);
  assert.match(indexHtml, /class="table-col-position"/);
  assert.match(indexHtml, /保存后点击同步并分析将连接真实 QQ\/网易 IMAP/);
  assert.doesNotMatch(indexHtml, /真实 QQ \/ 网易 IMAP 连接将在下一阶段接入/);
  assert.doesNotMatch(indexHtml, /value="待确认"|value="拒绝"|<option value="筛选中">/);
  assert.match(stylesCss, /table-layout:fixed/);
});

test('the dashboard renders three panels on one screen without a hero banner', () => {
  assert.doesNotMatch(indexHtml, /class="hero-section"/);
  assert.doesNotMatch(indexHtml, /招聘进度，/);
  assert.match(indexHtml, /class="dashboard-grid"/);
  assert.match(indexHtml, /id="mailboxLabel"/);
  assert.match(indexHtml, /id="lastSyncLabel"/);
  assert.match(stylesCss, /\.dashboard-grid\{/);
});

test('the settings dialog uses a plain provider list without redundant cards', () => {
  assert.doesNotMatch(indexHtml, /id="providerCards"/);
  assert.doesNotMatch(indexHtml, /class="provider-cards"/);
  assert.match(indexHtml, /id="providerId"/);
  assert.match(stylesCss, /\.settings-section\.active\{[^}]*min-height/);
});

test('topbar is decluttered and toast sits top-center', () => {
  assert.doesNotMatch(indexHtml, /topbar-middle/);
  assert.doesNotMatch(indexHtml, /招聘追踪<\/span>/);
  assert.match(indexHtml, /rel="icon"/);
  assert.match(stylesCss, /\.notice\{[^}]*top:20px;left:50%;transform:translateX\(-50%\)/);
  assert.match(stylesCss, /@keyframes spin/);
  assert.match(stylesCss, /\.calendar-grid\{[^}]*grid-template-rows:repeat\(6,1fr\)/);
});

test('the front end consumes application-thread rows instead of per-message rows', () => {
  // 查看邮件按钮携带线程的 latestMessageId，手动记录渲染灰色文本而非按钮
  assert.match(appJs, /data-email-id="\$\{row\.latestMessageId\}"/);
  assert.match(appJs, /latestMessageId == null/);
  assert.match(appJs, /手动记录/);
  // 邮件正文请求按 latestMessageId 走既有 GET /api/progress/:id/email
  assert.match(appJs, /\/api\/progress\/\$\{row\.latestMessageId\}\/email/);
  // 编辑提交走 PUT /api/progress/:id 线程接口
  assert.match(appJs, /method: 'PUT'/);
  // 事件窗口兼容线程行的 latestReceivedAt 字段
  assert.match(appJs, /row\.latestReceivedAt/);
});
