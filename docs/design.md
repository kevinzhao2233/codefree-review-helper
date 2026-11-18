# codefree-reviewdeck 设计文档

> **状态：执行中** —— T0 已提交（设计已审批），T1 实测完成并回填 §10，T2 起依次推进。
>
> **文档地位**：本文件是"reviewdeck 转换为基于 CodeFree 与研发云"任务的**唯一设计文档**，承载需求、方案、任务拆解、AC 与验收结果。实测结论与验收结果直接回填本文件对应章节，禁止新建其他设计/需求/验收文档。

---

## 1. 背景与目标

### 1.1 背景

reviewdeck 是一个"把大 PR diff 切成有序子 patch 供人评审"的工具，当前实现基于 **ClaudeCode + GitHub/GitLab**：

- 核心算法在 `src/core/`（diff 解析、change 索引、split 验证），平台无关；
- skill `skills/reviewdeck/` 指导 ClaudeCode 用 `gh pr diff` 拿 diff、跑 `reviewdeck index/split/render`；
- 多用户模式托管在 NAP 上，通过 `forge.py` 调 GitHub/GitLab REST API 完成读 diff 与回帖。

### 1.2 目标

新增一条**基于 CodeFree + 研发云**的本地评审路径：

- 使用者在 CodeFree 会话中说"帮我 review 这个 MR"，由 CodeFree 通过研发云 MCP 完成定位 MR → 取 diff → 切分 → 渲染评审 UI → 回帖的完整链路；
- 不依赖 NAP、不依赖 GitHub/GitLab；
- **不修改任何现有代码**（`src/`、`nap/`、`skills/reviewdeck/` 全部保持原样），仅新增 skill 与本文档。

### 1.3 非目标

- 不做 NAP/服务端多用户模式（现有 `nap/`、`src/service/` 保持不动）；
- 不移除现有 GitHub/GitLab 支持与既有 skill；
- 不发布 npm；
- 不修改 MR 本身（不创建/合并/关闭 MR，不推送代码）。

---

## 2. 使用场景

| 场景                        | 输入                                        | 优先级                |
| --------------------------- | ------------------------------------------- | --------------------- |
| A. 研发云 MR 评审（主场景） | 研发云 MR 链接，或 `repoFullName + mergeId` | **优先实现**          |
| B. 本地仓库评审             | 本地 git 仓库路径 + 分支范围                | 兜底，复用 `git diff` |
| C. 直接提供 diff 文件       | 一个 `.diff`/`.patch` 文件路径              | 兜底，直接进入 index  |

场景 B/C 为 skill 中的次要分支，规则与现有 `skills/reviewdeck/SKILL.md` 一致，本文档 AC 以场景 A 为主。

---

## 3. 总体流程

```
用户："帮我 review 这个 MR：<链接 / repoFullName+mergeId>"
  │
  ├─ ① 定位 MR ──── 研发云 MCP：merge_request_list / get_mr_info
  │                  （取标题、状态、源/目标分支、变更数）
  │
  ├─ ② 获取 diff ── 研发云 MCP：merge_file_changes（分页）逐文件列出
  │                  → 逐文件 merge_file_diff → 拼装 git 风格 unified diff → review.diff
  │
  ├─ ③ 索引 ─────── reviewdeck index review.diff → pr.index.txt
  │
  ├─ ④ 切分 ─────── CodeFree 按 references/split.md 规则生成 split.json
  │                  （groups + 每组 description + 可选 draftComments）
  │
  ├─ ⑤ 验证与渲染 ── reviewdeck split review.diff split.json -o output/
  │                  → reviewdeck render output/（浏览器评审 UI，等待用户提交）
  │
  ├─ ⑥ 评审提交 ─── 用户在浏览器逐组评审，输出 submission JSON
  │                  （comments = 用户自己的 + 接受的 draft；含 file/line/side/body）
  │
  └─ ⑦ 回帖 ─────── 研发云 MCP：先去重（search_mr_*_comment_list + marker）
                      → side=additions → add_mr_row_comment（行内）
                      → side=deletions 或行内失败 → add_mr_global_comment（全局）
                      → 结果简报（成功/降级/重复/失败计数）
```

