---
name: codefree-review-helper
description: 仅限 CodeFree 环境使用。把研发云 MR（合并请求）的变更 diff 切成有序的评审卡片组，用 codefree-review-helper CLI 完成 index → split → render → 评论回帖的本地评审全流程。当用户贴出研发云 MR 链接、给出 repoFullName + mergeId、或说"帮我 review/评审这个 MR"时使用。
metadata:
  version: "1.0.2"
---

# codefree-review-helper：研发云 MR 评审

> **环境限制：本 skill 仅可在 CodeFree 中使用。**
> 如果当前加载你的软件不是 CodeFree（例如 ClaudeCode、Cursor、Cline 等），你不能使用本 skill：直接告知用户"该 skill 仅支持 CodeFree 环境"并停止，不执行任何步骤。

你协助一位评审人把研发云 MR 的大 diff 切成一组有序的小卡片，交给 codefree-review-helper 渲染评审；评审提交后，把评论发回该 MR。你协助评审，**不代替评审**：只有 diff 能支撑的具体问题才可作为草稿评论（draftComments）。

## 0. 安全边界（最高优先级，先读这里）

- **写操作仅限用户在会话中明确指定的那个 MR**；只发评论，不创建/合并/关闭 MR，不推送或修改代码。
- 研发云仓库中默认**仅 `fzp-next` 可执行写操作**；对其他仓库发评论前，必须先获用户单次明确授权。
- **回帖前必须向用户简报**（见 §6.3）并等确认；无确认不发送。
- 单个失败步骤重试不超过 2 次；仍失败就停下，向用户说明失败步骤、错误信息和可选处理方式。
- 评审目录使用一次性工作目录（如 `mktemp -d`），不要污染用户仓库。

## 1. 输入识别

用户输入按以下优先级解析 MR 定位信息：

| 输入形态                                                       | 处理                                                                                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 研发云 MR 页面链接                                             | 匹配 `/code/<projId>/CodeMergeView/<mergeId>/`，提取 `mergeId`（projId 不需要），进入 §2                                                        |
| `mergeId`（纯数字或 "mergeId=123"）                            | 直接进入 §2（repoFullName 从 `get_mr_info` 返回中取）                                                                                           |
| 模糊描述（"帮我 review 最新的 MR"/"fzp-next 那个改登录的 MR"） | 注意：`merge_request_list` 的 status 参数只有 0/1/2，与 MR 实际状态枚举（如 7）可能失配而查不到；列出候选后让用户确认或让用户直接给链接/mergeId |

链接匹配不到 `CodeMergeView/<mergeId>` 时，请用户提供链接或 mergeId，不要猜测。

同时确认 CLI 运行方式（用户环境约定，未约定时先问）：

```bash
# 方式一
npx codefree-review-helper <subcommand>

# 方式二：本地调试可用。
# 本地构建需 build:cli（CLI 本体）+ build:web（render 的评审 UI，缺它 render 报
# "Web UI not built"）。一次性执行 npm run build 即含两者。
node <codefree-review-helper-dist>/codefree-review-helper.mjs <subcommand>
```

## 2. 定位 MR

1. 调 `get_mr_info(mergeId)` 校验存在性与访问权限，取标题、状态、源/目标分支。**注意**：`mergeRequestStatus` 的数值枚举与工具文档（0/1/2）实测不符（出现过 7），**不要按 0/1/2 硬解码**，向用户报告原始数值并建议以 MR 页面为准。
2. MR 不存在或无权限：明确报错并停止，不进入取 diff。
3. 向用户报告：MR 标题、状态（原始值）、源/目标分支、`repoFullName`（形如 `gsyw-fqzyjczxt/fzp-next`，注意 `projName` 是项目标识而非仓库名）。状态非开启时明确提醒（已合并/已关闭的 MR 仍可评审，但回帖可能受限）。

## 3. 获取并拼装 diff

**MCP 工具的返回是 Gerrit 风格结构化 JSON（`ab`/`a`/`b` 行数组 + `hunk` 行号），不是文本 diff**。LLM 直接转大 JSON 不可靠，必须用本 skill 附带的转换脚本。工作目录用一次性目录（如 `mktemp -d`）。

### 3.1 拉取变更文件列表并落盘

分页调 `merge_file_changes(mergeId, pageNum, pageSize)`（pageNum 从 1 起），**每页的完整 JSON 返回原样存为 `manifest-<pageNum>.json`**（不要手工摘抄字段——脚本要整体解析）。翻页直到取完全部文件；以页面返回的 `dataCount`/`dataList` 实际条数判断是否还有下一页，不得截断。

### 3.2 逐文件取 diff 并落盘

