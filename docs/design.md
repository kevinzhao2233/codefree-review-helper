# codefree-review-helper 设计文档

> **前身**：fork 自 neutree-ai 的 reviewdeck（基于 ClaudeCode + GitHub/GitLab 的大 diff 评审工具）。2026-11 起转型为 **CodeFree + 研发云** 本地评审工具并更名；NAP 多用户形态与 serve 服务端已删除，仅保留本地 CLI。
>
> **文档地位**：本仓库唯一设计文档，承载需求、方案、任务、AC 与验收结果；实测结论直接回填本文件，禁止新建其他设计/验收文档。

## 1. 定位

把大型 PR/MR diff 按 LLM 分组切成有序、可评审的子补丁，配套本地浏览器评审界面；评审提交后由 agent 把评论发回研发云 MR。

- 主场景：研发云 MR 评审（输入 MR 链接或 `repoFullName + mergeId`）；
- 兜底：本地仓库 diff、直接提供 `.diff` 文件；
- 非目标：不做服务端/多用户模式；不创建/合并/关闭 MR；不推送代码；
- **仅限 CodeFree 环境**：skill 与工具面向 CodeFree 会话（本地 CLI），其他 agent 软件不提供支持。

## 2. 端到端流程

```
用户："帮我 review 这个 MR：<链接 / repoFullName+mergeId>"
  ① 定位 MR ──── 研发云 MCP：get_mr_info（标题/状态/分支/repoFullName）
  ② 获取 diff ── merge_file_changes（分页）→ merge_file_diff 逐文件
                 → scripts/to-diff.mjs 转为 unified diff → review.diff
  ③ 索引 ─────── codefree-review-helper index review.diff > pr.index.txt
  ④ 切分 ─────── CodeFree 按 references/split.md 生成 split.json（groups + draftComments）
  ⑤ 验证渲染 ─── codefree-review-helper split review.diff split.json -o output/
                 → render output/（后台，浏览器评审界面）
  ⑥ 评审提交 ─── 用户浏览器逐组评审 → output/submission.json 落盘（agent 轮询）
  ⑦ 回帖 ─────── 研发云 MCP：去重（marker）→ additions 行内 → 失败/deletions 全局 → 简报
```

## 3. 关键设计

### 3.1 MR 定位

- 输入优先级：`repoFullName + mergeId` > MR 链接（正则提取 `mergeId`，链接形如 `/code/{projId}/CodeMergeView/{mergeId}/...`）> 模糊描述（列候选让用户确认）；
- 一律 `get_mr_info(mergeId)` 直查：**列表接口 status 枚举与实际值失配**（实测 MR 状态 7，按文档枚举 0/1/2 查不到），状态按原始值向用户报告；
- MR 不存在/无权限（`code 3068`）→ 报错停止。

### 3.2 diff 获取与转换（`scripts/to-diff.mjs`）

`merge_file_diff` 返回 **Gerrit 风格结构化 JSON**（`ab`/`a`/`b` 行数组 + `hunk` 行号），不是文本 diff。转换算法（实测 440/440 行对账通过）：

1. **尾部空串修正**：`sum(ab+b)` 超过 `hunk.newEnd` 时从尾部丢弃空串；
2. **顺序指针遍历**：每块按 `ab → a → b` 输出 context/-/+ 行，行号累进；
3. **文件头外壳**：按 `diffType`（A/D/E）生成 `diff --git` + `new/deleted file mode` + `---`/`+++` 头；
4. **硬约定**：新增文件 hunk 头必须 `@@ -0,0 ...`、删除文件必须 `@@ ... +0,0`——切分器依赖该信号计算子 hunk 行号，错误格式会导致 split 验证错位 1 行；
5. 对账：转换后 `+/-` 行数必须等于源数据行数，不等即报错。

要点：`pageSize` 默认 10 按分页循环取全量；`codeLineExceed=true`（超限截断）的文件跳过并提示人工评审；空 MR 报错停止。