---

## 4. 详细设计

### 4.1 MR 定位（步骤 ①）

- 输入优先级：`repoFullName + mergeId`（明确）> MR 链接（需解析出仓库与 MR 标识）> "最新的 MR"（用 `merge_request_list` 按仓库筛选后与用户确认）。
- 调 `get_mr_info(mergeId)` 校验存在性与访问权限，读取标题、状态（0 开启/1 已合并/2 已关闭）、源/目标分支。
- 已合并/已关闭的 MR：允许进入评审（diff 可读），但在回帖前明确告知用户 MR 状态，回帖失败按 §4.5 错误处理。
- 解析失败、MR 不存在、无权限：明确报错并停止，不进入后续步骤。

### 4.2 diff 获取与拼装（步骤 ②，核心新实现）

**数据源**（研发云 MCP，替代 `gh pr diff`/`forge.py`）：

1. `merge_file_changes(mergeId, pageNum, pageSize)` 分页遍历，取全量变更文件列表（含 fileName、diffType 等）；
2. 逐文件 `merge_file_diff(mergeId, fileName)` 取该文件的 diff 内容；
3. 按文件顺序拼装为 `review.diff`。

**格式规格**（必须满足 `src/core/patch.ts` 的 `parsePatch` 输入要求）：

```
diff --git a/<srcFile> b/<dstFile>
[new file mode 100644]        ← diffType=A 时
[deleted file mode 100644]    ← diffType=D 时
--- a/<srcFile> | /dev/null   ← A 时为 /dev/null
+++ b/<dstFile> | /dev/null   ← D 时为 /dev/null
@@ -<srcStart>,<srcCount> +<dstStart>,<dstCount> @@   ← 行号必须准确
 <context lines>
-<deleted lines>
+<added lines>
```

- 文件头必须是 `diff --git a/... b/...`（`parsePatch` 以此识别文件边界）；
- hunk 头 `@@` 行号必须与内容一致（split 验证依赖 `applyPatch`/`reconstructBase`）；
- 参考实现：`nap/skills/reviewdeck/scripts/forge.py` 中 `gitlab_file_diff()` 的拼装方式（`forge.py:93-109`）。

**关键决策点（T1 实测已定，结论见 §10）**：

- ~~若 `merge_file_diff` 返回已含带行号的 `@@` hunk 头 → 直接补文件头外壳拼接~~
- **实际：返回 Gerrit 风格结构化 JSON（`ab/a/b` 数组 + `hunk` 行号），非文本 diff** → T2 落地为 `scripts/to-diff.mjs` 转换脚本（顺序指针法 + 尾部空串修正，已用真实 MR 验证 440/440 对账，见 §10 转换算法）；
- 若 diff 为空/MR 无变更 → 报错停止。

**大 MR 处理**：分页遍历不设上限，逐文件追加写入，避免一次性内存拼接；单文件超大 diff 的截断风险见 §9 R-5。

### 4.3 索引、切分与评审（步骤 ③④⑤⑥，复用现状）

- `reviewdeck index` 输出 `## <file>` + `[index] +/- L<lineNo>: <content>` 的编号清单（`src/core/split.ts:106`）；
- 切分规则完全复用 `skills/reviewdeck/references/split.md`（`deps-first` 默认、`tests/docs-first` 备选、每组 description 讲清"为何在此、看什么"）；
- `draftComments` 规则：只针对 diff 能支撑的具体问题，锚定 `change`（属于同一组）；
- `split` 命令自带组合验证（子 patch 按序应用 == 原 diff），失败则修正 split.json 重试；
- `render` 阻塞等待用户在浏览器提交，stdout 输出 submission JSON：`comments[]`（最终评论：用户自己的 + 接受的 draft，字段 `file/line/side/body`）与 `draftComments[]`（各 draft 的 accepted/rejected/pending 状态）。

### 4.4 评论回帖（步骤 ⑦，核心新实现）

**数据映射**（`submission.comments[i]` → 研发云 MCP 参数）：

