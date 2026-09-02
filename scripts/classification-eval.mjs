#!/usr/bin/env node
// 分类质量评测：读取 data/eval/recruitment-eval-dataset.json，逐封调用 OpenRouter
// （system = EXTRACTION_PROMPT，user 消息格式与 llm-service.js 的 classify() 一致），
// 对比 expected 与 actual 的 isJobRelated / status / company，输出报告 JSON。
// 使用 curl 子进程绕过 Node.js fetch 的代理问题
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRACTION_PROMPT } from '../src/services/llm-service.js';
import { spawn } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const DATASET_FILE = path.join(ROOT, 'data', 'eval', 'recruitment-eval-dataset.json');
const KEY_FILE = path.join(ROOT, 'data', '.secrets', 'openrouter-api-key.txt');
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'stealth/ox-alpha';
const REQUEST_INTERVAL_MS = 800;
const MAX_RETRIES = 2;
const MAX_TEXT = 24_000;

function receivedAtContext(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '未知（请不要自行推断年份）';
  const beijing = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(new Date(value));
  return `${value}；北京时间：${beijing}`;
}

function buildUserMessage(item) {
  return `邮件接收时间 receivedAt：${receivedAtContext(item.receivedAt)}\n发件人：${String(item.sender || '').slice(0, 1_000)}\n主题：${String(item.subject || '').slice(0, 2_000)}\n正文：${String(item.text || '').slice(0, MAX_TEXT)}`;
}

function parseModelJson(raw) {
  const text = String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model response is not JSON');
  return JSON.parse(text.slice(start, end + 1));
}

async function callModelWithCurl(apiKey, item) {
  const systemPrompt = EXTRACTION_PROMPT;
  const userMessage = buildUserMessage(item);
  const payload = JSON.stringify({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const result = await new Promise((resolve, reject) => {
        const curl = spawn('curl', [
          '-sS', '-X', 'POST', ENDPOINT,
          '-H', 'Content-Type: application/json',
          '-H', 'Authorization: Bearer ' + apiKey,
          '-d', payload,
          '--max-time', '120'
        ]);

        let out = '';
        let err = '';
        curl.stdout.on('data', d => out += d);
        curl.stderr.on('data', d => err += d);
        curl.on('close', code => {
          if (code !== 0) {
            reject(new Error(`curl exited with code ${code}: ${err.slice(0, 500)}`));
            return;
          }
          resolve(out);
        });
        curl.on('error', reject);
      });

      const response = JSON.parse(result);
      if (response.error) {
        throw new Error(`API error: ${JSON.stringify(response.error)}`);
      }
      const content = response?.choices?.[0]?.message?.content ?? response?.choices?.[0]?.message?.reasoning_content ?? '';
      return parseModelJson(content);
    } catch (error) {
      lastError = error;
      console.error(`[${item.id}] 第 ${attempt + 1} 次调用失败：${String(error?.message || error)}`);
      if (attempt < MAX_RETRIES) await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
  }
  throw lastError;
}

function normalizeActual(actual) {
  return {
    isJobRelated: actual.isJobRelated === true,
    status: typeof actual.status === 'string' ? actual.status : '',
    company: typeof actual.company === 'string' ? actual.company.trim() : '',
    confidence: Number.isFinite(Number(actual.confidence)) ? Number(actual.confidence) : null,
    evidence: typeof actual.evidence === 'string' ? actual.evidence : '',
    needsReview: Boolean(actual.needsReview),
  };
}

function judge(expected, actualNormalized) {
  const problems = [];
  if (actualNormalized.isJobRelated !== expected.isJobRelated) {
    problems.push(`isJobRelated 期望 ${expected.isJobRelated}，实际 ${actualNormalized.isJobRelated}`);
  }
  if (expected.isJobRelated && !['已投递', '测评中', '面试', 'Offer', '已结束'].includes(actualNormalized.status)) {
    problems.push(`status 非法：${actualNormalized.status}`);
  }
  if (expected.isJobRelated && actualNormalized.status !== expected.status) {
    problems.push(`status 期望「${expected.status}」，实际「${actualNormalized.status}」`);
  }
  if (!expected.isJobRelated && actualNormalized.status && !['已投递', '测评中', '面试', 'Offer', '已结束'].includes(actualNormalized.status)) {
    problems.push(`status 非法：${actualNormalized.status}`);
  }
  if (expected.company && !actualNormalized.company.includes(expected.company)) {
    problems.push(`company 未包含期望值「${expected.company}」（实际「${actualNormalized.company}”）`);
  }
  return problems;
}

async function main() {
  const round = process.argv[2] || '1';
  const apiKey = (await readFile(KEY_FILE, 'utf8')).trim();
  if (!apiKey) throw new Error('openrouter api key is empty');
  const dataset = JSON.parse(await readFile(DATASET_FILE, 'utf8'));

  const results = [];
  let passCount = 0;
  for (const [index, item] of dataset.entries()) {
    const actualRaw = await callModelWithCurl(apiKey, item);
    const actual = normalizeActual(actualRaw);
    const problems = judge(item.expected, actual);
    const pass = problems.length === 0;
    if (pass) passCount += 1;
    results.push({
      id: item.id,
      subject: item.subject,
      expected: item.expected,
      actual,
      rawNotes: typeof actualRaw.notes === 'string' ? actualRaw.notes.slice(0, 300) : '',
      pass,
      problems,
    });
    console.error(`[${index + 1}/${dataset.length}] ${item.id} ${pass ? 'PASS' : `FAIL：${problems.join('；')}`}`);
    if (index < dataset.length - 1) await new Promise((resolve) => setTimeout(resolve, REQUEST_INTERVAL_MS));
  }

  const report = {
    round,
    promptVersion: round === 'baseline' ? 'phase-2-prompt' : `round-${round}`,
    model: MODEL,
    endpoint: ENDPOINT,
    pass: passCount,
    total: dataset.length,
    generatedAt: new Date().toISOString(),
    results,
  };
  const outFile = path.join(ROOT, 'data', 'eval', `report-round-${round}.json`);
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ round, pass: passCount, total: dataset.length, outFile: path.relative(ROOT, outFile) }, null, 2));
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exitCode = 1;
});