### 3.3 切分与浏览器评审

- `index` 输出 `## <file>` + `[index] +/- L<lineNo>: <content>` 编号清单；切分规则见 `skills/codefree-review-helper/references/split.md`（`deps-first` 默认、每组中文 description、draftComments 锚定同组 change）；
- `split` 自带组合验证（子 patch 按序应用 == 原 diff），失败修正 split.json 重试 ≤2 次；
- `render` 启动本地 HTTP 服务渲染评审界面（依赖 `dist/web` 产物，需先 `npm run build`）。

### 3.4 提交交接（agent 与用户之间的可靠通道）

**submission.json 落盘**（`render` 核心机制，取代"读 stdout"）：

- 目录模式默认写 `<dir>/submission.json`，`-o <文件>` 可覆盖；stdin 模式仅显式 `-o` 时落盘（否则 stderr 警告）；
- 落盘在 HTTP 响应前，原子写（`.tmp` → 删旧 → rename），覆盖旧文件；
- `POST /api/submit`：非法 JSON → `400`；落盘失败 → `500` 且**服务器保持存活**可重试；成功 → `200` → 500ms 后关服务退出；stdout JSON 输出行为保留（后台运行重定向留存）。

**前端失败处理**：`submitReview` 非 2xx 抛含状态码错误；界面显示"评审提交失败"提示（评论保留在页面 state）+ "重试"按钮 + 提交中防重复点击。评论全量 POST，服务重启后重试无碍。

**agent 工作流**（SKILL.md §5，硬性约束）：

- 评审工作目录必须在系统临时目录（`mktemp -d` / `$env:TEMP`），禁止进用户仓库（防 git 污染）；
- render 必须**后台启动**（前台会被会话超时杀掉）；端口冲突用 `-p` 换端口；
- 每次工具调用顺带轮询 `submission.json`；用户说"已提交"也先查文件；回帖完成前不删该文件（幂等重跑依据）；
- **重启服务必须加 `--no-open`**：用户旧界面还开着（评论在旧 Tab 内存里），重复开新 Tab 是空白界面；仅界面已关闭才去掉 `--no-open`；
- 重启顺序：删旧 `submission.json` → 确认端口 → 后台启动 → 请用户在原界面点"重试"。

### 3.5 评论回帖

submission `comments[]`（用户评论 + 已接受草稿）→ 研发云 MCP：

| submission 字段 | 研发云参数                                                                          |
| --------------- | ----------------------------------------------------------------------------------- |
| `file`          | `filePath`（行内）/ 正文标注（全局）                                                |
| `line`          | `startLine` = `endLine`（新文件 1-based，实测落点正确）                             |
| `side`          | additions → 行内；deletions / 行内失败 → 全局（正文 `**<file>:<line>（删除侧）**`） |
| `body`          | `rowComment`（正文 + 去重 marker）                                                  |

- 必填元数据：`repoFullName`、`mergeId`、`branchName`（`get_mr_info.resourceBranchName`）、`commitId`（`currentCommitId`）、`diffType`；**`newThread=1` 是隐藏必填**（schema 未标注，缺省报 `code 2005`）；
- 去重 marker：sha256(`sub|file|line|side|body`) 前 16 位 hex，以 `<!-- codefree-review-helper:<marker> -->` 附正文尾部；发送前查已有评论 marker 集合，命中跳过 → 幂等（实测复跑 2/2 计 duplicates，零新增）；
- 单条失败不中断其余，最终简报成功/降级/重复/失败计数；发送前向用户简报并确认。

### 3.6 安全边界（硬性）

- 写操作（发评论）仅限用户在会话中明确指定的 MR；默认仅 `fzp-next` 可写，其他仓库写操作须用户单次授权；
- 不创建/合并/关闭 MR，不推送代码，不修改仓库内容。

## 4. 实测关键结论（研发云 MCP，fzp-next MR 1735339，2026-11-17/18）