| submission 字段 | 含义                                                       | 研发云参数                              |
| --------------- | ---------------------------------------------------------- | --------------------------------------- |
| `file`          | 文件路径                                                   | `filePath`（行内）/ 正文标注（全局）    |
| `line`          | 行号（additions=新文件 1-based；deletions=旧文件 1-based） | `startLine`=`endLine`=`line`（行内）    |
| `side`          | additions/deletions                                        | additions→行内；deletions→全局 fallback |
| `body`          | 评论正文                                                   | `rowComment`（正文+去重 marker）        |

**必填元数据**（`add_mr_row_comment` 需要）：`repoFullName`、`mergeId`、`branchName`、`commitId`、`diffType` —— 来源在 T1 实测确认（`get_mr_info` 或 `merge_file_changes` 的返回字段）。

**回帖顺序与降级**：

1. additions → `add_mr_row_comment`；失败（行号超界、锚定失败等）→ fallback `add_mr_global_comment`；
2. deletions → 直接 `add_mr_global_comment`，正文格式：`**<file>:<line>（删除侧）**\n\n<body>`；
3. 全部失败记录到 errors，不中断其余评论。

**去重 marker**（沿用 `forge.py` 机制）：

- marker = sha256(`sub|file|line|side|body`) 前 16 位 hex，以 `<!-- reviewdeck:<marker> -->` 附在评论正文尾部；
- 发送前先调 `search_mr_global_comment_list` + `search_mr_row_comment_list` 收集已有 marker 集合，命中的跳过（计 duplicates）；
- 重复执行回帖幂等，不产生重复评论。

**发送前确认**：回帖前向用户简报——目标仓库/MR、将发送的评论数（行内 n1 + 全局 n2）、跳过的重复数，确认后才执行。

### 4.5 错误处理

- 每个步骤失败时：指出失败步骤 + 错误信息 + 用户能做什么，停止流程；
- 单步重试不超过 2 次（对齐现有 nap skill 规则）；
- `comments` 为空：明确说明"评审无评论"，不调用任何写接口；
- 回帖部分失败：继续发送其余评论，最终简报成功/降级/重复/失败计数。

### 4.6 安全边界（硬性）

- **写操作（发评论）仅限用户在会话中明确指定的 MR**；
- 研发云所有仓库中，默认仅 `fzp-next` 允许写操作；对其他仓库执行写操作前必须先获用户在会话中的明确授权；
- 只读操作（列表/diff/评论查询）不受仓库限制；
- 不创建、不合并、不关闭 MR/PR，不推送代码，不修改仓库内容。

---

## 5. 交付物

| 交付物                                             | 说明                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `docs/design.md`                                   | 本文档（唯一设计文档，含 AC 与验收结果）                                                           |
| `skills/codefree-reviewdeck/SKILL.md`              | 面向 CodeFree 的新 skill 主文件                                                                    |
| `skills/codefree-reviewdeck/references/split.md`   | 从 `skills/reviewdeck/references/split.md` 复制（保证 skill 可独立安装；文件头注明来源与同步关系） |
| `skills/codefree-reviewdeck/references/rewrite.md` | 同上                                                                                               |

不修改：`src/`、`nap/`、`skills/reviewdeck/`、`package.json` 等一切现有文件。

skill 启用方式：源文件在仓库内；使用时由用户复制/链接到 CodeFree 的 skill 目录（本机环境），细节由用户按其 CodeFree 安装方式处理。

---

## 6. 任务拆解与提交计划

每个任务一个独立 commit，commit message 携带任务编号与名称。

| 任务   | 内容                                                                                                                   | commit message                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **T0** | 设计文档 + AGENTS.md 协作规则（本任务，审批后提交）                                                                    | `T0: 设计文档与协作规则`             |
| **T1** | 研发云 MCP 实测（§9 的 5 项），结论回填本文档 §10                                                                      | `T1: 研发云 MCP 实测`                |
| **T2** | 编写 `skills/codefree-reviewdeck/`（SKILL.md + references 副本）                                                       | `T2: 编写 codefree-reviewdeck skill` |
| **T3** | 本地链路 dry-run：用 T1 拿到的真实 MR diff 走 index → split → render，验证 §8 中 AC-2/AC-3 相关条目                    | `T3: 本地链路 dry-run 验证`          |
| **T4** | 端到端验收：真实 MR 评审 + 回帖（fzp-next），按 §8 全部 AC 逐项验收，结果回填 §11；发现问题在本任务内修复并追加 commit | `T4: 端到端验收`                     |

