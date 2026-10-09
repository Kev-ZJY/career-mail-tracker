export function progressFromForm(values, {original = null, displayed = null} = {}) {
  const company = String(values.company || '').trim();
  if (!company) throw new Error('请填写公司名称。');
  const preserve = key => original && displayed && values[key] === displayed[key];
  const startValue = preserve('eventStart') ? original.eventStart : values.eventStart;
  const endValue = preserve('eventEnd') ? original.eventEnd : values.eventEnd;
  const start = startValue ? new Date(startValue) : null;
  const end = endValue ? new Date(endValue) : null;
  if ((!start && !preserve('eventStart')) || (start && !Number.isFinite(start.getTime())) || (end && (!start || !Number.isFinite(end.getTime())))) throw new Error('请填写有效的事件时间。');
  if (end && end < start) throw new Error('结束时间不能早于开始时间。');
  return {
    company, position: String(values.position || '').trim(), status: values.status,
    notes: preserve('notes') ? original.notes : values.notes || '', eventStart: start ? start.toISOString() : null, eventEnd: end ? end.toISOString() : null,
  };
}

export function mergeSubmission(preview, progress = null) {
  if (!preview?.target || !preview.sources?.length) throw new Error('请先重新预览合并结果。');
  const targetId = Number(preview.target.id);
  const sourceIds = preview.sources.map(({ id }) => Number(id));
  const ids = [targetId, ...sourceIds];
  if (new Set(ids).size !== ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('合并申请选择无效，请重新预览。');
  if (ids.some((id) => !preview.expectedUpdatedAt?.[id])) throw new Error('预览缺少申请版本，请重新预览。');
  return {
    targetId, sourceIds,
    expectedUpdatedAt: Object.fromEntries(ids.map((id) => [id, preview.expectedUpdatedAt[id]])),
    ...(progress ? { progress: { ...progress } } : {}),
  };
}

function historyId(row) { return String(row.id); }

export function splitSelection(structure, { historyIds = [] } = {}) {
  const ids = [...new Set(historyIds.map(String))];
  const history = structure?.history || [];
  const known = new Map(history.map((row) => [historyId(row), row]));
  const selectedRows = ids.flatMap((id) => known.has(id) ? [known.get(id)] : []);
  const messages = new Set(selectedRows.flatMap((row) => row.messageIds || row.messages?.map(({ id }) => id) || []).map(Number));
  return {
    historyIds: ids, selected: ids.length, total: known.size, remaining: known.size - ids.length,
    emailCount: messages.size, manualCount: selectedRows.filter((row) => row.kind === 'manual' && !(row.messageIds || row.messages || []).length).length,
    valid: ids.every((id) => known.has(id)) && ids.length > 0 && ids.length < known.size,
  };
}

export function splitSubmission(structure, values, selection) {
  const checked = splitSelection(structure, selection);
  if (!checked.valid) throw new Error('请选择要拆出的进展，并为原申请至少保留一条进展。');
  if (!structure?.thread?.updatedAt) throw new Error('申请版本缺失，请重新读取记录。');
  const company = String(values.company || '').trim();
  if (!company) throw new Error('请填写公司名称。');
  return {
    historyIds: checked.historyIds, company, position: String(values.position || '').trim(),
    expectedUpdatedAt: structure.thread.updatedAt,
  };
}

export function groupSelection(structure, groupId) {
  const group = structure?.groups?.find((row) => String(row.id) === String(groupId));
  if (!group) throw new Error('原申请分组已变化，请重新读取进展。');
  const historyIds = [...new Set((group.historyIds || []).map(String))];
  const checked = splitSelection(structure, { historyIds });
  if (!checked.valid) throw new Error('这组进展无法单独拆出，请重新读取或手动选择。');
  return { historyIds, company: group.company || '', position: group.position || '', groupId: String(group.id) };
}

export function splitPreviewSubmission(preview) {
  if (!preview?.submission || !preview.original || !preview.newApplication) throw new Error('请先重新预览拆分结果。');
  if (!preview.submission.expectedUpdatedAt) throw new Error('预览缺少申请版本，请重新预览。');
  return structuredClone(preview.submission);
}

export function restoreSubmission(preview) {
  if (!preview?.groups?.length || !preview.expectedUpdatedAt || !Number.isSafeInteger(Number(preview.mergeEventId)) || Number(preview.mergeEventId) < 1) throw new Error('请先重新预览恢复结果。');
  return { mergeEventId: Number(preview.mergeEventId), expectedUpdatedAt: preview.expectedUpdatedAt };
}
