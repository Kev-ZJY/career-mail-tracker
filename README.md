# 求职邮件追踪看板

本地招聘进度控制台：从 QQ / 网易收件箱提取本人申请进度，按公司与岗位归并，显示申请列表和测评 / 面试日历。当前采用固定工作流，解析阶段显示为「Agent解析」；模型只处理当前邮件，申请归并在本地完成。

## 启动

需要 Node.js 22.19+、邮箱 IMAP 授权码，以及 OpenAI 兼容模型端点。

```bash
npm install
npm start
```

打开 <http://127.0.0.1:4317>。开发时可用 `npm run dev`；测试用 `npm test`。

## 配置与使用

1. 在「设置 → 模型供应商」选择供应商，填写接口地址、模型名称和 API key，保存后点击「测试已保存模型」。地址可以填 API 根路径或完整 `/chat/completions` 地址。测试只发送连通性请求，不发送邮件，会消耗供应商调用额度。
2. 在「邮箱连接」保存 QQ / 网易邮箱地址与 IMAP 授权码，点击「测试已保存邮箱」。授权码不是邮箱登录密码。
3. 选择日期窗口，点击「同步并分析」。当前邮箱下方显示蓝色状态与进度条；申请结果逐封写入并刷新。同步时该按钮变为红色「取消同步」。取消或超时后保留已写入记录，下次同步重试未完成邮件。
4. 点击「查看邮件」读取本地邮件历史；用「编辑」修正申请。「手动添加进展」可选择新增独立申请或更新已有申请。公司、岗位输入框提供已有名称建议，最多显示三条，更多可滚动；列表岗位与备注最多显示两行，悬停可查看完整文字。
5. 同一申请被拆成多行时，勾选后点击「合并申请」，选择保留目标并核对完整进展历史。所有相关邮件一起归入目标，保留合并前的申请分组。编辑时选择另一条「更新对象」也会进入合并预览；仅改名称不会自动合并或新增进展。
6. 每行的「进展历史」统一展示邮件进展和无邮件的「手动记录」。拆分时一次勾选多条进展、填写新公司与岗位，预览双方的状态、日期和邮件后确认；所选进展的全部邮件一起移动。也可按合并前分组选择，或用「恢复合并前申请」恢复最近一次完整合并。已有内容移出或旧日志缺少分组信息时，完整恢复不可用，可继续按当前历史拆分。
7. 编辑状态、时间或备注是修正已有进展：邮件修正跟随该邮件移动，真实手动记录直接更新原条目。只有「手动添加进展」新增无邮件的招聘进展。列表按真实进展的邮件收件时间或手动录入时间排序，事件日期用于日历；改名、合并与拆分不制造新进展。删除申请行保留邮件档案，重新同步可重建。

API key / 授权码留空会保留当前凭据。模型选择与连接参数存入 SQLite，密钥只在当前进程内存；重启后须重新输入，或配置下面的本地凭据文件。

可选启动凭据位于 `data/.secrets/`（已被 Git 忽略）：

```text
openrouter-api-key.txt
deepseek-api-key.txt
mailbox-email.txt
mailbox-netease-auth.txt    # QQ 使用 mailbox-qq-auth.txt
```

首次默认选择已配置的 OpenRouter，其次 DeepSeek；已有模型选择不会被启动逻辑替换。不要同时配置两个邮箱服务商的授权码文件。

## 工作流

```text
IMAP 连接 / 全窗口 UID 搜索
→ 跳过已完成 UID，仅读取新增或待重试邮件正文
→ 代码预筛选与内容去重
→ Agent 连通性确认（存在待分析邮件时）
→ 受控并发分析当前邮件
→ JSON 校验、字段归一、本地申请归并
→ 按邮件时间逐封落库
→ 进度流驱动申请列表和日历刷新
```

详细阶段、时间预算和失败处理见 [工作流说明](docs/workflow.md)。当前先读完本轮待处理正文，再开始模型分析，以维持时间排序。分析和落库逐封推进。同一窗口再次同步仍会搜索 UID，但已完成邮件不再读取正文或调用模型；旧数据首次升级需要读取一次以建立 UID 完成记录。

模型只接收当前候选邮件的发件人、主题、接收时间和正文。历史申请与公司别名用于本地归并；没有模型可用时直接报错，不通过规则伪造分析结果。原文没有岗位就保持空值，人工修改优先于后续分析。

## 公司别名

可将 `config/rules.example.toml` 复制为 `data/rules.toml`，填写同一法人主体的名称映射：

```toml
[company_aliases]
"Example Technology" = "示例科技"
```

执行 `npm run check:aliases` 校验。法定后缀会自动剥离，归一后相同的别名键只写一条，歧义规则不会生效。集团与独立子公司不要合并。变更别名后的存量重分析：

