# codefree-review-helper

Split large PR/MR diffs into reviewable sub-patches via LLM-assigned groups. CodeFree + 研发云 only; local CLI form. (原名 reviewdeck，2026-11 起更名。)

## Toolchain: Vite+

This project uses [Vite+](https://vite.plus) (`vp`) as the unified toolchain. Do not use Bun, npm, pnpm, or Yarn directly.

- `vp install` — install dependencies
- `vp test` — run tests (Vitest)
- `vp check` — format (Oxfmt) + lint (Oxlint) + type check (tsgo)
- `vp check --fix` — auto-fix formatting and lint issues
- `vp dev` — dev server
- `vp build` — production build
- `vp add <pkg>` / `vp remove <pkg>` — manage dependencies

Import test utilities from `vitest`, not `bun:test`. Import config from `vite-plus`.

## Quality checks

```sh
npm run lint   # runs: vp test && vp check && knip && depcruise
```

- **knip** — dead code / unused exports detection
- **dependency-cruiser** — layer dependency rules (`.dependency-cruiser.cjs`)

## Release

Release flow is Git-based. Do not run `npm publish` locally for this repo.

> **npm 发布暂停（2026-11-18 用户决策）**：不 bump 版本、不打 tag、不发布、不迁移 npm registry 上的 `reviewdeck` 包，直到用户明确解除。`exports "./ui"`（`dist/ui/reviewdeck-ui.js`）为 npm 冻结项，保留原名。

正常发布流程（解冻后适用）：

- bump the version in `package.json` and `package-lock.json`
- run release checks locally, typically `npm test`, `npm run build`, and `npm run pack:dry-run`
- commit the release changes
- push the release commit to `main`
- create and push a version tag such as `v0.2.4`

Publishing to npm is handled by GitHub Actions after the tag is pushed.

## Architecture

```
L0  src/core/       Pure computation — zero I/O, zero external deps
L1  src/cli/        CLI entry point — file I/O, git, process control
L2  src/web/        Review web UI (render 的浏览器评审界面)
    skills/         codefree-review-helper skill（仅限 CodeFree 环境）
```

### Dependency rules (enforced by dependency-cruiser)

- `core` must not import from `cli` or `web`
- `cli` must not import from `web`
- `web` may import from `core`, not from `cli`

## Testing

Tests live next to source files as `*.test.ts`. Run with `vp test`.

```ts
import { describe, expect, it } from "vitest";
```

## 协作规则（用户规定，高优先级）

### 工作流程

1. **唯一设计文档**：本仓库的转换任务只用 `docs/design.md` 一份设计文档承载需求、方案、任务拆解、AC 与验收结果；禁止新建其他设计/需求/验收文档。实测结论与验收结果直接回填该文档的对应章节。
2. **先设计后编码**：写代码前必须先完成 `docs/design.md` 并交用户审批；审批通过后才能动代码。
3. **按 AC 验收**：代码完成后，按 `docs/design.md` 中的 AC 逐条测试验收，验收结果回填该文档。
4. **提交纪律**：一个任务一个 commit，禁止多个任务合并提交；commit message 必须携带任务编号或任务名称（如 `T1: 研发云 MCP 实测`）。

### 协作方式

- 需要用户协作的事项（提供测试 MR、确认操作、安装依赖、处理环境问题等）**直接说明**，不要自行反复尝试不擅长的平台操作（如创建 MR/PR、发布、配置平台等）。
- 依赖安装等环境问题由用户自行处理，不要代替用户执行，除非用户单次允许。
- 不主动 `npm publish`、不主动创建 MR/PR，除非用户单次允许。

### 安全边界（研发云）

- 用户的所有研发云仓库中，**只有 `fzp-next` 可以执行写操作**（发评论、创建内容等）；其他仓库一律只读。
- 不创建、不合并、不关闭 MR/PR，除非用户单次允许。
- 涉及写操作前，先向用户说明将要执行的动作与影响范围。