**T1 需要用户协作**：提供一个 `fzp-next` 仓库的测试 MR（已存在的或新创建的均可），用于只读实测（取 diff/元数据）；发评论实测放在 T4，且发送前会按 §4.4 向用户确认。

---

## 7. 关键技术事实（已从代码确认）

| 事实                                                                                     | 出处                        | 影响                |
| ---------------------------------------------------------------------------------------- | --------------------------- | ------------------- |
| `parsePatch` 只认 `diff --git` 文件头 + `@@ -s,c +s,c @@` hunk 头                        | `src/core/patch.ts:20-86`   | 拼装格式硬性要求    |
| hunk 行号参与 split 组合验证（`applyPatch` 校验 context）                                | `src/core/patch.ts:149-225` | 行号必须准确        |
| 索引输出：`## <file>` + `[index] +/- L<lineNo>: <content>`                               | `src/core/split.ts:106-120` | CodeFree 据此分组   |
| `ReviewComment = {file, line, side, body, ...}`；additions 的 line 为新文件 1-based 行号 | `src/core/types.ts:49-80`   | 回帖映射依据        |
| `submission.comments` = 用户自己 + 接受的 draft；被拒/未处理的 draft 不在其中            | `src/cli` render 流程       | 回帖只处理 comments |
| GitLab 拼 diff 的参考实现                                                                | `forge.py:93-109`           | T2 拼装逻辑蓝本     |
| CLI 入口：`index`/`split`/`render`/`serve` 四个子命令，本地模式只用前三个                | `src/cli/main.ts`           | 运行方式            |

**CLI 运行方式（默认，待用户审批时确认）**：本地构建 `npm run build:cli` 后 `node dist/reviewdeck.mjs <subcommand>`；若用户偏好 `npx reviewdeck` 方式再调整 skill 措辞。

---

## 8. 验收标准（AC）

验收逐条执行，结果回填 §11。每条 AC 均给出验证方法。

### AC-1 MR 定位

- [ ] **AC-1.1** 给定 MR 链接或 `repoFullName+mergeId`，能获取 MR 标题、状态、源/目标分支 —— 验证：T1/T4 实测输出。
- [ ] **AC-1.2** MR 不存在或无权限时，明确报错并停止，不进入取 diff 环节 —— 验证：用一个不存在的 mergeId 实测。
- [ ] **AC-1.3** 已合并/已关闭 MR 允许评审，但回帖前明确告知用户当前状态 —— 验证：T4 用已合并 MR 场景演练（只告知不发送）。

### AC-2 diff 获取与拼装（MR 模式）

- [ ] **AC-2.1** `merge_file_changes` 分页取全量文件列表，逐文件 `merge_file_diff` 无遗漏（文件数一致） —— 验证：T1 计数核对。
- [ ] **AC-2.2** 拼装产物 `review.diff` 被 `reviewdeck index` 成功解析，changeCount > 0 —— 验证：T3 实跑。
- [ ] **AC-2.3** 拼装内容与 MR 实际变更一致（抽样 ≥3 个文件逐行核对 diff 内容与行号） —— 验证：T3 人工抽样。
- [ ] **AC-2.4** MR 无变更/diff 为空时明确报错并停止 —— 验证：代码路径检查（或用空 MR 实测）。

### AC-3 切分与评审

- [ ] **AC-3.1** 生成的 split.json 通过 `reviewdeck split` 验证（每个 change 恰好归入一组、子 patch 组合还原原 diff） —— 验证：T3 实跑 split 命令。
- [ ] **AC-3.2** `reviewdeck render` 启动评审 UI，用户提交后输出合法 submission JSON —— 验证：T3 实跑并检查 JSON 结构。
- [ ] **AC-3.3** `draftComments` 锚定的 change 属于同一组且评论内容可由 diff 支撑 —— 验证：T3/T4 人工检查产出。