```bash
node scripts/reanalyze.mjs --dry-run
node scripts/reanalyze.mjs --apply
```

`--apply` 会调用已配置模型并更新数据库。提示词语义变更时须更新 `src/config.js` 的分析版本，以触发旧邮件重新分析。

## 运行配置

| 配置 | 用途 |
|---|---|
| `PORT` / `DATA_DIR` / `RULES_FILE` | 默认端口 4317、数据目录 `./data`、规则文件 `data/rules.toml` |
| `SYNC_CONCURRENCY` | 默认 4，最大 16 |
| `SYNC_*_TIMEOUT_MS` | 阶段预算，见工作流说明 |
| `IMAP_163_HOST` / `IMAP_QQ_HOST` | 白名单主机或 IP 覆盖；保留原域名进行 TLS 身份校验 |
| `IMAP_163_PORT` / `IMAP_163_SECURE` | 网易端口 / TLS 覆盖，默认 993 / TLS |
| `IMAP_PROXY` / 系统代理变量 | IMAP 代理；连接诊断与同步采用相同参数 |

若代理干扰 IMAP，可清除代理变量后启动：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy npm start
```

## 数据与接口

服务仅监听 `127.0.0.1`。原始邮件、申请、设置、UID 完成记录、同步历史位于 `data/tracker.sqlite`；停止服务后备份数据库。附件不保存。候选邮件正文会发送给用户选定的模型供应商分析；本地 Ollama 则使用所配置的本地端点。

| 方法 / 路径 | 用途 |
|---|---|
| `GET /api/settings` | 脱敏配置与实际启用供应商 |
| `POST /api/settings/provider` / `/api/settings/mailbox` | 保存配置 |
| `POST /api/model/test` / `/api/mailbox/test` | 测试已保存的连接 |
| `POST /api/sync/run` | 同步；`stream:true` 返回 NDJSON，支持 `dryRun` / `maxMessages` / `auto` |
| `GET /api/sync/runs` / `/api/dashboard` | 同步历史 / 申请与日历数据 |
| `POST /api/progress/manual` / `PUT /api/progress/:id` | 新增无邮件进展 / 修正已有申请；POST 可指定已有 `threadId` |
| `POST /api/progress/delete` | 删除申请行，保留邮件 |
| `GET /api/progress/:id/emails` | 申请关联的原始邮件历史 |
| `GET /api/progress/:id/manual-history` | 兼容接口，仅返回真实无邮件的手动记录；前端使用统一进展历史 |
| `GET /api/progress/merge-preview` / `POST /api/progress/merge-preview` | 预览合并后的申请、完整进展历史、邮件数量及版本 |
| `POST /api/progress/merge` | 选择目标与源申请合并；页面提交预览版本，过期则返回 409 |
| `GET /api/progress/:id/structure` | 统一进展历史、关联邮件、合并前分组及完整恢复可用性 |
| `POST /api/progress/:id/split-preview` | 预览原申请与新申请各自的状态、日期、进展及邮件 |
| `POST /api/progress/:id/split` | 移动所选真实进展及其邮件，原申请至少保留一条进展 |
| `POST /api/progress/:id/restore-preview` / `/api/progress/:id/restore` | 预览 / 恢复最近一次完整合并的原申请分组 |

`structure` 返回 `thread`、`history`、`groups`、`restore`。每条 `history` 包含稳定的 `id`、`kind`（`email` / `manual`）、进展字段、`messageIds` 和邮件摘要；技术操作日志不进入历史。拆分提交 `historyIds`、`company`、`position`、`expectedUpdatedAt`，预览返回 `original` 与 `newApplication`；状态和日期由各自历史推导。恢复预览提交 `mergeEventId`，确认时加上预览的 `expectedUpdatedAt`。

`src/api.js` 负责接口与同步请求生命周期；`src/services/` 负责配置、连接、LLM 与同步；`src/domain/` 负责预筛选、归一和申请归并；`public/` 是无构建的原生 HTML / CSS / JS 前端。

## 故障处理与边界

- 404：检查接口根路径、模型 ID 和供应商的可用端点。保存成功不代表模型可用，先运行模型测试。
- 401 / 403 / 402：检查密钥、访问权限或账户额度；429 限流会停止派发新请求。已发出的成功结果保留，未完成邮件下次重试。
- 原文无岗位、同公司存在多份申请、岗位名称变化时，归并可能需要人工修正；模型解析不保证每封正确。
- 大窗口的读取阶段也受整轮时间预算限制；若读取即超时，缩小日期窗口。刷新页面会在凭据齐全时自动增量同步。

仓库只分发通用源码、虚构测试样例和工作流说明。真实邮件、凭据、申请数据、个人规则和本地验收材料不随仓库分发。
