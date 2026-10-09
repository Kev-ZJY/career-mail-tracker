import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { progressFromForm, mergeSubmission, splitSelection, splitSubmission, groupSelection, splitPreviewSubmission, restoreSubmission } from '../public/application-organization.js';

test('editing identity preserves untouched precise or unknown event dates instead of creating progress from form defaults', () => {
  const original = {eventStart:'2026-09-27T07:23:45.000Z',eventEnd:null,notes:null};
  const displayed = {eventStart:'2026-09-27T15:23',eventEnd:'',notes:''};
  const values = {...displayed,company:'更正公司',position:'岗位甲',status:'测评中'};
  const edited = progressFromForm(values,{original,displayed});
  assert.equal(edited.eventStart,original.eventStart);
  assert.equal(edited.eventEnd,null);
  assert.equal(edited.notes,null);
  assert.equal(progressFromForm(values,{original:{...original,eventStart:null},displayed}).eventStart,null);
  assert.notEqual(progressFromForm({...values,eventStart:'2026-09-28T15:23'},{original,displayed}).eventStart,original.eventStart);
});

const structure = {
  thread: { id: 8, updatedAt: 'v8', company: '示例出行', position: '示例业务培训生-航线' },
  history: [
    { id: 'email:21', kind: 'email', status: '已投递', messageIds: [21, 22] },
    { id: 'email:23', kind: 'email', status: '已结束', messageIds: [23] },
    { id: 'manual:7', kind: 'manual', status: '面试', messageIds: [] },
  ],
  groups: [{ id: 'group:2', company: '示例出行', position: '示例业务培训生-产品', historyIds: ['email:21', 'email:23'] }],
};

test('merge submission binds all members and optional edited progress to the preview versions', () => {
  const preview = { target: { id: 8 }, sources: [{ id: 3 }, { id: 4 }], expectedUpdatedAt: { 8: 'v8', 3: 'v3', 4: 'v4' } };
  const draft = { company: '甲公司', position: '产品经理', status: '面试' };
  const result = mergeSubmission(preview, draft);
  preview.expectedUpdatedAt[8] = 'changed-after-preview'; draft.status = 'Offer';
  assert.deepEqual(result, { targetId: 8, sourceIds: [3, 4], expectedUpdatedAt: { 8: 'v8', 3: 'v3', 4: 'v4' }, progress: { company: '甲公司', position: '产品经理', status: '面试' } });
  assert.throws(() => mergeSubmission({ ...preview, expectedUpdatedAt: { 8: 'v8' } }), /重新预览/);
});

test('split selects a strict subset of actual progress history and carries all linked mails', () => {
  assert.equal(splitSelection(structure).valid, false);
  assert.equal(splitSelection(structure, { historyIds: structure.history.map(({ id }) => id) }).valid, false);
  assert.equal(splitSelection(structure, { historyIds: ['snapshot:99'] }).valid, false);
  const checked = splitSelection(structure, { historyIds: ['email:21', 'email:21', 'manual:7'] });
  assert.deepEqual(checked.historyIds, ['email:21', 'manual:7']);
  assert.equal(checked.valid, true);
  assert.equal(checked.selected, 2);
  assert.equal(checked.remaining, 1);
  assert.equal(checked.emailCount, 2);
  assert.equal(checked.manualCount, 1);
});

test('split preview sends identity and history only, leaving statuses and event dates to history', () => {
  const values = { company: ' 示例出行 ', position: ' 示例业务培训生-产品 ', status: 'Offer', eventStart: '2040-01-01', notes: 'stale notes' };
  assert.deepEqual(splitSubmission(structure, values, { historyIds: ['email:21', 'email:23'] }), {
    company: '示例出行', position: '示例业务培训生-产品', historyIds: ['email:21', 'email:23'], expectedUpdatedAt: 'v8',
  });
  assert.throws(() => splitSubmission(structure, values, { historyIds: [] }), /至少保留/);
});

test('merged application group chooses every retained history entry and its original name', () => {
  assert.deepEqual(groupSelection(structure, 'group:2'), {
    historyIds: ['email:21', 'email:23'], company: '示例出行', position: '示例业务培训生-产品', groupId: 'group:2',
  });
  assert.throws(() => groupSelection(structure, 'unknown'), /重新读取/);
});

test('split confirmation uses a snapshot of a successful server preview', () => {
  const preview = { submission: { historyIds: ['email:21'], company: '示例出行', position: '产品', expectedUpdatedAt: 'v8' }, original: { history: [] }, newApplication: { history: [] } };
  const body = splitPreviewSubmission(preview);
  preview.submission.historyIds.push('manual:7');
  assert.deepEqual(body.historyIds, ['email:21']);
  assert.throws(() => splitPreviewSubmission(null), /重新预览/);
});

test('restore confirmation binds the exact merge preview rather than fabricating progress', () => {
  assert.deepEqual(restoreSubmission({ groups: [{ id: 2 }, { id: 8 }], mergeEventId: 15, expectedUpdatedAt: 'v8' }), { mergeEventId: 15, expectedUpdatedAt: 'v8' });
  assert.throws(() => restoreSubmission({ groups: [], mergeEventId: 15, expectedUpdatedAt: 'v8' }), /重新预览/);
});

test('date fields are captured and validated before an asynchronous progress edit', () => {
  const values = { company: ' 甲公司 ', position: '研发', status: '面试', eventStart: '2030-01-01T09:00:00.000Z', eventEnd: '2030-01-01T10:00:00.000Z' };
  assert.equal(progressFromForm(values).eventStart, '2030-01-01T09:00:00.000Z');
  assert.equal(progressFromForm(values).company, '甲公司');
  assert.throws(() => progressFromForm({ ...values, eventEnd: '2029-12-31T09:00:00.000Z' }), /不能早于/);
  assert.throws(() => progressFromForm({ ...values, eventStart: 'invalid' }), /有效/);
});

test('organization UI exposes unified history and side by side previews, with no meaningless client markers', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const app = readFileSync('public/app.js', 'utf8');
  for (const id of ['mergeSelectedButton', 'mergeHistory', 'structureHistory', 'structureGroups', 'splitOriginalPreview', 'splitCreatedPreview', 'splitPreviewButton', 'splitConfirmButton', 'restoreMergeButton', 'restorePreview', 'restoreConfirmButton', 'progressHistoryList']) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.doesNotMatch(html + app, /手动进展历史|手动历史记录|人工修正|source-label/);
  assert.match(app, /initApplicationOrganization/);
  assert.doesNotMatch(html.match(/<fieldset id="splitFields"[\s\S]*?<\/fieldset>/)?.[0] || '', /name="status"|name="eventStart"|name="eventEnd"|name="notes"/);
});