- `merge_file_diff` 返回结构化 JSON（转换器已覆盖 E/A/空文件三种类型）；
- `merge_request_list` status 枚举失配 → 定位一律 `get_mr_info` 直查；
- `projName` 是项目标识（如 `gsyw-fqzyjczxt`），`repoFullName` = `项目标识/仓库名`；
- 行内评论落点实测正确（服务端回查 startLine 与 submission 一致，marker 落库）；
- 不存在的 mergeId → `code 3068`；
- 界面 bug：`expandUnchanged: true` 触发 `@pierre/diffs` 的 `loadDiffFiles is required` 崩溃，已改 `false` 规避；"展开更多上下文"按钮仍会崩（上游库限制，不阻塞主流程）。

## 5. 评审界面

- `lang="zh-CN"`，全界面中文（工具专有词保留：patch/diff/Split/Unified/Rewrite/Code/Wrap）；CLI stderr/fallback 输出同步中文；
- 主题：**shadcn neutral dark**——深色背景（`oklch(0.145 0 0)`）+ 白色主色（`primary oklch(0.922 0 0)` ≈ #e5e5e5），`color-scheme: dark` 使 diff 高亮走 github-dark；语义色（成功绿/待定黄/危险红）深底可读；
- 侧栏：patch 描述多行完整展示 + 悬停 tooltip；"评审 N 个 patch"单行；进度图例带文字（已接受/待定/已拒绝 + 悬停语义说明）；
- 设置：评审标题行右侧齿轮 popover（自动换行开关、对比视图分栏/合并；手写实现零新依赖；localStorage 持久化，key 前缀 `codefree-review-helper:review:*`）；
- 快捷键提示双平台（`⌘↵ / Ctrl+↵`）；
- LLM 输出中文：split/rewrite 参考文档与 SKILL.md 均有"输出语言"要求（description/draftComments 一律简体中文）。

## 6. 工程约定

