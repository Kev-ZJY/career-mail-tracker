import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const schema = `
  PRAGMA journal_mode = WAL;

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
    source TEXT NOT NULL DEFAULT 'email',
    updated_at TEXT NOT NULL
  );

  -- 防重复线程：position 非空时同 (account, company, position) 只能一行。
  -- 空 position（未识别岗位）不约束——这类线程靠回填按组取最新 + findThreadByKey 合并。
  CREATE UNIQUE INDEX IF NOT EXISTS idx_application_threads_unique
    ON application_threads(account_id, company, position)
    WHERE position != '';

  CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    inserted_count INTEGER NOT NULL,
    analyzed_count INTEGER NOT NULL,
    skipped_count INTEGER NOT NULL,
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
  addColumn('sync_runs', 'source', "TEXT NOT NULL DEFAULT 'imap'");
  // Backfill application_threads from mail_messages (run once, marked by settings)
  // Skip for :memory: databases - tests will call backfillApplicationThreads explicitly
  if (filePath !== ':memory:') {
    runBackfillIfNeeded(db);
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

  return {
    findByKey(messageKey) {
      return findStatement.get(messageKey);
    },

    getEmailDetail(id) {
      return db.prepare('SELECT id FROM mail_messages WHERE id = ?').get(Number(id))
        ? getEmailDetailStatement.get(Number(id))
        : null;
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
        record.analysis.notes || record.analysis.evidence || null,
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
          record.analysis.notes || record.analysis.evidence || null,
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
        progress.notes || progress.evidence,
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
        progress.notes || progress.evidence || existing.notes || existing.evidence,
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
          analyzed_count, skipped_count, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.accountId,
        run.from,
        run.to,
        run.inserted,
        run.analyzed,
        run.skipped,
        run.source || 'imap',
        new Date().toISOString(),
      );
      return Number(result.lastInsertRowid);
    },

    listSyncRuns(limit = 50) {
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
      return db.prepare(`
        SELECT id, account_id AS accountId, from_date AS fromDate, to_date AS toDate,
          inserted_count AS inserted, analyzed_count AS analyzed, skipped_count AS skipped,
          source, created_at AS createdAt
        FROM sync_runs ORDER BY id DESC LIMIT ?
      `).all(safeLimit);
    },

    // Thread methods
    listThreads(filters = {}) {
      const clauses = ['1=1'];
      const params = [];
      if (filters.from) {
        clauses.push('latest_received_at >= ?');
        params.push(filters.from);
      }
      if (filters.to) {
        clauses.push('latest_received_at <= ?');
        params.push(filters.to);
      }
      if (filters.accountId) {
        clauses.push('account_id = ?');
        params.push(filters.accountId);
      }
      const where = `WHERE ${clauses.join(' AND ')}`;
      const rows = db.prepare(`
        SELECT id, account_id AS accountId, company, position, status, confidence, needs_review AS needsReview,
          evidence, next_action AS nextAction, notes, event_start AS eventStart, event_end AS eventEnd,
          latest_received_at AS latestReceivedAt, latest_message_id AS latestMessageId, source, updated_at AS updatedAt
        FROM application_threads ${where} ORDER BY latest_received_at DESC
      `).all(...params);
      return rows.map(r => ({ ...r, needsReview: Boolean(r.needsReview) }));
    },

    getCountsByThreads(filters = {}) {
      const clauses = ['1=1'];
      const params = [];
      if (filters.from) {
        clauses.push('latest_received_at >= ?');
        params.push(filters.from);
      }
      if (filters.to) {
        clauses.push('latest_received_at <= ?');
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
        WHERE account_id = ? AND TRIM(LOWER(company)) = TRIM(LOWER(?)) AND TRIM(LOWER(position)) = TRIM(LOWER(?))
        LIMIT 1
      `).get(accountId, company, position);
      return row ? row.id : null;
    },

    upsertThreadFromMessage({ threadId, accountId, company, position, status, confidence, needsReview,
      evidence, nextAction, notes, eventStart, eventEnd, receivedAt, messageId }) {
      const updatedAt = new Date().toISOString();
      let targetThreadId = threadId;

      if (!targetThreadId) {
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
        // Check if we should update (new message is newer or equal)
        const existing = db.prepare('SELECT latest_received_at, position FROM application_threads WHERE id = ?').get(targetThreadId);
        if (existing && existing.latest_received_at > receivedAt) {
          return targetThreadId; // Don't update, existing is newer
        }
        // 无岗位的后续邮件（反馈问卷/流程通知）不得清空线程已确认的岗位
        const resolvedPosition = position || existing?.position || '';
        db.prepare(`
          UPDATE application_threads SET
            company = ?, position = ?, status = ?, confidence = ?, needs_review = ?,
            evidence = ?, next_action = ?, notes = ?, event_start = ?, event_end = ?,
            latest_received_at = ?, latest_message_id = ?, updated_at = ?
          WHERE id = ?
        `).run(
          company, resolvedPosition, status, confidence, needsReview ? 1 : 0,
          evidence || '', nextAction || '', notes || null,
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
            evidence || '', nextAction || '', notes || null,
            eventStart || null, eventEnd || null,
            receivedAt, messageId || null, updatedAt
          );
        } catch (error) {
          const fallbackId = this.findThreadByKey(accountId, company, position || '');
          if (!fallbackId) throw error;
          db.prepare(`
            UPDATE application_threads SET
              company = ?, position = ?, status = ?, confidence = ?, needs_review = ?,
              evidence = ?, next_action = ?, notes = ?, event_start = ?, event_end = ?,
              latest_received_at = ?, latest_message_id = ?, updated_at = ?
            WHERE id = ?
          `).run(
            company, position || '', status, confidence, needsReview ? 1 : 0,
            evidence || '', nextAction || '', notes || null,
            eventStart || null, eventEnd || null,
            receivedAt, messageId || null, updatedAt, fallbackId
          );
          targetThreadId = fallbackId;
        }
        if (insertResult) targetThreadId = insertResult.lastInsertRowid;
      }
      return targetThreadId;
    },

    touchThreadStatus(threadId, { status, receivedAt, messageId, eventStart, eventEnd, notes }) {
      const updatedAt = new Date().toISOString();
      const existing = db.prepare('SELECT latest_received_at FROM application_threads WHERE id = ?').get(threadId);
      if (!existing) return false;
      if (existing.latest_received_at > receivedAt) return false;
      db.prepare(`
        UPDATE application_threads SET
          status = ?, event_start = ?, event_end = ?, notes = ?,
          latest_received_at = ?, latest_message_id = ?, updated_at = ?
        WHERE id = ?
      `).run(
        status, eventStart || null, eventEnd || null, notes || null,
        receivedAt, messageId || null, updatedAt, threadId
      );
      return true;
    },

    getThread(id) {
      const row = db.prepare(`
        SELECT id, account_id AS accountId, company, position, status, confidence, needs_review AS needsReview,
          evidence, next_action AS nextAction, notes, event_start AS eventStart, event_end AS eventEnd,
          latest_received_at AS latestReceivedAt, latest_message_id AS latestMessageId, source, updated_at AS updatedAt
        FROM application_threads WHERE id = ?
      `).get(Number(id));
      return row ? { ...row, needsReview: Boolean(row.needsReview) } : null;
    },

    updateThread(id, patch) {
      const allowed = ['company', 'position', 'status', 'confidence', 'needsReview', 'evidence', 'nextAction', 'notes', 'eventStart', 'eventEnd', 'source'];
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
      params.push(new Date().toISOString(), Number(id));
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
      const updatedAt = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO application_threads (account_id, company, position, status, confidence, needs_review,
          evidence, next_action, notes, event_start, event_end, latest_received_at, latest_message_id, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 'manual', ?)
      `).run(
        'manual', progress.company, progress.position, progress.status,
        progress.confidence ?? 1, 0,
        progress.evidence, progress.nextAction, progress.notes || null,
        progress.eventStart ? new Date(progress.eventStart).toISOString() : null,
        progress.eventEnd ? new Date(progress.eventEnd).toISOString() : null,
        new Date(progress.receivedAt || progress.eventStart).toISOString(),
        updatedAt
      );
      return this.getThread(result.lastInsertRowid);
    },
  };
}