按 manifest 合并后的文件顺序（第 i 个文件，i 从 0 起），对每个变更文件调 `merge_file_diff(mergeId, fileName)`，**完整返回存为 `diffs/<i>.json`**。

- 若返回 `codeLineExceed: true`：该文件 diff 超限不完整，仍正常落盘（脚本会跳过它并在摘要中列出），最后明确告知用户这些文件需人工到 MR 页面评审。
- 空文件（`content: []`）正常落盘。

### 3.3 转换与对账

```bash
node <skill-dir>/scripts/to-diff.mjs <work-dir> -o review.diff
```

脚本做的事：合并 manifest 分页 → 尾部空串修正（研发云会把文件末尾换行塞成 `b`/`ab` 尾部 `""`）→ 顺序指针遍历生成带行号的 hunk → 按 diffType 补文件头外壳 → 与 `addLines`/`delLines` 对账。

- stdout 摘要 `match: true` 才算通过；`match: false` 时**不要手工修补 review.diff**，检查落盘 JSON 是否被截断/摘抄，重新完整落盘后重跑（≤2 次）；
- `skipped` 非空时在最终简报中列明跳过的文件。

### 3.4 索引校验

```bash
node <codefree-review-helper-dist>/codefree-review-helper.mjs index review.diff -o pr.index.txt
```

解析失败或 0 change：按 §3.3 的规则重试；diff 为空（MR 无变更）：明确报错并停止。

## 4. 索引与切分

1. 读 `pr.index.txt`：每行 `[编号] +/- L<行号>: <内容>`，按 `## 文件名` 分组。
2. 按 [references/split.md](references/split.md) 的规则生成 `split.json`（单 JSON 对象）：
   - 默认 `deps-first` 排序；用户指定 `tests/docs-first` 时遵循；
   - 每个编号恰好归入一组，连续编号用区间写法 `"0-23"`；
   - 每组 `description` 说明"这组为何在此、评审时看什么"；
   - `draftComments` 可选：仅限 diff 能支撑的具体问题，锚定同组内的一个 `change`；
   - `rewrites` 可选（实验特性）：组级 `[{ changes, title?, rewrite }]`，评审界面把被覆盖的变更行原位替换为等价且更聚焦的 Markdown 表达，代码始终一键可达。仅当用户要求 rewrites 时生成；用户自带 rewrite 提示词时优先遵循，否则按 [references/rewrite.md](references/rewrite.md) 的规范生成；
   - **输出语言**：`description`、`draftComments[].body` 与 `rewrites[].rewrite`/`title` 用简体中文（代码标识符、命令、API 名等专有名词保持原文）。

```json
{
  "groups": [
    {
      "description": "先加版本选择的基础数据，让后续升级流程有稳定输入",
      "changes": ["0-4"],
      "draftComments": [{ "change": 3, "body": "这个默认值会改变存量配置的行为，需要确认。" }]
    }
  ]
}
```

## 5. split 验证与 render

### 5.0 工作目录硬性约束（先于一切）

评审工作目录必须位于系统临时目录（PowerShell `$env:TEMP` / bash `mktemp -d` 产物），**禁止在用户仓库或项目目录内创建**——评审产物（diff/split/子补丁/submission.json）不得进入 git 跟踪范围。发现工作目录在仓库内时，先迁移到临时目录再继续。

### 5.1 split

```bash
node <codefree-review-helper-dist>/codefree-review-helper.mjs split review.diff split.json -o output/
```

`split` 自带组合验证（子 patch 按序应用 == 原 diff）。失败时按报错修正 `split.json` 重试（≤2 次）。

### 5.2 render：必须后台启动，勿前台等待

`render` 无限期阻塞等待人工评审，前台跑会被会话超时杀掉、服务随之死亡。后台启动并重定向留存：

```powershell
# PowerShell
Start-Process -FilePath node -ArgumentList "<codefree-review-helper-dist>/codefree-review-helper.mjs","render","<output-dir>" -WindowStyle Hidden -RedirectStandardOutput render-stdout.log -RedirectStandardError render-stderr.log -PassThru
```

```bash
# bash
nohup node <codefree-review-helper-dist>/codefree-review-helper.mjs render <output-dir> > render-stdout.log 2> render-stderr.log &
```

- 目录模式下提交结果写入 `<output-dir>/submission.json`——这是本流程的核心交接通道；
- 启动后把评审链接（stderr 里打印的 URL）转告用户；**不要代替用户提交**；
- 端口冲突时用 `-p <端口>` 换端口；
- **重启服务时必须加 `--no-open`**（见 §5.4）：重复开新 Tab 会丢失用户旧页面里的评论状态。

### 5.3 轮询 submission.json