- 工具链：[Vite+](https://vite.plus)（`vp install` / `vp test` / `vp check` / `vp dev`）；测试 Vitest，用例与源码同目录 `*.test.ts`；
- 质量：`npm run lint` = `vp test && vp check && knip && depcruise`；提交前 `vp check --fix`；
- 架构分层（dependency-cruiser 强制）：`src/core/` 纯计算零 I/O → `src/cli/`（入口，文件 I/O/git/进程）→ `src/web/`（评审界面，可 import core 不可 import cli）；`skills/` 为 CodeFree skill；
- 构建：`npm run build` = CLI esbuild 单文件（`dist/codefree-review-helper.mjs`）+ 评审界面（`dist/web/`）+ UI 库（`dist/ui/codefree-review-helper-ui.js` + style.css）；**改源码后必须重新 build 再端到端**（render 依赖 dist 产物）；
- 协作：一任务一 commit（message 带任务编号）；需要用户协作的事项直接说明；依赖安装/发布/平台配置由用户处理。

## 7. npm 发布

包名 `codefree-review-helper`（首发 `1.0.0`，2026-11-19 代码侧完成）。

- **保底流程**（npm 无预创建占位包入口，实测确认）：
  1. 本地 `npm login` + `npm publish` 首发 1.0.0（不带 `--provenance`，本地无 OIDC）；
  2. npmjs.com 包 Settings → Trusted Publisher → GitHub Actions：`kevinzhao2233` / `reviewdeck`（fork 仓库名，未改名） / `publish.yml`，勾选**允许 `npm publish`**（新建配置默认仅 stage publish）；⚠️ 配置后 **2 天内**须完成一次成功 CI 发布，否则过期重建；
  3. 后续版本：bump `package.json` + `package-lock.json` → release checks（`npm test` / `npm run build` / `npm run pack:dry-run`）→ commit → push 到 `codefree` 分支（`main` 已归档不演进）→ 打 tag `v*` → Actions 以 Trusted Publishing（OIDC，无 NPM_TOKEN）发布并自动带 provenance；
- `publish.yml` 幂等：发布前 `npm view` 检查版本，已存在则跳过（本地首发后补打 `v1.0.0` tag 不红叉）；
- `repository.url` 必须与 GitHub 仓库完全一致（OIDC 校验依赖，已指向 fork）；
- 旧上游 npm 包不做任何操作（不 deprecate/unpublish）。

## 8. 任务总账

一任务一 commit，全部完成（✅ = AC 验收通过）：

| 任务 | 内容                                                                | commit            | 状态      |
| ---- | ------------------------------------------------------------------- | ----------------- | --------- |
| T0   | 设计文档与协作规则                                                  | d63c381           | ✅        |
| T1   | 研发云 MCP 实测（§4 结论来源）                                      | 01311aa           | ✅        |
| T2   | 编写 skill（SKILL.md + references + to-diff.mjs）                   | e4ef11f           | ✅        |
| T3   | 本地链路 dry-run（发现并修复 A/D hunk 头硬约定 bug）                | ce76b77           | ✅        |
| T4   | 端到端验收（真实 MR 评审 + 回帖 + 幂等；修复 expandUnchanged 崩溃） | 8e861b8 / 384f4a3 | ✅        |
| T5   | 界面中文化与主题改造设计                                            | 73d90ff           | ✅        |
| T6   | 主题与 lang 中文化                                                  | 5dcfd44           | ✅        |
| T7   | 界面文案中文化                                                      | c1fbd4d           | ✅        |
| T8   | 侧栏布局与设置面板                                                  | c2b569f           | ✅        |
| T9   | LLM 输出中文指令                                                    | 14040fc / 470cf03 | ✅        |
| T10  | 浏览器验收修复（标题单行/主题反转 dark/popover 细节）               | dd9e207 / 4809764 | ✅        |
| T11  | 删除 NAP 与 serve 服务端（-7423 行）                                | 0082a04           | ✅        |
| T12  | 项目改名 + CLI usage 中文化                                         | 78e320b           | ✅        |
| T13  | skill 增加 CodeFree 环境限制                                        | aa22955           | ✅        |
| T14  | README 中文化与 AGENTS 架构更新                                     | 7917062 / 9348f0e | ✅        |
| T15  | render 提交结果落盘（submission.json + `-o` + 单测）                | e57cede           | ✅        |
| T16  | 评审提交失败提示（重试/防重复点击 + 单测）                          | 4b01c10           | ✅        |
| T17  | skill 提交流程更新（§3.4 工作流）+ §18 验收回填                     | 7ea6b06 / f05b388 | ✅        |
| T18  | npm 包首发 1.0.0（版本/组件改名/lock/workflow 幂等/文档）           | 5850b1d           | ✅ 代码侧 |
| T19  | `--no-open` 参数修复重启重复开 Tab                                  | 1d3bbbc           | ✅        |

质量基线：`vp test` 7 文件 87 用例全绿；lint 全链通过（vp check + knip + depcruise 51 modules 无违规）；`pack:dry-run` 包内容验证通过（name/version/bin/files/exports/四类产物）。

## 9. 遗留项

- **用户侧发布待办**（§7 步骤 1–2）：本地 publish 1.0.0 → 配置 Trusted Publisher（2 天时效）→ 打 tag `v1.0.0` 验证 CI 绿色；
- 未实测场景（留待真实 MR）：已合并/已关闭 MR 的评审与回帖；deletions 侧全局评论；行内失败降级全局；空评论不调写接口；`codeLineExceed=true` 超限文件行为；
- W-4：LLM 中文输出已落地指令，实际中文 draftComments 待下次真实评审验证；
- "展开更多上下文"按钮点击崩溃（`@pierre/diffs` 上游限制，主流程不受影响，待上游解决）；
- 依赖安装等环境问题由用户处理（历史遗留约定）。