### AC-4 评论回帖

- [ ] **AC-4.1** `side=additions` 评论以行内评论发送，落点为对应 `file:line`（行号语义正确） —— 验证：T4 在 fzp-next 测试 MR 实发后页面核对。
- [ ] **AC-4.2** `side=deletions` 评论以全局评论发送，正文含 `file:line（删除侧）` 标注 —— 验证：同上。
- [ ] **AC-4.3** 行内评论失败时自动降级全局评论并计入结果简报 —— 验证：T4 构造失败场景（如行号越界）。
- [ ] **AC-4.4** 重复执行回帖幂等，不产生重复评论 —— 验证：T4 连续执行两次回帖，第二次全部计为 duplicates。
- [ ] **AC-4.5** `comments` 为空时不调用任何写接口，明确告知"无评论" —— 验证：T4 空评审场景。
- [ ] **AC-4.6** 发送前向用户简报（目标 MR、评论数、形式）并获确认 —— 验证：T4 流程观察。

### AC-5 安全与边界

- [ ] **AC-5.1** 写操作仅发生在用户指定 MR；默认仅 `fzp-next` 可写 —— 验证：skill 文本审查 + T4 实测。
- [ ] **AC-5.2** 不创建/合并/关闭 MR，不修改仓库代码 —— 验证：skill 文本审查 + T4 前后 MR 状态核对。
- [ ] **AC-5.3** 对非 fzp-next 仓库的写操作，skill 明确要求先获用户会话内授权 —— 验证：skill 文本审查。

### AC-6 工程与质量

- [ ] **AC-6.1** 未修改 `src/`、`nap/`、`skills/reviewdeck/` 下任何现有文件 —— 验证：`git diff --stat` 仅含 `docs/design.md`、`AGENTS.md`、`skills/codefree-reviewdeck/**`。
- [ ] **AC-6.2** `vp test` 通过（依赖就绪后执行；现有测试无回归） —— 验证：实跑命令。
- [ ] **AC-6.3** 每任务一个 commit 且 message 含任务编号 —— 验证：`git log --oneline` 检查。

---

## 9. 风险与待实测项

| #   | 风险/待确认                                                                            | 影响                                               | 缓解                                                | 状态（T1 后）                                                                                                               |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| R-1 | `merge_file_diff` 返回是否带 `@@` hunk 头（含行号）                                    | 决定 T2 拼装复杂度：带 → 补外壳；不带 → 需行号计算 | T1 第一优先实测                                     | **已解除**：返回结构化 JSON（无文本 hunk 头），走 `to-diff.mjs` 转换（§10 M-1）                                             |
| R-2 | `add_mr_row_comment` 的 `startLine/endLine` 行号语义（新文件行号 or 其他）             | AC-4.1 行内落点正确性                              | T1 实测 + T4 页面核对                               | **部分解除**：新文件 1-based（与 additions 一致），发送侧 T4 页面复核                                                       |
| R-3 | `add_mr_row_comment` 必填元数据（`commitId`/`branchName`/`diffType`）的字段来源        | T2 skill 取数指令                                  | T1 实测 `get_mr_info`/`merge_file_changes` 返回结构 | **已解除**：见 §10 M-3                                                                                                      |
| R-4 | 研发云 MR 页面链接格式（URL 正则）                                                     | skill 的定位输入解析                               | T1 实测                                             | **已解除**：见 §10 M-4                                                                                                      |
| R-5 | 大文件 diff 的返回上限/截断行为                                                        | AC-2.1/2.3 完整性                                  | T1 用大文件 MR 实测                                 | **部分解除**：`codeLineExceed` 标志存在（本 MR 均 false）；skill 按标志跳过并提示，`codeLineExceed=true` 的实际行为 T4 留意 |
| R-6 | 已合并 MR 是否还能发行内评论                                                           | AC-1.3 回帖可行性                                  | T4 实测（或只做告知）                               | 待 T4                                                                                                                       |
| R-7 | 依赖未安装导致 `vp test`/构建不可用                                                    | AC-6.2 执行                                        | 用户处理依赖（见 §6 协作）                          | 持续                                                                                                                        |
| R-8 | `render` 需打开浏览器 —— 假定用户在本机跑 CodeFree 会话（浏览器可弹出）                | 步骤 ⑤ 可用性                                      | 使用场景约定为本机；远端场景不在本期范围            | 持续                                                                                                                        |
| R-9 | **新发现**：`merge_request_list` 的 status 枚举失配（实际 MR 状态 7，按 0/1/2 查不到） | skill 的 MR 定位路径                               | 定位一律走 `get_mr_info(mergeId)` 直查（§10 M-6.1） | 已缓解                                                                                                                      |

