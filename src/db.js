import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createApplicationStructureMethods, migrateApplicationStructure } from './services/application-structure.js';

// Sort/filter by the latest actual progress update, independently of an interview's appointment date.
const progressTimeSql = (prefix = '') => `MAX(${prefix}latest_received_at, COALESCE(${prefix}manual_updated_at, ${prefix}latest_received_at))`;

const schema = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS mail_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_key TEXT NOT NULL UNIQUE,
    message_id TEXT,
    account_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    folder TEXT NOT NULL,
    received_at TEXT NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    analysis_version TEXT NOT NULL,
    is_job_related INTEGER NOT NULL,
    company TEXT,
    position TEXT,
    status TEXT NOT NULL,
    confidence REAL NOT NULL,
    evidence TEXT NOT NULL,
    next_action TEXT NOT NULL,
    needs_review INTEGER NOT NULL,
    analyzed_at TEXT NOT NULL,
    event_start TEXT,
    event_end TEXT,
    notes TEXT,
    web_url TEXT,
    source TEXT NOT NULL DEFAULT 'email'
  );

  CREATE INDEX IF NOT EXISTS idx_mail_messages_received_at
    ON mail_messages(received_at);

  CREATE TABLE IF NOT EXISTS imap_completion_receipts (
    account_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    mailbox_email TEXT NOT NULL,
    folder TEXT NOT NULL,
    uid_validity TEXT NOT NULL,
    uid TEXT NOT NULL,
    completion_version TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('analyzed', 'ignored', 'outside-range')),
    received_at TEXT NOT NULL,
    message_id INTEGER,
    content_hash TEXT,
    completed_at TEXT NOT NULL,
    PRIMARY KEY(account_id, provider, mailbox_email, folder, uid_validity, uid),
    FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS application_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    company TEXT NOT NULL,
    position TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    needs_review INTEGER NOT NULL DEFAULT 0,
    evidence TEXT NOT NULL DEFAULT '',
    next_action TEXT NOT NULL DEFAULT '',
    notes TEXT,
    event_start TEXT,
    event_end TEXT,
    latest_received_at TEXT NOT NULL,
    latest_message_id INTEGER,
    manual_position_override INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'email',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS manual_progress_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    company TEXT NOT NULL,
    position TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    event_start TEXT,
    event_end TEXT,
    notes TEXT,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES application_threads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS application_thread_messages (
    thread_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, message_id),
    FOREIGN KEY (thread_id) REFERENCES application_threads(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_application_thread_messages_message
    ON application_thread_messages(message_id);

  CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    inserted_count INTEGER NOT NULL,
    analyzed_count INTEGER NOT NULL,
    skipped_count INTEGER NOT NULL,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    ignored_count INTEGER NOT NULL DEFAULT 0,
    model_failed_count INTEGER NOT NULL DEFAULT 0,
    failure_details TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'imap',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function migrateLegacyStatuses(db) {
  db.prepare(`
    UPDATE mail_messages
    SET status = '已结束'
    WHERE status = '拒绝'
  `).run();
  db.prepare(`
    UPDATE mail_messages
    SET status = '已投递'
    WHERE status = '筛选中'
  `).run();
  db.prepare(`
    UPDATE mail_messages
    SET status = '已结束', is_job_related = 0, needs_review = 1,
      next_action = '不写入招聘进度列表'
    WHERE status = '待确认'
  `).run();
}

export function createDatabase(filePath) {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec(schema);
  const columns = db.prepare('PRAGMA table_info(mail_messages)').all();
  const addColumn = (table, name, definition) => {
    const tableColumns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!tableColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  if (!columns.some((column) => column.name === 'source')) addColumn('mail_messages', 'source', "TEXT NOT NULL DEFAULT 'email'");
  addColumn('mail_messages', 'message_id', 'TEXT');
  addColumn('mail_messages', 'event_start', 'TEXT');
  addColumn('mail_messages', 'event_end', 'TEXT');
  addColumn('mail_messages', 'notes', 'TEXT');
  addColumn('mail_messages', 'web_url', 'TEXT');
  addColumn('mail_messages', 'body_text', 'TEXT');
  addColumn('mail_messages', 'body_html', 'TEXT');
  addColumn('application_threads', 'manual_position_override', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('application_threads', 'manual_updated_at', 'TEXT');
  addColumn('application_threads', 'merged_into_thread_id', 'INTEGER');
  const structureChanges = migrateApplicationStructure(db);
  db.exec(`
    BEGIN IMMEDIATE;
    DROP INDEX IF EXISTS idx_application_threads_unique;
    CREATE UNIQUE INDEX idx_application_threads_unique
      ON application_threads(account_id, company, position)
      WHERE position != '' AND status != '已结束' AND merged_into_thread_id IS NULL AND manual_separate = 0;
    INSERT INTO manual_progress_events (thread_id, company, position, status, event_start, event_end, notes, recorded_at)
      SELECT id, company, position, status, event_start, event_end, notes, updated_at
      FROM application_threads WHERE source = 'manual' AND manual_updated_at IS NULL;
    UPDATE application_threads SET latest_received_at = updated_at, manual_updated_at = updated_at
      WHERE source = 'manual' AND manual_updated_at IS NULL;
    COMMIT;
  `);
  addColumn('sync_runs', 'source', "TEXT NOT NULL DEFAULT 'imap'");
  addColumn('sync_runs', 'candidate_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('sync_runs', 'ignored_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('sync_runs', 'model_failed_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('sync_runs', 'failure_details', "TEXT NOT NULL DEFAULT '[]'");
  // Historical runs did not record these values. Leave them unknown instead of
  // claiming that old runs processed zero mail or had no deferred work.
  addColumn('sync_runs', 'total_count', 'INTEGER');
  addColumn('sync_runs', 'processed_count', 'INTEGER');
  addColumn('sync_runs', 'remaining_count', 'INTEGER');
  addColumn('sync_runs', 'stop_reason', 'TEXT');
  addColumn('sync_runs', 'retry_from', 'TEXT');
  addColumn('sync_runs', 'source_searched_count', 'INTEGER');
  addColumn('sync_runs', 'source_cached_count', 'INTEGER');
  addColumn('sync_runs', 'source_fetched_count', 'INTEGER');
  addColumn('sync_runs', 'source_deferred_count', 'INTEGER');
  // Backfill application_threads from mail_messages (run once, marked by settings)
  // Skip for :memory: databases - tests will call backfillApplicationThreads explicitly
  if (filePath !== ':memory:') {
    runBackfillIfNeeded(db);
  }
  if (structureChanges?.length) {
    const repository = createMessageRepository(db);
    for (const id of new Set(structureChanges)) {
      const thread = repository.getThread(id);
      if (thread && !thread.mergedIntoThreadId && repository.getThreadStructure(id).history.length) {
        repository.refreshThreadFromHistory(id);
      }
    }
  }
  return {
    db,
    close: () => db.close(),
  };
}

export function runBackfillIfNeeded(db) {
  const backfillMark = db.prepare('SELECT value FROM settings WHERE key = ?').get('threads.backfill.v1');
  if (!backfillMark) {
    // 幂等：先清空旧的 email 线程再全量重建，防止删标记后多次回填累积重复行。
    // 手动线程（source='manual'）不受影响。
    db.exec(`DELETE FROM application_threads WHERE source != 'manual'`);
    // 每组 (account_id, company, position) 只取最新一条邮件建线程：
    // 用 ROW_NUMBER 而非 MAX(received_at) JOIN，避免同组两封邮件时间戳完全相同时插入重复行
    db.exec(`
      INSERT INTO application_threads (account_id, company, position, status, confidence, needs_review,
        evidence, next_action, notes, event_start, event_end, latest_received_at, latest_message_id, source, updated_at)
      SELECT account_id, company, position, status, confidence, needs_review,
        evidence, next_action, notes, event_start, event_end, received_at, id, source, analyzed_at
      FROM (
        SELECT m.*, ROW_NUMBER() OVER (
          PARTITION BY m.account_id, COALESCE(m.company,'未识别公司'), COALESCE(m.position,'')
          ORDER BY m.received_at DESC, m.id DESC
        ) AS rn
        FROM mail_messages m
        WHERE m.is_job_related = 1
      ) ranked
      WHERE ranked.rn = 1;
    `);
    // 孤立空岗位线程清理：同 (account, company) 已存在带岗位的线程时，
    // 删除空岗位线程（如 6/23 面试确认「产品策划」后 6/25 的无岗位反馈问卷
    // 建出的「未识别·已结束」行），避免岗位信息在邮件序列中被孤立丢失。
    db.exec(`
      DELETE FROM application_threads
      WHERE position = ''
        AND source != 'manual'
        AND EXISTS (
          SELECT 1 FROM application_threads o
          WHERE o.account_id = application_threads.account_id
            AND o.company = application_threads.company
            AND o.position != ''
        );
    `);
    db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').run('threads.backfill.v1', 'done');
  }
  // 老库没有显式邮件历史，只能可靠回填每条线程当前指向的最新邮件。
  db.exec(`
    INSERT OR IGNORE INTO application_thread_messages(thread_id, message_id, linked_at)
    SELECT id, latest_message_id, COALESCE(updated_at, latest_received_at)
    FROM application_threads
    WHERE latest_message_id IS NOT NULL AND merged_into_thread_id IS NULL
      AND EXISTS (SELECT 1 FROM mail_messages m WHERE m.id = application_threads.latest_message_id);
  `);
}

export function createMessageRepository(db) {
  migrateLegacyStatuses(db);
  const findStatement = db.prepare(`
    SELECT * FROM mail_messages WHERE message_key = ?
  `);
  const insertStatement = db.prepare(`
    INSERT INTO mail_messages (
      message_key, message_id, account_id, provider, folder, received_at, sender, subject,
      content_hash, analysis_version, is_job_related, company, position, status,
      confidence, evidence, next_action, needs_review, analyzed_at,
      event_start, event_end, notes, web_url, body_text, body_html
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStatement = db.prepare(`
    UPDATE mail_messages SET
      message_id = ?, account_id = ?, provider = ?, folder = ?, received_at = ?, sender = ?, subject = ?,
      content_hash = ?, analysis_version = ?, is_job_related = ?, company = ?, position = ?,
      status = ?, confidence = ?, evidence = ?, next_action = ?, needs_review = ?, analyzed_at = ?,
      event_start = ?, event_end = ?, notes = ?, web_url = ?, body_text = ?, body_html = ?
    WHERE message_key = ?
  `);
  const getByIdStatement = db.prepare(`
    SELECT id, message_key AS messageKey, message_id AS messageId, account_id AS accountId, provider, folder,
      received_at AS receivedAt, sender, subject, is_job_related AS isJobRelated,
      company, position, status, confidence, evidence, next_action AS nextAction,
      needs_review AS needsReview, analyzed_at AS analyzedAt,
      event_start AS eventStart, event_end AS eventEnd, notes, web_url AS webUrl, source
    FROM mail_messages WHERE id = ?
  `);
  const getEmailDetailStatement = db.prepare(`
    SELECT id, provider, received_at AS receivedAt, sender, subject, web_url AS webUrl,
      body_text AS bodyText, body_html AS bodyHtml
    FROM mail_messages WHERE id = ?
  `);
  const manualInsertStatement = db.prepare(`
    INSERT INTO mail_messages (
      message_key, message_id, account_id, provider, folder, received_at, sender, subject,
      content_hash, analysis_version, is_job_related, company, position, status,
      confidence, evidence, next_action, needs_review, analyzed_at,
      event_start, event_end, notes, web_url, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function mapRow(row) {
    return row ? {
      ...row,
      isJobRelated: Boolean(row.isJobRelated),
      needsReview: Boolean(row.needsReview),
    } : null;
  }

  function buildDateFilter(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.jobRelatedOnly !== false) {
      clauses.push('is_job_related = 1');
    }
    if (filters.from) {
      clauses.push('received_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('received_at <= ?');
      params.push(filters.to);
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }
  // A fresh link also changes a merge/split preview, even when the mail itself is older.
  function nextThreadUpdate(id) {
    const previous = db.prepare('SELECT updated_at FROM application_threads WHERE id=?').get(id)?.updated_at;
    return new Date(Math.max(Date.now(), (Date.parse(previous) || 0) + 1)).toISOString();
  }

  return {
    ...createApplicationStructureMethods(db),
    findByKey(messageKey) {
      return findStatement.get(messageKey);
    },

    isAnalysisComplete(record) {
      return !record.is_job_related || Boolean(db.prepare(
        'SELECT 1 FROM application_thread_messages WHERE message_id = ? LIMIT 1'
      ).get(record.id));
    },

    getCompletedImapUids(scope, { from, to }) {
      if (!scope) return new Set();
      const rows = db.prepare(`
        SELECT receipt.uid
        FROM imap_completion_receipts receipt
        LEFT JOIN mail_messages message ON message.id = receipt.message_id
        WHERE receipt.account_id = ? AND receipt.provider = ? AND receipt.mailbox_email = ?
          AND receipt.folder = ? AND receipt.uid_validity = ? AND receipt.completion_version = ?
          AND (
            receipt.outcome = 'ignored'
            OR (receipt.outcome = 'outside-range' AND (receipt.received_at < ? OR receipt.received_at > ?))
            OR (receipt.outcome = 'analyzed' AND message.analysis_version = ?
              AND message.content_hash = receipt.content_hash
              AND (message.is_job_related = 0 OR EXISTS (
                SELECT 1 FROM application_thread_messages link WHERE link.message_id = message.id
              )))
          )
      `).all(scope.accountId, scope.provider, scope.mailboxEmail, scope.folder, scope.uidValidity,
        scope.completionVersion, from, to, scope.analysisVersion);
      return new Set(rows.map((row) => row.uid));
    },

    saveImapCompletion({ identity, outcome, receivedAt, messageKey, contentHash }) {
      if (!identity) return;
      const message = messageKey ? findStatement.get(messageKey) : null;
      if (outcome === 'analyzed' && (!message || message.content_hash !== contentHash
        || message.analysis_version !== identity.analysisVersion || !this.isAnalysisComplete(message))) return;
      db.prepare(`
        INSERT INTO imap_completion_receipts (
          account_id, provider, mailbox_email, folder, uid_validity, uid,
          completion_version, outcome, received_at, message_id, content_hash, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, provider, mailbox_email, folder, uid_validity, uid) DO UPDATE SET
          completion_version = excluded.completion_version, outcome = excluded.outcome,
          received_at = excluded.received_at, message_id = excluded.message_id,
          content_hash = excluded.content_hash, completed_at = excluded.completed_at
      `).run(identity.accountId, identity.provider, identity.mailboxEmail, identity.folder,
        identity.uidValidity, identity.uid, identity.completionVersion, outcome,
        new Date(receivedAt).toISOString(), message?.id ?? null, contentHash ?? null, new Date().toISOString());
    },

    getEmailDetail(id) {
      return db.prepare('SELECT id FROM mail_messages WHERE id = ?').get(Number(id))
        ? getEmailDetailStatement.get(Number(id))
        : null;
    },

    listThreadMessages(threadId) {
      return db.prepare(`
        SELECT m.id, m.provider, m.received_at AS receivedAt, m.sender, m.subject,
          m.web_url AS webUrl, m.body_text AS bodyText, m.body_html AS bodyHtml
        FROM application_thread_messages link
        JOIN mail_messages m ON m.id = link.message_id
        WHERE link.thread_id = ?
        ORDER BY m.received_at DESC, m.id DESC
      `).all(Number(threadId));
    },

    linkMessageToThread(threadId, messageId, linkedAt = new Date().toISOString()) {
      if (!Number.isInteger(Number(threadId)) || !Number.isInteger(Number(messageId))) return false;
      const target = this.getThread(threadId);
      if (!target || target.mergedIntoThreadId) return false;
      const result = db.prepare(`
        INSERT OR IGNORE INTO application_thread_messages(thread_id, message_id, linked_at)
        VALUES (?, ?, ?)
      `).run(Number(threadId), Number(messageId), linkedAt);
      if (result.changes) db.prepare('UPDATE application_threads SET updated_at=? WHERE id=?').run(nextThreadUpdate(Number(threadId)),Number(threadId));
      return Number(result.changes) > 0;
    },

    unlinkMessageFromThreads(messageId) {
      const owners = db.prepare('SELECT thread_id AS id FROM application_thread_messages WHERE message_id=?').all(Number(messageId));
      const result = db.prepare(`
        DELETE FROM application_thread_messages WHERE message_id = ?
      `).run(Number(messageId));
      for (const row of owners) db.prepare('UPDATE application_threads SET updated_at=? WHERE id=?').run(nextThreadUpdate(row.id),row.id);
      return Number(result.changes);
    },

    findManualOverrideThreadForMessage(messageId) {
      const row = db.prepare(`
        SELECT t.id, t.account_id AS accountId, t.company, t.position, t.status,
          t.manual_position_override AS manualPositionOverride, t.manual_updated_at AS manualUpdatedAt
        FROM application_thread_messages link
        JOIN application_threads t ON t.id = link.thread_id
        WHERE link.message_id = ? AND t.merged_into_thread_id IS NULL
          AND (t.manual_position_override = 1 OR t.manual_updated_at IS NOT NULL)
        ORDER BY t.updated_at DESC, t.id DESC
        LIMIT 1
      `).get(Number(messageId));
      return row ? { ...row, manualPositionOverride: Boolean(row.manualPositionOverride) } : null;
    },

    deleteOrphanEmailThreads() {
      const result = db.prepare(`
        DELETE FROM application_threads
        WHERE source != 'manual'
          AND merged_into_thread_id IS NULL
          AND manual_updated_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM application_thread_messages link
            WHERE link.thread_id = application_threads.id
          )
      `).run();
      return Number(result.changes);
    },

    saveAnalysis(record, existing) {
      const values = [
        record.messageKey,
        record.messageId || null,
        record.accountId,
        record.provider,
        record.folder,
        record.receivedAt,
        record.sender,
        record.subject,
        record.contentHash,
        record.analysisVersion,
        record.analysis.isJobRelated ? 1 : 0,
        record.analysis.company,
        record.analysis.position,
        record.analysis.status,
        record.analysis.confidence,
        record.analysis.evidence,
        record.analysis.nextAction,
        record.analysis.needsReview ? 1 : 0,
        record.analyzedAt,
        record.analysis.eventStart || null,
        record.analysis.eventEnd || null,
        record.analysis.notes ?? null,
        record.webUrl || null,
        record.bodyText || null,
        record.bodyHtml || null,
      ];

      if (existing) {
        updateStatement.run(
          record.messageId || null,
          record.accountId,
          record.provider,
          record.folder,
          record.receivedAt,
          record.sender,
          record.subject,
          record.contentHash,
          record.analysisVersion,
          record.analysis.isJobRelated ? 1 : 0,
          record.analysis.company,
          record.analysis.position,
          record.analysis.status,
          record.analysis.confidence,
          record.analysis.evidence,
          record.analysis.nextAction,
          record.analysis.needsReview ? 1 : 0,
          record.analyzedAt,
          record.analysis.eventStart || null,
          record.analysis.eventEnd || null,
          record.analysis.notes ?? null,
          record.webUrl || null,
          // 正文是重拉成本高的原始档案：调用方未提供时保留库内旧值，避免误清
          record.bodyText ?? (existing.body_text || null),
          record.bodyHtml ?? (existing.body_html || null),
          record.messageKey,
        );
        return { id: Number(existing.id) };
      }
      const insertResult = insertStatement.run(...values);
      return { id: Number(insertResult.lastInsertRowid) };
    },

    listAnalyses(filters = {}) {
      const { where, params } = buildDateFilter(filters);
      const rows = db.prepare(`
        SELECT id, message_key AS messageKey, message_id AS messageId, account_id AS accountId, provider, folder,
          received_at AS receivedAt, sender, subject, is_job_related AS isJobRelated,
          company, position, status, confidence, evidence, next_action AS nextAction,
          needs_review AS needsReview, analyzed_at AS analyzedAt,
          event_start AS eventStart, event_end AS eventEnd, notes, web_url AS webUrl, source
        FROM mail_messages ${where} ORDER BY received_at DESC, id DESC
      `).all(...params);
      return rows.map(mapRow);
    },

    getCounts(filters = {}) {
      const { where, params } = buildDateFilter(filters);
      const rows = db.prepare(`
        SELECT status, COUNT(*) AS count FROM mail_messages ${where} GROUP BY status
      `).all(...params);
      return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    },

    addManualProgress(progress) {
      const messageKey = `manual|${randomUUID()}`;
      const receivedAt = new Date(progress.receivedAt || progress.eventStart).toISOString();
      const analyzedAt = new Date().toISOString();
      const result = manualInsertStatement.run(
        messageKey,
        null,
        'manual',
        'manual',
        'MANUAL',
        receivedAt,
        '本人手动记录',
        `${progress.company} · ${progress.position}`,
        `manual-${messageKey}`,
        'manual-v1',
        1,
        progress.company,
        progress.position,
        progress.status,
        progress.confidence ?? 1,
        progress.evidence,
        progress.nextAction,
        0,
        analyzedAt,
        progress.eventStart ? new Date(progress.eventStart).toISOString() : receivedAt,
        progress.eventEnd ? new Date(progress.eventEnd).toISOString() : null,
        progress.notes ?? null,
        progress.webUrl || null,
        'manual',
      );
      return mapRow(getByIdStatement.get(Number(result.lastInsertRowid)));
    },

    updateProgress(id, progress) {
      const existing = getByIdStatement.get(Number(id));
      if (!existing) return null;
      db.prepare(`
        UPDATE mail_messages SET company = ?, position = ?, status = ?,
          received_at = ?, event_start = ?, event_end = ?, notes = ?,
          evidence = ?, next_action = ?, needs_review = ? WHERE id = ?
      `).run(
        progress.company,
        progress.position,
        progress.status,
        new Date(progress.eventStart || progress.receivedAt || existing.receivedAt).toISOString(),
        progress.eventStart ? new Date(progress.eventStart).toISOString() : existing.eventStart,
        progress.eventEnd ? new Date(progress.eventEnd).toISOString() : null,
        progress.notes ?? existing.notes ?? null,
        progress.evidence || progress.notes || existing.evidence,
        progress.nextAction || existing.nextAction,
        progress.needsReview ? 1 : 0,
        Number(id),
      );
      return mapRow(getByIdStatement.get(Number(id)));
    },

    deleteByIds(ids) {
      if (!ids.length) return 0;
      const placeholders = ids.map(() => '?').join(', ');
      const result = db.prepare(`DELETE FROM mail_messages WHERE id IN (${placeholders})`).run(...ids);
      return Number(result.changes);
    },

    saveSetting(key, value) {
      db.prepare(`
        INSERT INTO settings(key, value) VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, JSON.stringify(value));
    },

    getSetting(key, fallback = null) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? JSON.parse(row.value) : fallback;
    },

    recordSyncRun(run) {
      const result = db.prepare(`
        INSERT INTO sync_runs(account_id, from_date, to_date, inserted_count,
          analyzed_count, skipped_count, candidate_count, ignored_count,
          model_failed_count, failure_details, source, created_at,
          total_count, processed_count, remaining_count, stop_reason, retry_from,
          source_searched_count, source_cached_count, source_fetched_count, source_deferred_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.accountId,
        run.from,
        run.to,
        run.inserted,
        run.analyzed,
        run.skipped,
        run.candidates || 0,
        run.ignored || 0,
        run.modelFailed || 0,
        JSON.stringify(run.failures || []),
        run.source || 'imap',
        new Date().toISOString(),
        run.total ?? null,
        run.processed ?? null,
        run.remaining ?? null,
        run.stopReason || null,
        run.retryFrom || null,
        run.sourceSearched ?? null,
        run.sourceCached ?? null,
        run.sourceFetched ?? null,
        run.sourceDeferred ?? null,
      );
      return Number(result.lastInsertRowid);
    },

    listSyncRuns(limit = 50) {
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
      return db.prepare(`
        SELECT id, account_id AS accountId, from_date AS fromDate, to_date AS toDate,
          inserted_count AS inserted, analyzed_count AS analyzed, skipped_count AS skipped,
          candidate_count AS candidates, ignored_count AS ignored,
          model_failed_count AS modelFailed, failure_details AS failureDetails,
          source, created_at AS createdAt,
          total_count AS total, processed_count AS processed, remaining_count AS remaining,
          stop_reason AS stopReason, retry_from AS retryFrom,
          source_searched_count AS sourceSearched, source_cached_count AS sourceCached,
          source_fetched_count AS sourceFetched, source_deferred_count AS sourceDeferred
        FROM sync_runs ORDER BY id DESC LIMIT ?
      `).all(safeLimit).map(({ failureDetails, ...run }) => {
        try {
          return { ...run, failures: JSON.parse(failureDetails || '[]') };
        } catch {
          return { ...run, failures: [] };
        }
      });
    },

    // Thread methods
    listThreads(filters = {}) {
      const clauses = ['t.merged_into_thread_id IS NULL'];
      const params = [];
      if (filters.from) {
        clauses.push(`${progressTimeSql('t.')} >= ?`);
        params.push(filters.from);
      }
      if (filters.to) {
        clauses.push(`${progressTimeSql('t.')} <= ?`);
        params.push(filters.to);
      }
      if (filters.accountId) {
        clauses.push('t.account_id = ?');
        params.push(filters.accountId);
      }
      const where = `WHERE ${clauses.join(' AND ')}`;
      const rows = db.prepare(`
        SELECT t.id, t.account_id AS accountId, t.company, t.position, t.status, t.confidence,
          t.needs_review AS needsReview, t.evidence, t.next_action AS nextAction, t.notes,
          t.event_start AS eventStart, t.event_end AS eventEnd,
          t.latest_received_at AS latestReceivedAt, t.latest_message_id AS latestMessageId,
          t.manual_position_override AS manualPositionOverride, t.source, t.updated_at AS updatedAt,
          t.manual_updated_at AS manualUpdatedAt, t.manual_separate AS manualSeparate, ${progressTimeSql('t.')} AS progressUpdatedAt,
          latest.sender AS latestSender
        FROM application_threads t
        LEFT JOIN mail_messages latest ON latest.id = t.latest_message_id
        ${where} ORDER BY ${progressTimeSql('t.')} DESC, t.id DESC
      `).all(...params);
      return rows.map(({ latestSender, ...r }) => ({
        ...r,
        ...(filters.routingSignals ? { latestSender: latestSender || '' } : {}),
        needsReview: Boolean(r.needsReview),
        manualPositionOverride: Boolean(r.manualPositionOverride),
        manualSeparate: Boolean(r.manualSeparate),
        originalApplications: this.getOriginalApplications(r.id),
      }));
    },

    getCountsByThreads(filters = {}) {
      const clauses = ['merged_into_thread_id IS NULL'];
      const params = [];
      if (filters.from) {
        clauses.push(`${progressTimeSql()} >= ?`);
        params.push(filters.from);
      }
      if (filters.to) {
        clauses.push(`${progressTimeSql()} <= ?`);
        params.push(filters.to);
      }
      if (filters.accountId) {
        clauses.push('account_id = ?');
        params.push(filters.accountId);
      }
      const where = `WHERE ${clauses.join(' AND ')}`;
      const rows = db.prepare(`
        SELECT status, COUNT(*) AS count FROM application_threads ${where} GROUP BY status
      `).all(...params);
      return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    },

    findThreadByKey(accountId, company, position) {
      const row = db.prepare(`
        SELECT id FROM application_threads
        WHERE account_id = ? AND merged_into_thread_id IS NULL
          AND TRIM(LOWER(company)) = TRIM(LOWER(?)) AND TRIM(LOWER(position)) = TRIM(LOWER(?))
        ORDER BY CASE WHEN status = '已结束' THEN 1 ELSE 0 END, manual_separate ASC, latest_received_at DESC, id DESC
        LIMIT 1
      `).get(accountId, company, position);
      return row ? row.id : null;
    },

    upsertThreadFromMessage({ threadId, accountId, company, position, status, confidence, needsReview,
      evidence, nextAction, notes, eventStart, eventEnd, receivedAt, messageId, forceNew = false }) {
      let updatedAt = new Date().toISOString();
      let targetThreadId = threadId;
      if (targetThreadId) {
        const target = this.getThread(targetThreadId);
        if (!target || target.mergedIntoThreadId) {
          throw Object.assign(new Error('申请已归并或不存在，请重新确认邮件归属'), { code: 'PROGRESS_STALE' });
        }
      }

      if (!targetThreadId && !forceNew) {
        targetThreadId = this.findThreadByKey(accountId, company, position || '');
        // 已结束线程不可被非终态邮件复活：resolver 判定归属失败后，
        // 按 (公司,岗位) 命中的已结束线程不能复用，必须另起一行交人工复核。
        // 终态 → 终态（如连续收到流程关闭通知）仍允许归入同一线程。
        if (targetThreadId) {
          const candidate = db.prepare('SELECT status FROM application_threads WHERE id = ?').get(targetThreadId);
          if (candidate?.status === '已结束' && status !== '已结束') targetThreadId = null;
        }
      }

      if (targetThreadId) {
        updatedAt = nextThreadUpdate(targetThreadId);
        // Check if we should update (new message is newer or equal)
        const existing = db.prepare(`
          SELECT latest_received_at, position, manual_position_override, manual_updated_at
          FROM application_threads WHERE id = ?
        `).get(targetThreadId);
        if (existing && (existing.latest_received_at > receivedAt || existing.manual_updated_at >= receivedAt)) {
          return targetThreadId; // Don't update, existing is newer
        }
        // 无岗位的后续邮件（反馈问卷/流程通知）不得清空线程已确认的岗位
        const resolvedPosition = existing?.manual_position_override
          ? existing.position
          : (position || existing?.position || '');
        db.prepare(`
          UPDATE application_threads SET
            company = ?, position = ?, status = ?, confidence = ?, needs_review = ?,
            evidence = ?, next_action = ?, notes = ?, event_start = ?, event_end = ?,
            latest_received_at = ?, latest_message_id = ?, updated_at = ?
          WHERE id = ?
        `).run(
          company, resolvedPosition, status, confidence, needsReview ? 1 : 0,
          evidence || '', nextAction || '', notes ?? null,
          eventStart || null, eventEnd || null,
          receivedAt, messageId || null, updatedAt, targetThreadId
        );
      } else {
        // 唯一索引（account, company, position 非空）保护：若并发/重复插入已存在同键线程，
        // 回退到 findThreadByKey 更新该行而非抛错。
        let insertResult;
        try {
          insertResult = db.prepare(`
            INSERT INTO application_threads (account_id, company, position, status, confidence, needs_review,
              evidence, next_action, notes, event_start, event_end, latest_received_at, latest_message_id, source, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'email', ?)
          `).run(
            accountId, company, position || '', status, confidence, needsReview ? 1 : 0,
            evidence || '', nextAction || '', notes ?? null,
            eventStart || null, eventEnd || null,
            receivedAt, messageId || null, updatedAt
          );
        } catch (error) {
          const fallbackId = this.findThreadByKey(accountId, company, position || '');
          if (!fallbackId) throw error;
          targetThreadId = this.upsertThreadFromMessage({ threadId: fallbackId, accountId, company, position, status,
            confidence, needsReview, evidence, nextAction, notes, eventStart, eventEnd, receivedAt, messageId });
        }
        if (insertResult) targetThreadId = insertResult.lastInsertRowid;
      }
      return targetThreadId;
    },

    touchThreadStatus(threadId, { status, receivedAt, messageId, eventStart, eventEnd, notes }) {
      const updatedAt = nextThreadUpdate(threadId);
      const existing = db.prepare('SELECT latest_received_at, manual_updated_at, merged_into_thread_id FROM application_threads WHERE id = ?').get(threadId);
      if (!existing || existing.merged_into_thread_id) return false;
      if (existing.latest_received_at > receivedAt || existing.manual_updated_at >= receivedAt) return false;
      db.prepare(`
        UPDATE application_threads SET
          status = ?, event_start = ?, event_end = ?, notes = ?,
          latest_received_at = ?, latest_message_id = ?, updated_at = ?
        WHERE id = ?
      `).run(
        status, eventStart || null, eventEnd || null, notes ?? null,
        receivedAt, messageId || null, updatedAt, threadId
      );
      return true;
    },

    getThread(id) {
      const row = db.prepare(`
        SELECT id, account_id AS accountId, company, position, status, confidence, needs_review AS needsReview,
          evidence, next_action AS nextAction, notes, event_start AS eventStart, event_end AS eventEnd,
          latest_received_at AS latestReceivedAt, latest_message_id AS latestMessageId,
          manual_position_override AS manualPositionOverride, source, updated_at AS updatedAt
          , manual_updated_at AS manualUpdatedAt, merged_into_thread_id AS mergedIntoThreadId, manual_separate AS manualSeparate,
          ${progressTimeSql()} AS progressUpdatedAt
        FROM application_threads WHERE id = ?
      `).get(Number(id));
      return row ? {
        ...row,
        needsReview: Boolean(row.needsReview),
        manualPositionOverride: Boolean(row.manualPositionOverride),
        manualSeparate: Boolean(row.manualSeparate),
      } : null;
    },

    updateThread(id, patch) {
      const allowed = ['company', 'position', 'status', 'confidence', 'needsReview', 'evidence', 'nextAction', 'notes', 'eventStart', 'eventEnd', 'manualPositionOverride', 'manualUpdatedAt', 'source'];
      const sets = [];
      const params = [];
      for (const [k, v] of Object.entries(patch)) {
        if (allowed.includes(k)) {
          const col = k.replace(/([A-Z])/g, '_$1').toLowerCase();
          sets.push(`${col} = ?`);
          params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
        }
      }
      if (!sets.length) return this.getThread(id);
      params.push(nextThreadUpdate(Number(id)), Number(id));
      db.prepare(`UPDATE application_threads SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...params);
      return this.getThread(id);
    },

    deleteThreadByIds(ids) {
      if (!ids.length) return 0;
      const placeholders = ids.map(() => '?').join(', ');
      const result = db.prepare(`DELETE FROM application_threads WHERE id IN (${placeholders})`).run(...ids);
      return Number(result.changes);
    },

    addManualThread(progress) {
      return this.applyManualProgress(progress);
    },

    applyManualProgress(progress) {
      if (progress.mergeFromId) return this.mergeThreads({ targetId: progress.threadId, sourceIds: [progress.mergeFromId], progress });
      const recordedAt = new Date(progress.receivedAt || Date.now()).toISOString();
      let threadId = progress.threadId;
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = threadId ? this.getThread(threadId) : null;
        if (threadId && (!existing || existing.mergedIntoThreadId)) throw new Error('所选申请不存在或已归入其他申请');
        const editing = progress.intent === 'edit' && Boolean(existing);
        const dateValue = value => value ? new Date(value).toISOString() : null;
        const eventStart = editing
          ? dateValue(progress.eventStart === undefined ? existing.eventStart : progress.eventStart)
          : dateValue(progress.eventStart || recordedAt);
        const eventEnd = dateValue(editing && progress.eventEnd === undefined ? existing.eventEnd : progress.eventEnd);
        const status = progress.status ?? existing?.status;
        const notes = editing && progress.notes === undefined ? existing.notes : progress.notes ?? null;
        const company = progress.company ?? existing?.company;
        const position = progress.position ?? existing?.position ?? '';
        const identity = { company, position,
          manualPositionOverride: Boolean(existing?.manualPositionOverride) || position !== existing?.position };
        const unchangedProgress = editing && status === existing.status
          && eventStart === dateValue(existing.eventStart) && eventEnd === dateValue(existing.eventEnd)
          && (notes || null) === (existing.notes || null);
        // Changing application identity does not create a recruitment event or advance its real date.
        if (unchangedProgress) {
          this.updateThread(threadId, { ...identity, confidence: 1, needsReview: false });
          this.confirmThreadMessageRoutes(threadId);
          db.exec('COMMIT');
          return this.getThread(threadId);
        }
        if (threadId) {
          this.updateThread(threadId, {
            ...identity, status,
            eventStart, eventEnd, notes, confidence: 1, needsReview: false,
            evidence: progress.evidence ?? existing.evidence, nextAction: progress.nextAction ?? existing.nextAction,
            ...(editing ? {} : { manualUpdatedAt: recordedAt }),
          });
        } else {
          const result = db.prepare(`
            INSERT INTO application_threads (account_id, company, position, status, confidence, needs_review,
              evidence, next_action, notes, event_start, event_end, latest_received_at, latest_message_id,
              source, updated_at, manual_updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, null, 'manual', ?, ?)
          `).run(progress.accountId || 'manual', company, position, status,
            progress.confidence ?? 1, progress.evidence || '', progress.nextAction || '', notes,
            eventStart, eventEnd, recordedAt, recordedAt, recordedAt);
          threadId = Number(result.lastInsertRowid);
        }
        if (editing) {
          const latest = this.getThreadStructure(threadId).history[0];
          if (latest?.kind === 'manual') {
            const eventId = Number(String(latest.id).split(':').at(-1));
            db.prepare(`UPDATE manual_progress_events SET company=?,position=?,status=?,event_start=?,event_end=?,notes=? WHERE id=? AND entry_kind='manual'`)
              .run(company,position,status,eventStart,eventEnd,notes,eventId);
          } else if (latest?.messageIds?.length) {
            const messageId = Number(latest.messageIds[0]);
            const previous = db.prepare(`SELECT id FROM manual_progress_events
              WHERE thread_id=? AND entry_kind='correction' AND message_id=? ORDER BY recorded_at DESC,id DESC LIMIT 1`)
              .get(threadId,messageId);
            if (previous) {
              db.prepare(`UPDATE manual_progress_events SET company=?,position=?,status=?,event_start=?,event_end=?,notes=?,recorded_at=? WHERE id=?`)
                .run(company,position,status,eventStart,eventEnd,notes,recordedAt,previous.id);
            } else {
              db.prepare(`INSERT INTO manual_progress_events(thread_id,company,position,status,event_start,event_end,notes,recorded_at,entry_kind,message_id)
                VALUES(?,?,?,?,?,?,?,?,'correction',?)`)
                .run(threadId,company,position,status,eventStart,eventEnd,notes,recordedAt,messageId);
            }
          } else {
            throw Object.assign(new Error('该申请没有可编辑的进展，请先添加进展记录'), { code: 'INVALID_PROGRESS' });
          }
        } else {
          db.prepare(`INSERT INTO manual_progress_events (thread_id,company,position,status,event_start,event_end,notes,recorded_at,entry_kind,message_id)
            VALUES (?,?,?,?,?,?,?,?,'manual',null)`).run(threadId,company,position,status,eventStart,eventEnd,notes,recordedAt);
        }
        this.confirmThreadMessageRoutes(threadId);
        this.refreshThreadFromHistory(threadId);
        db.exec('COMMIT');
        return this.getThread(threadId);
      } catch (error) {
        db.exec('ROLLBACK');
        if (error?.errcode === 2067) {
          const conflictId = this.findThreadByKey(progress.accountId || this.getThread(threadId)?.accountId, progress.company, progress.position);
          throw Object.assign(new Error('同公司同职位的申请已存在。请选择该申请作为更新对象，预览后确认合并；修改名称不会自动合并。'), { code: 'PROGRESS_CONFLICT', conflictingThreadId: conflictId });
        }
        throw error;
      }
    },

    listManualProgress(threadId) {
      return db.prepare(`SELECT id, thread_id AS threadId, company, position, status,
        event_start AS eventStart, event_end AS eventEnd, notes, recorded_at AS recordedAt
        FROM manual_progress_events WHERE thread_id=? AND entry_kind='manual' ORDER BY recorded_at DESC,id DESC`).all(Number(threadId));
    },
  };
}
