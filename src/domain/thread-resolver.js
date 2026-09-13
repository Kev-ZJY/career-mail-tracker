import { companyComparisonKey } from './company-resolver.js';

const STATUS_ORDER = ['已结束', '测评中', 'Offer', '面试', '已投递'];
const RECENT_POSITION_INHERITANCE_MS = 30 * 24 * 60 * 60 * 1000;

function threadStatusPriority(status) {
  return STATUS_ORDER.indexOf(status);
}

function isEnded(status) {
  return status === '已结束';
}

function sameCompany(a, b) {
  const left = companyComparisonKey(a);
  const right = companyComparisonKey(b);
  return Boolean(left) && left === right;
}

function samePosition(a, b) {
  const key = (value) => String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  const left = key(a);
  const right = key(b);
  return Boolean(left) && left === right;
}

function isRecentThread(thread, message) {
  const threadTime = Date.parse(thread?.latestReceivedAt || thread?.latest_received_at || '');
  const messageTime = Date.parse(message?.receivedAt || '');
  // 兼容不携带时间的调用方/旧测试；生产仓库返回的线程始终带 latestReceivedAt。
  if (!Number.isFinite(threadTime) || !Number.isFinite(messageTime)) return true;
  const age = messageTime - threadTime;
  return age >= 0 && age <= RECENT_POSITION_INHERITANCE_MS;
}

export function resolveThreadPlacement({ threads = [], analysis = {}, message = {} }) {
  const { company, position, status, threadRef, appliesTo = [] } = analysis;
  const sanitized = { ...analysis };
  let needsReview = Boolean(analysis.needsReview);

  // Position semantics were already decided by the model. Thread placement must not
  // re-run a brittle substring validator that rejects legitimate shortened names.
  let mainThreadId = null;
  let fanoutIds = [];
  let created = false;

  // Build a map of active (non-ended) threads by (company, position) for this account
  // Note: threads are already filtered to the same account in the caller
  const activeThreads = threads.filter(t => !isEnded(t.status));
  const unknownPositionThread = !sanitized.position
    ? activeThreads
      .filter(t => sameCompany(t.company, company) && !t.position)
      .sort((a, b) => a.id - b.id)[0]
    : null;
  const referencedThread = Number.isInteger(threadRef)
    ? activeThreads.find(t => t.id === threadRef && sameCompany(t.company, company))
    : null;

  // Helper: find thread by exact (company, position) match
  function findExact(company, position) {
    return activeThreads.find(t =>
      sameCompany(t.company, company) &&
      samePosition(t.position, position) &&
      (position || isRecentThread(t, message))
    );
  }

  function findEndedExact(company, position) {
    return threads.find(t =>
      isEnded(t.status) &&
      sameCompany(t.company, company) &&
      samePosition(t.position, position)
    );
  }

  // Positionless mail shares one unknown-position application per company.
  // A follow-up explicitly linked to a named application keeps that route;
  // a submitted receipt never inherits a named position from a model hint.
  if (unknownPositionThread && (status === '已投递' || !referencedThread?.position)) {
    mainThreadId = unknownPositionThread.id;
  }
  // Case A: threadRef is a number (existing thread ID)
  else if (typeof threadRef === 'number' && Number.isFinite(threadRef)) {
    const target = threads.find(t => t.id === threadRef);
    const companyMatches = target && sameCompany(target.company, company);
    const positionMatches = !sanitized.position || !target?.position || samePosition(target.position, sanitized.position);
    const mayInheritTargetPosition = !sanitized.position
      && status !== '已投递'
      && isRecentThread(target, message);
    if (target && companyMatches && !isEnded(target.status) && positionMatches
      && (sanitized.position || mayInheritTargetPosition)) {
      mainThreadId = target.id;
      if (!sanitized.position && !position && target.position) sanitized.position = target.position;
    } else {
      // A bad model reference must never rewrite another company/application.
      // Treat it as an unusable hint and apply the same conservative invariants:
      // exact company+position, or one recent same-company route for a follow-up.
      let fallback = sanitized.position ? findExact(company, sanitized.position) : null;
      if (!fallback && isEnded(status) && sanitized.position) {
        fallback = findEndedExact(company, sanitized.position);
      }
      if (!fallback && !sanitized.position) {
        const companyThreads = activeThreads.filter(t =>
          sameCompany(t.company, company)
          && isRecentThread(t, message)
          && (status !== '已投递' || !t.position)
        );
        if (companyThreads.length === 1) fallback = companyThreads[0];
      }
      if (fallback) {
        mainThreadId = fallback.id;
        if (!sanitized.position && fallback.position) sanitized.position = fallback.position;
      } else {
        mainThreadId = null;
        created = true;
        if (!sanitized.position) needsReview = true;
      }
    }
  }
  // Case B: validate the model's "new" suggestion against stable application
  // invariants. Exact active applications merge; a positionless progress event
  // may inherit only when the company has one recent active route.
  else if (threadRef === 'new') {
    let target = sanitized.position ? findExact(company, sanitized.position) : null;
    if (!target && isEnded(status) && sanitized.position) {
      target = findEndedExact(company, sanitized.position);
    }
    if (!target && !sanitized.position) {
      const companyThreads = activeThreads.filter(t =>
        sameCompany(t.company, company)
        && isRecentThread(t, message)
        && (status !== '已投递' || !t.position)
      );
      if (companyThreads.length === 1) target = companyThreads[0];
    }
    if (target) {
      mainThreadId = target.id;
      if (!sanitized.position && target.position) sanitized.position = target.position;
    } else {
      created = true;
    }
  }
  // Case C: no usable threadRef -> use deterministic company/position fallback.
  else {
    // Try exact match first
    let target = findExact(company, sanitized.position);
    if (!target && isEnded(status) && sanitized.position) {
      target = findEndedExact(company, sanitized.position);
    }
    if (target) {
      mainThreadId = target.id;
    } else if (!sanitized.position) {
      // No position in analysis, try company-only match (drift onto only active thread)
      const companyThreads = activeThreads.filter(t => sameCompany(t.company, company) && isRecentThread(t, message));
      if (companyThreads.length === 1) {
        mainThreadId = companyThreads[0].id;
        sanitized.position = companyThreads[0].position;
      } else {
        created = true;
      }
    } else {
      created = true;
    }
  }

  // 2. Handle appliesTo fanout (assessments covering multiple positions)
  if ((Array.isArray(appliesTo) && appliesTo.length > 0) || (status === '测评中' && analysis.appliesToAll === true)) {
    for (const refId of Array.isArray(appliesTo) ? appliesTo : []) {
      const refThread = threads.find(t => t.id === refId);
      if (refThread && sameCompany(refThread.company, company) && !isEnded(refThread.status)) {
        fanoutIds.push(refThread.id);
      }
    }
    if (status === '测评中' && analysis.appliesToAll === true) {
      fanoutIds.push(...activeThreads.filter(t => sameCompany(t.company, company)).map(t => t.id));
    }
    // If we have fanout but no main thread, pick the first fanout as main
    if (!mainThreadId && fanoutIds.length > 0) {
      mainThreadId = fanoutIds[0];
      created = false;
    }
  }

  // 3. An application with no recognized position remains reviewable after merging.
  if (!sanitized.position) {
    needsReview = true;
  }

  sanitized.needsReview = needsReview;

  return {
    mainThreadId,
    fanoutIds: [...new Set(fanoutIds)],
    created,
    sanitizedAnalysis: sanitized,
  };
}