---

## 10. 实测结果记录（T1 回填）

实测对象：fzp-next 测试 MR（`gsyw-fqzyjczxt/fzp-next`，mergeId=1735339，"[SPEC-FZP-001][Init] SDD 初始化项目骨架"，4 个变更文件，+440/-0）。实测日期：2026-11-17。

| #   | 实测项                        | 工具/方法                                 | 结果                                                                                                                        | 结论与影响                                                                               |
| --- | ----------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| M-1 | `merge_file_diff` 返回格式    | 4 个文件全样本（E/A/空文件）              | **Gerrit 风格结构化 JSON，非文本 diff**（结构见下）                                                                         | T2 需要"结构化 → unified diff"转换脚本 `scripts/to-diff.mjs`；算法已验证（440/440 对账） |
| M-2 | `add_mr_row_comment` 行号语义 | `.gitignore` 样本 hunk 分析               | `hunk.newStart` 从 1 起，新文件 1-based 行号                                                                                | 与 reviewdeck additions 的 `line` 语义一致；发送侧 T4 页面复核                           |
| M-3 | 必填元数据来源                | `merge_file_changes` / `get_mr_info` 返回 | `commitId` ← `currentCommitId`；`diffType` ← `diffType`；`branchName` ← `get_mr_info.resourceBranchName`（源分支，T4 复核） | 元数据链路打通                                                                           |
| M-4 | MR 链接格式                   | 用户提供样本                              | `https://www.srdcloud.cn/code/{projId}/CodeMergeView/{mergeId}/mergeInfo`                                                   | 正则提取 `mergeId` 即可（projId 无需）                                                   |
| M-5 | 分页与截断行为                | 本 MR 4 文件单页取完                      | `pageSize` 默认 10，`dataCount` 供分页循环判断；`codeLineExceed` 超限标志（本 MR 均 false）                                 | T2 实现分页循环；`codeLineExceed=true` 时跳过该文件并提示人工评审                        |
| M-6 | 其他实测中的发现              | —                                         | 三项，见下                                                                                                                  | 影响 skill 定位与转换器                                                                  |

### M-6 发现明细

1. **`merge_request_list` 的 status 枚举失配**：工具文档说 0 开启/1 已合并/2 已关闭，但本 MR 实际 `mergeRequestStatus=7`，用 status=0 查不到（返回空但"成功"）。**skill 定位一律走 `get_mr_info(mergeId)` 直查**，列表接口仅作辅助；
2. **尾部空串 bug**：文件末尾换行符会被塞成 `b` 数组尾部 `""`（`AGENTS.md` 的 b 有 174 个元素，`hunk.newEnd=173`）。转换器必须以 `hunk.newEnd` 为准丢弃超出的尾部空串；
3. **`projName` 是项目标识**（如 `gsyw-fqzyjczxt`），非仓库名；`repoFullName` = `"<项目标识>/<仓库名>"`。

### M-1 格式细节（`merge_file_diff` 返回结构）

```json
{
  "metaA": {}, // A 类型为空对象；E 类型 {"name": "<file>"}
  "metaB": { "name": "<fileName>" },
  "changeType": "ADD", // A 类型带此字段；E 类型无
  "content": [
    {
      "ab": ["上下文行"], // unchanged 行（两侧同）
      "a": ["被删除行"], // 旧侧独有
      "b": ["新增行"], // 新侧独有
      "hunk": {
        "oldStart": 0,
        "oldEnd": -1, // A/全增文件：0/-1（旧侧无内容）
        "newStart": 1,
        "newEnd": 266 // 新文件 1-based 行范围（含端点）
      }
    }
  ],
  "codeLineExceed": false // true = 该文件 diff 超限（不完整），跳过并提示人工
}
```

