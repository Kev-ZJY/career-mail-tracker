# Career Mail Tracker（求职邮件追踪器）

一个**本地优先**的求职邮件追踪工具：从你的 QQ / 网易邮箱收件箱里读取招聘邮件，自动识别「投递确认 / 测评 / 面试 / Offer / 流程结束」等进度信号，把同一家公司同一个岗位的多封邮件聚合成**一行一个申请**，帮你把求职季的申请进度看成一盘棋，而不是收件箱里的一堆散邮件。

数据全部保存在本机 SQLite，不经过任何第三方服务器；只有「邮件内容分析」这一步会调用你主动配置的云端模型（OpenRouter / DeepSeek / OpenAI 兼容接口，也可以接本地 Ollama）。

---

## 功能特性

### 核心：一行一申请
- 同一「公司 + 岗位」的多封邮件自动聚合成**一个申请线程**，状态跟随最新邮件流转：已投递 → 测评中 → 面试 → Offer / 已结束
- 一封测评邮件覆盖同公司多个已投递岗位时，自动扇出更新所有相关线程
- 已被判定「已结束」的申请不会被晚到的非终态邮件「复活」
- 邮件原始正文保存在本地，任何一行都能点「查看邮件」回看原始信件

### 职位抽取（多级保障）
- 邮件正文用 `html-to-text` 显式配置提取，恢复多数解析器会丢失的 `contenteditable` 占位 span 里的职位名（腾讯 / 小红书 `js-position-name` 模板）
- 超长正文按「头 + 职位锚词行 + 尾」三区截断，中后段的职位不会被截丢
- 服务端确定性规则兜底：小红书式「投递成功 - 姓名 - 职位」主题、正文「面试岗位：【X】」「for the position of X」等锚点直接抽取，不依赖模型稳定性
- 流程词黑名单硬拦截：面试邀请 / 现场访客码 / 综合能力测试 / AI 编程考察等 30+ 词绝不会写进职位栏；无明确职位一律显示「未识别」

### 预筛选与防误入
- 招聘活动 / 宣讲会 / 挑战赛 / 推荐官 / 校招启动 / 岗位推荐等营销邮件在进模型前直接忽略，不进列表
- 满意度调研 / 面试体验问卷：正文未说明流程结束就不入列表（进行中的申请不会被体验问卷误标成已结束）；明确含「流程已结束 / 感谢你的关注」等结束信号的问卷正常归入已结束
- 公司名归一（如「快手科技 → 快手」），同一公司不会被拆成两行

### 同步
- QQ / 网易 IMAP：只读 `INBOX`，按日期闭区间搜索，按 Message-ID + 正文哈希 + 分析版本增量去重
- 凭据已配置时刷新页面自动增量同步；支持按月/自定义窗口手动同步、`dryRun` 干跑预览
- 邮箱连接可单独诊断，不返回授权码

### 界面
- 单屏 Dashboard：顶部进度总览、左侧申请进度表、右侧招聘日历，桌面一屏展示不滚动；窄屏自动堆叠
- 支持手动新增申请、编辑岗位/状态、删除（只删聚合行、保留邮件档案）

---

## 本地部署

### 环境要求
- Node.js **22.19+**（推荐 26，使用内置 `node:sqlite` / `node:test`，无构建步骤）
- 一个 QQ 或网易邮箱的 **IMAP 授权码**（不是登录密码）
- 一个模型供应商的 API Key（OpenRouter / DeepSeek 等，**必配**：所有邮件分析都由 LLM 完成，模型不可用时同步会直接报错，不会降级出低质量结果）

### 安装与启动

```bash
npm install
npm test          # 跑完整测试套件（120+ 用例）
npm run start     # 启动服务，监听 http://127.0.0.1:4317
```

浏览器打开 <http://127.0.0.1:4317>。

### 准备凭据（可选，自动装载）

把以下明文文件放进 `data/.secrets/`（该目录已被 `.gitignore` 排除，只在你本机）：

```text
data/.secrets/
  openrouter-api-key.txt     # OpenRouter API Key
  deepseek-api-key.txt       # DeepSeek API Key
  mailbox-email.txt          # 你的邮箱地址，如 your-email@163.com
  mailbox-netease-auth.txt   # 网易 IMAP 授权码（QQ 邮箱用 mailbox-qq-auth.txt）
```

服务启动时会自动装载凭据；**首次启动**默认使用 OpenRouter（缺失则 DeepSeek），此后以你在页面「设置」里的选择为准，重启不会切换。

