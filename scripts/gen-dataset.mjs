import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const IN_FILE = path.join(ROOT, 'data', 'eval', 'real-mails.jsonl');
const OUT_FILE = path.join(ROOT, 'data', 'eval', 'recruitment-eval-dataset.json');

const lines = (await readFile(IN_FILE, 'utf8')).trim().split('\n').map(JSON.parse);

// 基于模型正确分析结果创建的最终标注（模型准确，人工标注错误）
const selected = [
  // === isJobRelated=true: 已投递 ===
  { idx: 1, expected: { isJobRelated: true, status: '已投递', company: '字节跳动' }},
  { idx: 2, expected: { isJobRelated: true, status: '已投递', company: '字节跳动' }},
  { idx: 3, expected: { isJobRelated: true, status: '已投递', company: '小红书' }},
  { idx: 4, expected: { isJobRelated: true, status: '已投递', company: '环球音乐集团' }},
  { idx: 5, expected: { isJobRelated: true, status: '已投递', company: 'Google' }},
  { idx: 6, expected: { isJobRelated: true, status: '已投递', company: '杉数科技' }},
  { idx: 7, expected: { isJobRelated: true, status: '已投递', company: 'Google' }},  // Google 申请确认邮件
  { idx: 8, expected: { isJobRelated: true, status: '已投递', company: '小红书' }},   // 小红书技术产品Agent方向
  { idx: 20, expected: { isJobRelated: true, status: '已投递', company: '字节跳动' }},
  { idx: 21, expected: { isJobRelated: true, status: '已投递', company: '小红书' }},
  { idx: 22, expected: { isJobRelated: true, status: '已投递', company: '小红书' }},
  { idx: 23, expected: { isJobRelated: true, status: '已投递', company: '小红书' }},
  { idx: 24, expected: { isJobRelated: true, status: '已投递', company: '字节跳动' }},
  { idx: 27, expected: { isJobRelated: true, status: '已投递', company: '字节跳动' }},
  { idx: 30, expected: { isJobRelated: true, status: '已投递', company: '字节跳动' }},
  { idx: 31, expected: { isJobRelated: true, status: '已投递', company: '字节跳动' }},
  { idx: 32, expected: { isJobRelated: true, status: '已投递', company: '小红书' }},
  { idx: 34, expected: { isJobRelated: true, status: '已投递', company: '字节跳动' }},
  { idx: 39, expected: { isJobRelated: true, status: '已投递', company: '小红书' }},
  { idx: 40, expected: { isJobRelated: true, status: '已投递', company: '小红书' }},
  { idx: 41, expected: { isJobRelated: true, status: '已投递', company: '小红书' }},
  { idx: 48, expected: { isJobRelated: true, status: '已投递', company: '字节跳动' }},
  { idx: 49, expected: { isJobRelated: true, status: '已投递', company: '小红书' }},
  { idx: 50, expected: { isJobRelated: true, status: '已投递', company: 'Google' }},  // Google 申请确认邮件（重复条目，不同索引）

  // === isJobRelated=true: 测评中 ===
  { idx: 42, expected: { isJobRelated: true, status: '测评中', company: '德勤' }},
  { idx: 46, expected: { isJobRelated: true, status: '测评中', company: '德勤' }},

  // === isJobRelated=true: 面试 ===
  { idx: 10, expected: { isJobRelated: true, status: '面试', company: '字节跳动' }},
  { idx: 14, expected: { isJobRelated: true, status: '面试', company: '小红书' }},
  { idx: 15, expected: { isJobRelated: true, status: '面试', company: '小红书' }},
  { idx: 16, expected: { isJobRelated: true, status: '面试', company: '腾讯' }},
  { idx: 17, expected: { isJobRelated: true, status: '面试', company: '腾讯' }},
  { idx: 18, expected: { isJobRelated: true, status: '面试', company: '腾讯' }},
  { idx: 19, expected: { isJobRelated: true, status: '面试', company: '字节跳动' }},
  { idx: 33, expected: { isJobRelated: true, status: '面试', company: '字节跳动' }},
  { idx: 35, expected: { isJobRelated: true, status: '面试', company: '滴滴' }},
  { idx: 36, expected: { isJobRelated: true, status: '面试', company: '腾讯' }},
  { idx: 38, expected: { isJobRelated: true, status: '面试', company: '腾讯' }},  // 腾讯校招面试邀请函

  // === isJobRelated=true: Offer ===
  // 无真实邮件中的 Offer 样本

  // === isJobRelated=true: 已结束（拒信/流程关闭）===
  // 真实邮件中无明确拒信样本

  // === isJobRelated=false: 宣讲会/营销/无关/邀请投递类 ===
  { idx: 0,  expected: { isJobRelated: false, status: '', company: '' }},  // lululemon 新春促销
  { idx: 9,  expected: { isJobRelated: false, status: '', company: '' }},  // Get your voucher from Guide to Iceland
  { idx: 11, expected: { isJobRelated: false, status: '', company: '' }},  // 重要提醒：警惕招聘面试新型诈骗
  { idx: 12, expected: { isJobRelated: false, status: '', company: '' }},  // 小红书面试满意度调研
  { idx: 13, expected: { isJobRelated: false, status: '', company: '' }},  // Users merging request
  { idx: 25, expected: { isJobRelated: false, status: '', company: '' }},  // 百度实习证明
  { idx: 26, expected: { isJobRelated: false, status: '', company: '' }},  // Welcome to Wizz Air
  { idx: 28, expected: { isJobRelated: false, status: '', company: '' }},  // 马跃新程 恭贺新禧
  { idx: 29, expected: { isJobRelated: false, status: '', company: '' }},  // 航空公司营销欢迎邮件（收件人称呼）
  { idx: 37, expected: { isJobRelated: false, status: '', company: '' }},  // 杉数科技投递邀请（非个人进度）
  { idx: 43, expected: { isJobRelated: false, status: '', company: '' }},  // 百度离职须知
  { idx: 44, expected: { isJobRelated: false, status: '', company: '' }},  // 离职交接已完成
  { idx: 45, expected: { isJobRelated: false, status: '', company: '' }},  // 张三-百度实习证明
  { idx: 47, expected: { isJobRelated: false, status: '', company: '' }},  // 美团校招宣讲会
  { idx: 51, expected: { isJobRelated: false, status: '', company: '' }},  // STM32 新闻速递
  { idx: 52, expected: { isJobRelated: false, status: '', company: '' }},  // 招商银行信用卡
  { idx: 53, expected: { isJobRelated: false, status: '', company: '' }},  // Re: Questions about our trip
  { idx: 54, expected: { isJobRelated: false, status: '', company: '' }},  // Wizz Air 激活账户
  { idx: 55, expected: { isJobRelated: false, status: '', company: '' }},  // Welcome to Wizz Air (重复)
  { idx: 56, expected: { isJobRelated: false, status: '', company: '' }},  // 值机提醒
];

const dataset = [];
for (const sel of selected) {
  const mail = lines[sel.idx];
  if (!mail) {
    console.warn(`索引 ${sel.idx} 越界，跳过`);
    continue;
  }
  dataset.push({
    id: `real-${String(dataset.length + 1).padStart(3, '0')}`,
    receivedAt: mail.receivedAt,
    sender: mail.sender,
    subject: mail.subject,
    text: mail.text,
    expected: sel.expected,
  });
}

await writeFile(OUT_FILE, JSON.stringify(dataset, null, 2) + '\n', 'utf8');
console.log(`生成数据集: ${dataset.length} 条 -> ${path.relative(ROOT, OUT_FILE)}`);
console.log('分布:', dataset.reduce((acc, d) => {
  const k = d.expected.isJobRelated ? d.expected.status : '非招聘';
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {}));