- 空文件（A 且 0 行）：`content: []`；
- E 行级修改样本（`.gitignore`）：`ab`（上下文）与 `b`（新增）分块返回，`hunk.oldStart=1, oldEnd=0`。

### 转换算法（已用真实 MR 验证，440/440 对账通过）

1. **尾部空串修正**：`sum(ab+b)` 超过 `max(hunk.newEnd)` 时，从最后一个块尾部丢弃空串直到相等；
2. **顺序指针遍历**：`oldLine=1, newLine=1`；每块按 `ab → a → b` 输出 ` /-/+` 行，块内行数累进指针；
3. **文件头外壳**：按 `diffType` 生成 `diff --git` + `new file mode 100644` / `deleted file mode 100644` + `--- a|/dev/null` / `+++ b|/dev/null`；
4. **对账**：转换后 `+/-` 行数必须等于 `sum(addLines+delLines)`，不等则报错。

### T3 dry-run 发现与修复（2026-11-17）

用 T1 真实 MR diff 走 index → split → render 全链路，**发现并修复转换器一个关键 bug**：

- **A/D 文件 hunk 头硬约定**：A 文件 hunk 必须 `@@ -0,0 ...`（srcStart 恒 0）、D 文件 `@@ ... +0,0`（dstStart 恒 0）。reviewdeck 切分器（`src/core/split.ts` 的 `fixHunkLineNumbers` 与 `generateSubPatches`）依赖 `-0,0` 信号识别"新文件创建"来计算子 hunk 行号；错误格式（如 `@@ -1,0 ...`）在 index 阶段不报错，但 split 组合验证必然错位 1 行（实测报 `context mismatch`）；
- **render 前置构建**：render 依赖 Web UI 产物，本地需 `npm run build:web`（`npm run build` 一次含全部）；
- **验证结果**：5 组 split 组合验证通过；render 经 `POST /api/submit` 模拟提交，stdout 输出合法 submission JSON（comments/draftComments 结构与中文内容完好）。

T3 已验证 AC：AC-2.1（单页场景）、AC-2.2、AC-2.3（4 文件全量）、AC-3.1、AC-3.2、AC-3.3。见 §11。

### T4 端到端发现（2026-11-18）

1. **`add_mr_row_comment` 的 `newThread` 是隐藏必填**：工具 schema 未标注，缺省时返回 `code 2005 必填参数不能为空`；传 `newThread=1`（新评论主题）后成功。已写入 SKILL.md §6.4；
2. **行内评论落点实测正确**：发送后 `search_mr_row_comment_list` 返回的 `startLine/endLine`（2 与 47）与 submission 一致，marker 完整落库，`robotComment=0`；
3. **get_mr_info 错误路径**：不存在的 mergeId 返回 `code 3068 代码合并请求不存在或用户没有权限查看`（AC-1.2 依据）；
4. **Web UI 既有 bug（用户批准修复）**：`ReviewDeck.tsx` 的 `expandUnchanged: true` 使 partial diff 初始渲染即触发 `@pierre/diffs` 的 `loadDiffFiles is required` 崩溃（GitHub 场景同样触发，非研发云适配引入）。经用户单次批准，改为 `expandUnchanged: false` 并附注释；"展开更多上下文"按钮交互仍会崩（上游库限制，不阻塞评审主流程），已知问题留待上游解决；
5. **幂等实测**：2 条评论发送后复跑去重流程，已有 marker 集与待发集 2/2 命中，全部计为 duplicates，零新增评论。

---

## 11. 验收记录（T4 回填）