- **每次工具调用顺带检查** `<output-dir>/submission.json` 是否出现；
- 用户说"已提交"时，也**先查该文件**再继续，以文件为准；
- 文件出现 → 读 JSON → 进入 §6 回帖。**回帖完成前不要删除该文件**（幂等重跑的依据）。

submission JSON 结构：

- `comments[]`：最终评论（用户自己的 + 接受的草稿），字段 `file / line / side / body`；
- `draftComments[]`：各草稿的 accepted / rejected / pending 状态。

### 5.4 评审提交失败 / 服务停止

用户报"提交失败"、或界面显示"评审提交失败"提示时，按以下顺序重启：

1. **先删旧 submission.json**（防重启后读到旧评审）；
2. 确认旧 render 进程已退出、端口未被占用（`Get-Process node` / `ps`），或直接用 `-p` 换端口；
3. 按 §5.2 重新后台启动，**必须加 `--no-open`**——用户的评审界面还开着，评论都在旧页面里；重复开新 Tab 会得到一个空白界面；
4. 请用户在**原来的界面**点"重试"（评论保留，无需重填）。仅当用户确认界面已关闭时，才去掉 `--no-open` 重开 Tab（评论需重填），回到 §5.3 继续轮询。

## 6. 评审提交后：回帖

### 6.1 空评论

`comments` 为空：明确告知"评审无评论"，停止，不调用任何写接口。

### 6.2 去重

对每条评论计算 marker = sha256(`sub|file|line|side|body`) 的前 16 位十六进制；先调 `search_mr_global_comment_list` + `search_mr_row_comment_list` 收集 MR 上已有评论中的 marker（形如 `<!-- codefree-review-helper:xxxxxxxxxxxxxxxx -->`），命中的跳过并计入"重复"。

### 6.3 简报与确认

向用户简报后**等待确认**再发送：

- 目标：`<repoFullName>` MR `<mergeId>`（标题）；
- 计划：行内评论 n1 条（side=additions）、全局评论 n2 条（side=deletions 及降级）、跳过重复 d 条；
- 每条评论的 file:line 与正文摘要。

### 6.4 发送映射

| 评论             | 工具与参数                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `side=additions` | `add_mr_row_comment`：`filePath=file`，`startLine=endLine=line`（新文件 1-based 行号，与 submission 的 `line` 语义一致），`rowComment=<body>\n\n<!-- codefree-review-helper:<marker> -->`，`newThread=1`（**T4 实测必填**，缺省返回 `code 2005 必填参数不能为空`），附 `repoFullName`、`mergeId`、`branchName`、`commitId`、`diffType`（来源见 §6.5） |
| `side=deletions` | `add_mr_global_comment`：正文 `**<file>:<line>（删除侧）**\n\n<body>\n\n<!-- codefree-review-helper:<marker> -->`                                                                                                                                                                                                                                     |
| 行内发送失败     | 降级 `add_mr_global_comment`：正文 `**<file>:<line>**\n\n<body>\n\n<!-- codefree-review-helper:<marker> -->`，计入"降级"                                                                                                                                                                                                                              |

发送顺序按 comments 数组顺序逐条执行；单条失败不中断其余评论。

### 6.5 必填元数据（实测来源）

| 参数           | 来源                                                                  |
| -------------- | --------------------------------------------------------------------- |
| `repoFullName` | `get_mr_info` 返回的 `repoFullName`（形如 `gsyw-fqzyjczxt/fzp-next`） |
| `mergeId`      | 用户输入 / URL 解析                                                   |
| `branchName`   | `get_mr_info` 返回的 `resourceBranchName`（源分支名）                 |
| `commitId`     | `merge_file_changes` 该文件条目的 `currentCommitId`                   |
| `diffType`     | `merge_file_changes` 该文件条目的 `diffType`                          |

### 6.6 结果简报

发送完成后向用户报告：成功行内 x 条、全局 y 条（含降级 z 条）、跳过重复 d 条、失败清单（file:line + 错误）。全部失败时如实说明，不粉饰。

## 7. 兜底场景

- **本地仓库评审**：用户给了本地仓库与分支范围时，`git diff <base>...<head> > review.diff` 直接进入 §4（跳过 §2 §3）；
- **直接给 diff 文件**：用户给了 `.diff`/`.patch` 文件路径时直接进入 §4。

## 8. 错误处理

- 每步失败：指出失败步骤（定位 / 取 diff / 拼装 / 切分 / 验证 / 渲染 / 回帖）+ 错误信息 + 用户能做什么；
- 任一步连续失败 2 次后停止，把现场（已生成的文件路径、最后一条错误）交代清楚；
- 平台工具报错码与信息原样转述给用户，不要猜测性重试。
