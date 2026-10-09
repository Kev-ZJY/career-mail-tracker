import test from 'node:test';
import assert from 'node:assert/strict';
import { getCompanySuggestions, getPositionSuggestions } from '../public/application-suggestions.js';

test('company suggestions use distinct existing names and include merged source application names', () => {
  const rows = [
    { company: '示例科技', position: '产品经理', sourceApplications: [{ company: '示例科技有限公司', position: '产品经理' }] },
    { company: ' 示例科技 ', position: '' },
    { company: 'ACME', originalApplications: [{ company: 'acme' }, { company: '未识别公司' }] },
    { company: '未知' }, { company: '' },
  ];
  assert.deepEqual(getCompanySuggestions(rows).map(({ value }) => value), ['示例科技', '示例科技有限公司', 'ACME']);
  assert.deepEqual(getCompanySuggestions(rows, '示例').map(({ value }) => value), ['示例科技', '示例科技有限公司']);
  assert.deepEqual(getCompanySuggestions(rows, 'acme').map(({ value }) => value), ['ACME']);
});

test('position suggestions prioritize the selected company and retain other companies as context', () => {
  const rows = [
    { company: '乙公司', position: '前端工程师' },
    { company: '甲公司', position: '产品经理' },
    { company: '甲公司', position: '后端工程师' },
    { company: '丙公司', position: '产品经理' },
    { company: '甲公司', position: '未知岗位' },
    { company: '甲公司', position: '' },
  ];
  const candidates = getPositionSuggestions(rows, { company: ' 甲公司 ' });
  assert.deepEqual(candidates.map(({ value }) => value), ['产品经理', '后端工程师', '前端工程师']);
  assert.deepEqual(candidates[0], { value: '产品经理', companies: ['甲公司', '丙公司'], matchesCompany: true });
  assert.deepEqual(getPositionSuggestions(rows, { company: '甲公司', query: '工程师' }).map(({ value }) => value), ['后端工程师', '前端工程师']);
});

test('matching keeps all candidates beyond the three-row viewport and uses case-insensitive prefix ranking', () => {
  const rows = [
    { company: 'The Alpha', position: '资深产品经理' },
    { company: 'Alpha', position: '产品经理' },
    { company: 'Alpha Robotics', position: '产品经理助理' },
    { company: 'Alpha Labs', position: '技术产品经理' },
    { company: 'Alpha Studio', position: '商业产品经理' },
  ];
  assert.deepEqual(getCompanySuggestions(rows, 'ALPHA').map(({ value }) => value), ['Alpha', 'Alpha Robotics', 'Alpha Labs', 'Alpha Studio', 'The Alpha']);
  assert.equal(getPositionSuggestions(rows, { query: '产品经理' }).length, 5);
  assert.equal(getPositionSuggestions(rows, { query: '产品经理' })[0].value, '产品经理');
});

test('source application positions remain selectable without changing or alias-merging the input rows', () => {
  const rows = [{ company: '示例', position: '工程师', sourceApplications: [{ company: '示例研发', position: '算法工程师' }] }];
  const before = JSON.stringify(rows);
  assert.deepEqual(getPositionSuggestions(rows, { company: '示例研发' })[0], { value: '算法工程师', companies: ['示例研发'], matchesCompany: true });
  assert.deepEqual(getCompanySuggestions(rows, '示例').map(({ value }) => value), ['示例', '示例研发']);
  assert.equal(JSON.stringify(rows), before);
});
