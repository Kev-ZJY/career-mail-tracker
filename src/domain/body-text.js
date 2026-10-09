// 送给模型的正文清洗。
//
// 为什么需要：招聘邮件常内嵌 base64 二维码/签名图，html-to-text 会把它们当正文存进
// body_text。实测一封面试通知 18018 字里 15615 字是 base64（86.7%），而岗位名就在
// 正文第一行。模型要逐 token 读完这些二进制噪音才会碰到岗位，思考被撑爆、
// max_tokens 打满、content 为空、判定截断。
//
// 关键约束：本模块只用于**喂给模型的文本**，绝不参与 content_hash 计算。
// content_hash 由 sync-service 按 imap-source 的 clampText 结果计算，改动那里的
// 文本会让存量邮件下次同步被判定「正文已变」，走冲突分支复制出 |imap| 重复记录。

// data URI（data:image/jpeg;base64,...）与裸 base64 块。
//
// 裸 base64 的识别不能只看「长串字母数字」，否则会误伤 URL 查询参数
// （?token=aaaa...&session=bbbb...）、长英文单词、hex 校验码。判据是
// **长度 + 字符多样性**：
//   - 长度 ≥ 800：真实内嵌图片编码量级是几百 KB 起；正常 URL 参数串极少超过几百字符。
//   - 去重后不同字符数 ≥ 20：标准 base64 编码的字节分布会用到 40+ 种字符
//     （实测真实 JPEG base64 有 44 种），而重复字符、hex 串、单字符 URL 参数
//     通常只有个位数（实测 URL 参数串仅 4 种，hex 串恰好 16 种）。
// 注意 '=' 是 base64 的填充符，必须计入字符集，否则长编码会因中间的 '='
// 被切断匹配。真实 JPEG 编码几乎不产生 '+'，所以不能拿 '+' 当判据。
const DATA_URI_RE = /data:[\w.+-]+\/[\w.+-]+;\s*base64,[A-Za-z0-9+/=\s]{200,}/g;
const BARE_BASE64_RE = /[A-Za-z0-9+/=]{800,}/g;
const MIN_BASE64_LENGTH = 800;
// 20 而非 16：hex 串恰好只有 16 种字符（0-9a-f），卡在 16 会把 md5/hash 误判成图片。
// 真实 base64 实测 40+ 种（样本 44），20 留出了充足余量。
const MIN_BASE64_DISTINCT_CHARS = 20;

/**
 * 判断一段长字符串是否真的是 base64 载荷（而非 URL 参数 / hex / 重复填充）。
 * @param {string} run 候选串
 * @returns {boolean}
 */
function looksLikeBase64(run) {
  if (run.length < MIN_BASE64_LENGTH) return false;
  // 去掉尾部填充符再算多样性
  const distinct = new Set(run.replace(/=+$/, '')).size;
  return distinct >= MIN_BASE64_DISTINCT_CHARS;
}

/**
 * 剥掉内嵌图片的 base64 载荷，保留可读的占位标记。
 * 连续多个 base64 块（如二维码 + 签名图）折叠成一个标记，避免占位符本身刷屏。
 * @param {unknown} value 原始正文
 * @returns {string} 清洗后的正文
 */
export function stripEmbeddedImages(value) {
  const text = String(value || '');
  if (!text) return '';
  const stripped = text
    .replace(DATA_URI_RE, '[图片]')
    .replace(BARE_BASE64_RE, (run) => (looksLikeBase64(run) ? '[图片]' : run))
    // 折叠相邻占位符，并清掉占位符周围被 base64 带出来的多余空白
    .replace(/(?:\[图片\]\s*){2,}/g, '[图片]\n')
    .replace(/[ \t]{2,}/g, ' ');
  return stripped;
}

/**
 * 清洗 + 截断，供模型输入使用。
 * 顺序很重要：先剥 base64 再截断，否则垃圾内容会先占满额度，
 * 真正含岗位信息的正文反而被切掉（这正是超长邮件丢岗位的原因）。
 * @param {unknown} value 原始正文
 * @param {number} maxChars 截断上限
 * @returns {string}
 */
export function prepareBodyText(value, maxChars) {
  const cleaned = stripEmbeddedImages(value);
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 24_000;
  return cleaned.length <= limit ? cleaned : cleaned.slice(0, limit);
}