| AC     | 结果（通过/不通过）          | 证据/备注                                                                                                                                                                       | 日期       |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| AC-1.1 | **通过（T1/T4）**            | get_mr_info 返回标题/状态(原始值 7)/源目标分支/repoFullName                                                                                                                     | 2026-11-18 |
| AC-1.2 | **通过（T4）**               | mergeId=999999999 返回 `code 3068 代码合并请求不存在或用户没有权限查看`，可据此报错停止                                                                                         | 2026-11-18 |
| AC-1.3 | 部分（T4）                   | 本 MR 状态 7 可正常评审与发评论；"已合并/已关闭"场景无样本，未实测，skill 按状态原始值提醒                                                                                      |            |
| AC-2.1 | 通过（T3，单页场景）         | 本 MR 4 文件单页取完；分页循环在 `to-diff.mjs` 中按 `manifest-<n>` 合并实现，多页场景 T4 复核                                                                                   | 2026-11-17 |
| AC-2.2 | 通过（T3）                   | `review.diff` 被 index 成功解析：440 changes                                                                                                                                    | 2026-11-17 |
| AC-2.3 | 通过（T3，4 文件全量）       | 对账 440/440 与 manifest 一致；T4 页面复核行号落点                                                                                                                              | 2026-11-17 |
| AC-2.4 | **通过（T4，代码路径检查）** | `to-diff.mjs`：dataList 为空即报错停止（"合并后的 dataList 为空（MR 无变更文件？）"）；skill 据此向用户报错                                                                     | 2026-11-18 |
| AC-3.1 | 通过（T3）                   | split.json 5 组，组合验证通过（子 patch 按序应用 == 原 diff）                                                                                                                   | 2026-11-17 |
| AC-3.2 | 通过（T3）                   | render UI 启动；`POST /api/submit` 模拟提交后 stdout 输出合法 submission JSON（中文完好）                                                                                       | 2026-11-17 |
| AC-3.3 | 通过（T3）                   | draftComments 锚定 change 47（组 2）/ 180（组 4），均属同组                                                                                                                     | 2026-11-17 |
| AC-4.1 | **通过（T4，页面已核对）**   | 行内评论发送成功，服务端回查 startLine=2/47 与 submission 一致，marker 落库；用户已在研发云 MR 页面确认评论显示正确                                                             | 2026-11-18 |
| AC-4.2 | 未实测                       | 本 MR 纯新增（+440/-0），无 deletions 评论锚点可构造；映射指令见 SKILL.md §6.4，留待真实场景                                                                                    |            |
| AC-4.3 | 未实测                       | 行内失败降级场景未构造（发送仅遇到参数缺失错误，补参后成功）；降级指令见 SKILL.md §6.4                                                                                          |            |
| AC-4.4 | **通过（T4）**               | 复跑去重：已有 marker 与待发集 2/2 命中，全计 duplicates，零新增评论                                                                                                            | 2026-11-18 |
| AC-4.5 | 指令审查通过，场景未实测     | SKILL.md §6.1 明确空评论不调写接口；本轮无空提交场景                                                                                                                            |            |
| AC-4.6 | **通过（T4）**               | 回帖简报（目标/条数/位置/正文/marker）经用户确认后发送                                                                                                                          | 2026-11-18 |
| AC-5.1 | **通过（T4）**               | 写操作仅发生在用户指定 MR 1735339（fzp-next）；仅发评论                                                                                                                         | 2026-11-18 |
| AC-5.2 | **通过（T4）**               | 未创建/合并/关闭 MR，未修改仓库代码（发送前后 MR 状态一致）                                                                                                                     | 2026-11-18 |
| AC-5.3 | **通过（T4）**               | SKILL.md §0 明确非 fzp-next 写操作需用户单次授权（文本审查）                                                                                                                    | 2026-11-18 |
| AC-6.1 | 通过（T0-T3 持续核对）       | `git diff --stat` 仅含 docs/design.md、AGENTS.md、skills/codefree-reviewdeck/**；T4 经用户批准追加 `src/web/components/review/ReviewDeck.tsx` 一处 bug 修复（见 §10 T4 发现 4） | 2026-11-18 |
| AC-6.2 | **通过（T4）**               | ReviewDeck.tsx 修改后复跑 `vp test`：11 文件 108 用例全绿（2026-11-18）                                                                                                         | 2026-11-18 |
| AC-6.3 | 通过（T0-T4）                | d63c381（T0）/ 01311aa（T1）/ e4ef11f（T2）/ ce76b77（T3）/ T4 本提交，一任务一 commit                                                                                          | 2026-11-18 |