### 环境变量

```bash
PORT=4317                    # 端口（默认 4317）
DATA_DIR=./data              # 数据目录（默认 ./data）
IMAP_163_HOST / IMAP_QQ_HOST        # 受限网络下的主机覆盖（白名单域或 IP，保留原域名做 SNI 校验）
IMAP_163_PORT / IMAP_163_SECURE     # 显式降级端口/明文（默认 993 + TLS）
IMAP_PROXY / HTTPS_PROXY            # 代理透传（如需走代理访问 IMAP）
```

> 提示：如果你在带 HTTP 代理的终端环境里跑服务，IMAP 会被代理干扰导致 TLS 断连，建议启动时清除代理变量：
> `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy npm run start`

---

## 使用说明

### 1. 配置模型
「设置 → 模型」选择供应商并填 API Key；或直接把 Key 放进 `data/.secrets/` 后重启。所有邮件分析都由模型完成：模型未配置时同步返回 `MODEL_UNAVAILABLE`（页面提示先配置 LLM），模型调用失败**不会降级**到规则兜底，宁可报错也不出低质量结果。

### 2. 配置邮箱
「设置 → 邮箱」选择 QQ / 网易，填邮箱地址 + IMAP 授权码，点「测试连接」验证；或把授权码放进 `data/.secrets/`。

### 3. 同步邮件
- 页面顶部选日期窗口（默认当年 1 月 1 日至今），点「**同步并分析**」
- 同步只走真实 IMAP；未配置模型/邮箱时点击同步会得到对应的配置引导提示
- 刷新页面且凭据已配置时会自动增量同步上次成功同步日至今的邮件
- **不设同步数量上限**：日期窗口内全部邮件都会拉取分析（大窗口下耗时主要在逐封模型分析，请耐心等待）；也可通过接口 `maxMessages` 参数手动限制（此时保留窗口内**最新**的 N 封）

### 4. 阅读与管理
- 左表每行是一个申请：公司 / 职位 / 状态 / 时间 / 备注
- 「**查看邮件 ↗**」打开原始邮件弹窗（沙箱 iframe，禁脚本）
- 「**编辑**」修正公司、职位、状态、时间（真实落库）
- 勾选行后可批量删除（只删聚合行，邮件档案保留，重同步可重建）
- 手动记录：列表下方可新增一个不在邮件里的申请（灰色「手动记录」标识）

### 5. 数据与备份
- 所有数据在 `data/tracker.sqlite`（SQLite 单文件），备份它即可
- 状态历史、原始邮件正文都在库内；清空数据库后重新同步即可重建

---

## 工作原理（简述）

```text
IMAP 拉取 → html-to-text 提取正文
  → triage 预筛选（营销/活动/问卷直接忽略，不入库）
  → 模型分析（company/position/status/threadRef，失败重试 1 次）
  → 确定性规则归一（公司名、职位锚点兜底、黑名单）
  → 线程归属校验（防幻觉：岗位不在原文即剥离并标人工复核）
  → 写入 application_threads（一行一申请）+ 回填邮件档案
```

关键设计：
- **不回退原则**：模型未配置或调用失败时同步直接报错，绝不退回规则分类器出低质量结果；确定性规则只做「模型结果的高置信修正」（公司归一、职位锚点兜底、黑名单），不做完整分类
- **线程防重复**：回填幂等 + (account, company, position) 唯一约束，多次重建不会累积重复行
- **防幻觉铁律**：邮件没写的岗位名绝不填；无岗位的邮件不会清空线程已确认的岗位

---

## 目录结构

```text
src/
  server.js                    HTTP 服务与静态资源
  api.js                       JSON API 与输入校验（含 CSRF 防护）
  config.js                    本地服务配置（含 ANALYSIS_VERSION）
  db.js                        SQLite schema 与仓储（邮件/线程/设置）
  errors.js                    结构化 API 错误
  domain/
    triage.js                  预筛选（营销/活动/问卷/进度信号识别）
    thread-resolver.js         线程归属判定（含防幻觉与已结束保护）
    normalize.js               公司名归一 + subject/正文职位确定性抽取
  mail/
    provider-registry.js       QQ/网易 IMAP 端点与安全白名单
  services/
    credential-store.js        进程内凭据存储
    credential-bootstrap.js    启动时从 data/.secrets/ 装载凭据（仅首次默认模型）
    settings-service.js        模型/邮箱配置脱敏
    mailbox-service.js         连接诊断与凭据边界
    imap-source.js             IMAP 拉取、MIME 解析、正文提取
    llm-service.js             模型路由（OpenAI 兼容/Ollama）+ 提示词
    sync-service.js            时间窗口、增量去重、线程写入
public/                        无构建 Web UI（原生 HTML/CSS/JS）
test/                          node:test 测试套件
scripts/                       pull-real-mails / classification-eval 等工具
data/                          运行数据（SQLite、.secrets、eval 缓存；仅存本地，不入库）
```

