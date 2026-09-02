const STATUS_ORDER = ['已结束', '测评中', 'Offer', '面试', '已投递'];

function positionInEmail(position, { subject = '', text = '' } = {}) {
  if (!position) return false;
  const combined = `${subject}\n${text}`;
  const normPos = position.trim().toLowerCase();
  const normCombined = combined.toLowerCase();
  // Check if position words appear in email (simple substring after removing common suffixes)
  const base = normPos.replace(/(工程师|开发|岗位|职位|实习生|专家|资深|高级|初级|中级|lead|leader|manager|总监|架构师)$/i, '').trim();
  if (!base) return false;
  return normCombined.includes(base);
}

function threadStatusPriority(status) {
  return STATUS_ORDER.indexOf(status);
}

function isEnded(status) {
  return status === '已结束';
}

function sameCompany(a, b) {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

export function resolveThreadPlacement({ threads = [], analysis = {}, message = {} }) {
  const { company, position, status, threadRef, appliesTo = [] } = analysis;
  const sanitized = { ...analysis };
  let needsReview = Boolean(analysis.needsReview);

  // 1. Anti-hallucination: if position is provided but not found in email, strip it
  if (sanitized.position && !positionInEmail(sanitized.position, message)) {
    sanitized.position = '';
    needsReview = true;
  }

  // 2. Resolve target thread(s)
  let mainThreadId = null;
  let fanoutIds = [];
  let created = false;

  // Build a map of active (non-ended) threads by (company, position) for this account
  // Note: threads are already filtered to the same account in the caller
  const activeThreads = threads.filter(t => !isEnded(t.status));

  // Helper: find thread by exact (company, position) match
  function findExact(company, position) {
    return activeThreads.find(t =>
      sameCompany(t.company, company) &&
      (t.position || '').trim().toLowerCase() === (position || '').trim().toLowerCase()
    );
  }

  // Helper: find thread by company only (when position is empty)
  function findByCompanyOnly(company) {
    return activeThreads.find(t => sameCompany(t.company, company));
  }

  // Case A: threadRef is a number (existing thread ID)
  if (typeof threadRef === 'number' && Number.isFinite(threadRef)) {
    const target = threads.find(t => t.id === threadRef);
    if (target && sameCompany(target.company, company) && !isEnded(target.status)) {
      mainThreadId = target.id;
      // Allow position drift only if email explicitly mentions the new position
      if (sanitized.position && sanitized.position !== target.position) {
        if (!positionInEmail(sanitized.position, message)) {
          sanitized.position = target.position;
        }
      }
    } else {
      // threadRef points to different company or ended thread -> treat as new
      mainThreadId = null;
      created = true;
      needsReview = true;
    }
  }
  // Case B: threadRef === 'new' or not provided -> find or create
  else {
    // Try exact match first
    let target = findExact(company, sanitized.position);
    if (target) {
      mainThreadId = target.id;
    } else if (!sanitized.position) {
      // No position in analysis, try company-only match (drift onto only active thread)
      const companyThreads = activeThreads.filter(t => sameCompany(t.company, company));
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

  // 3. Handle appliesTo fanout (assessments covering multiple positions)
  if (Array.isArray(appliesTo) && appliesTo.length > 0) {
    for (const refId of appliesTo) {
      const refThread = threads.find(t => t.id === refId);
      if (refThread && sameCompany(refThread.company, company) && !isEnded(refThread.status)) {
        fanoutIds.push(refThread.id);
      }
    }
    // If we have fanout but no main thread, pick the first fanout as main
    if (!mainThreadId && fanoutIds.length > 0) {
      mainThreadId = fanoutIds[0];
    }
  }

  // 4. If creating new thread and position was stripped, mark needsReview
  if (created && !sanitized.position) {
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