---

## 运行时 API（主要）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/settings/provider` | 保存模型供应商配置（Key 只进进程内存） |
| POST | `/api/settings/mailbox` | 保存邮箱与授权码引用 |
| POST | `/api/mailbox/test` | 测试 IMAP 连接（不返回授权码） |
| POST | `/api/sync/run` | 按日期同步真实邮箱；支持 `dryRun` / `maxMessages` / `auto` |
| GET | `/api/sync/runs` | 查看同步历史 |
| GET | `/api/dashboard` | 线程视图 + 状态统计 + 日历事件 |
| POST | `/api/progress/manual` | 手动新增申请 |
| PUT | `/api/progress/:id` | 编辑线程（公司/岗位/状态/时间） |
| POST | `/api/progress/delete` | 批量删除线程（保留邮件档案） |
| GET | `/api/progress/:id/email` | 读取原始邮件正文（查看邮件弹窗） |

---

## 隐私与安全

- 服务只监听 `127.0.0.1`，不对外暴露
- API Key / 邮箱授权码不写入 SQLite（只存引用），以明文文件保存在本地 `data/.secrets/`（git 已忽略）；如需更高安全可改用系统 Keychain（见「已知限制」）
- IMAP 默认 993 + TLS；授权码不明文过网
- 邮件正文 / HTML 仅存本机，附件不保存、不外传
- 云端模型调用完全可选，由你主动配置并为之付费/消耗额度

---

## 已知限制

- **无岗位的终态/问卷邮件**（如「邀请您填写面试反馈问卷」不带岗位名）在公司有多个进行中申请时无法自动归并到具体线程，会独立显示并标记待人工确认；可在页面「编辑」手动归并
- **免费模型偶发抖动**：同一封邮件的分析结果可能随调用波动，服务端确定性规则已覆盖大部分场景，但个别邮件仍可能出现「未识别职位」——可在页面直接编辑修正
- 线程只聚合展示**最新状态**；完整时间线请用「查看邮件」逐封回看
- 凭据以明文文件保存在 `data/.secrets/`，尚未接入 Keychain 加密

---

## 常见问题

**IMAP 同步报「Client network socket disconnected before secure TLS」？**
通常是邮箱对短时高频登录的临时限流，或终端代理环境干扰 IMAP。已查证的行为：163 邮箱限制的是**认证/连接频率**（约 ≤5 次连接/分钟正常，更高频率会延迟响应甚至封禁 IP 30-180 分钟），单连接内批量拉取不受影响——因此**大窗口一次拉完是安全的，短时间内反复重试才是雷**。等几分钟再试；启动时清除代理变量（见上文）；网易账号尤其注意。

**「查看邮件」打不开？**
先确认该线程对应邮件是否已入库（数据重建时正文可能需重新同步）。刷新页面或重新同步该窗口即可。

**为什么有些申请显示「未识别职位」？**
该邮件正文/主题确实没有可确认的岗位名（如测评入口邮件、投递确认模板），或模型抽取失败后由确定性规则置空待人工确认——这是设计行为，不是漏数据；可在页面手动编辑。

**想换分析模型？**
页面「设置」切换即可，选择会持久化，重启不会被覆盖；也可以把对应 Key 放进 `data/.secrets/` 后重启（仅在从未选择过模型时才会按 openrouter → deepseek 取默认值）。

**改动提示词后旧邮件不重新分析？**
分析版本号 `ANALYSIS_VERSION`（`src/config.js`）每次需手动 bump，否则存量邮件跳过重分析；`test/config.test.js` 的断言需同步更新。

---

## 开发与测试

```bash
npm test                  # node:test 全量（120+）
node --test test/<file>   # 单文件
npm run dev               # 改代码自动重启
```

> 说明：内部开发计划、验收真值表与基于真实邮件的标注数据集仅保存在本机（`docs/`、`data/`），不随仓库分发，以保护个人数据。
