/**
 * codefree-review-helper 统一 CLI。
 *
 * 用法：
 *   codefree-review-helper index <patch> [-o <文件>]
 *   codefree-review-helper split <patch> <meta | -> [-o <目录>]
 *   codefree-review-helper render [<目录> | -]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parsePatch, applyPatch, reconstructBase } from "../core/patch.ts";
import {
  indexChanges,
  formatIndexedChanges,
  validateMeta,
  generateSubPatches,
  resolveSplitGroupMeta,
  resolveGroupRewrites,
  rewriteCoverage,
  type SplitMeta,
  type ResolvedSplitGroupMeta,
} from "../core/split.ts";

const SUB_PATCH_SEPARATOR = "===SUB_PATCH===";

const args = process.argv.slice(2);
const subcommand = args[0];

if (wantsHelp(args)) {
  printUsage();
  process.exit(0);
}

if (!subcommand) {
  printUsage();
  process.exit(2);
}

switch (subcommand) {
  case "index":
    await cmdIndex(args.slice(1));
    break;
  case "split":
    await cmdSplit(args.slice(1));
    break;
  case "render":
    await cmdRender(args.slice(1));
    break;
  default:
    console.error(`Unknown subcommand: ${subcommand}`);
    printUsage();
    process.exit(2);
}

function printUsage() {
  console.error(`用法：
  codefree-review-helper index <patch> [-o <文件>]
      从 PR diff 生成编号的变更索引，供 LLM 分组使用。

  codefree-review-helper split <patch> <meta | -> [-o <目录>]
      按 split 元数据生成并校验有序的子补丁。
      校验子补丁按序组合 == 原 diff。
      split 元数据中可附带草稿评审评论（draftComments），供 render 展示。

  codefree-review-helper render [<目录> | -] [-p <端口>]
      为生成的子补丁启动人工评审界面。
      在 "split" 之后使用，用于把切分结果交给人工评审。
      会打开浏览器，提交后向 stdout 输出 submission JSON 对象。

示例：
  gh pr diff 123 > pr.diff
  codefree-review-helper index pr.diff > pr.index.txt
  cat split.json | codefree-review-helper split pr.diff - -o output/
  codefree-review-helper render output/`);
}

function wantsHelp(args: string[]): boolean {
  return args.length > 0 && (args[0] === "-h" || args[0] === "--help" || args[0] === "help");
}

function printIndexUsage() {
  console.error(`用法：
  codefree-review-helper index <diff 文件> [-o <输出文件>]

从 PR diff 生成编号的变更索引。
索引输出供 LLM 生成 split 元数据时阅读。`);
}

function printSplitUsage() {
  console.error(`用法：
  codefree-review-helper split <diff 文件> <split-json | -> [-o <目录>]

按 split 元数据生成有序子补丁，并校验其按序组合 == 原 diff。

split 元数据可选包含组级 "draftComments"，评审界面会将其作为
agent 草稿评论内联展示，供评审人接受/拒绝。

实验特性：组级 "rewrites"（[{ changes, title?, rewrite }]）在评审界面中
用等价且更聚焦的 Markdown 表达替换被覆盖的变更行；代码始终一键可达。

split 成功后，若目标是把子补丁交给人工评审或收集评论，
请继续执行 "codefree-review-helper render"。`);
}

function printRenderUsage() {
  console.error(`用法：
  codefree-review-helper render [<目录> | -] [-p <端口>]

为人工评审准备生成的子补丁。

- 输入可以是 "split -o" 输出的目录，或 "split" 的 stdin
- 服务模式会打开浏览器并阻塞等待人工提交评审
- 提交的 JSON 包含最终评论，以及 agent 草稿的接受/拒绝状态

示例：
  codefree-review-helper render output/
  cat split.json | codefree-review-helper split pr.diff - | codefree-review-helper render -`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

async function readFileOrStdin(path: string): Promise<string> {
  return path === "-" ? readStdin() : readFile(path, "utf-8");
}

function coverageNote(sub: string, group: ResolvedSplitGroupMeta): string {
  if (!group.rewrites?.length) return "";
  const { total, covered } = rewriteCoverage(sub, group.rewrites);
  return `；改写覆盖 ${covered}/${total} 条变更行`;
}

function writeSubs(
  subs: string[],
  groups: ResolvedSplitGroupMeta[],
  outDir: string | undefined,
): void {
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    for (let i = 0; i < subs.length; i++) {
      const outPath = `${outDir}/sub${i + 1}.diff`;
      writeFileSync(outPath, subs[i]!);
      const lineCount = subs[i]!.split("\n").length;
      console.error(`  已写入 ${outPath}（${lineCount} 行${coverageNote(subs[i]!, groups[i]!)}）`);
    }
    // Write meta.json so render can read descriptions and draft review comments.
    const meta = groups.map((group) => ({
      index: group.index,
      description: group.description,
      draftComments: group.draftComments,
      rewrites: group.rewrites,
    }));
    writeFileSync(`${outDir}/meta.json`, JSON.stringify(meta, null, 2) + "\n");
    console.error(`  已写入 ${outDir}/meta.json`);
    const coverage = subs.map((sub, i) => rewriteCoverage(sub, groups[i]!.rewrites));
    const covered = coverage.reduce((n, c) => n + c.covered, 0);
    if (covered > 0) {
      const total = coverage.reduce((n, c) => n + c.total, 0);
      console.error(
        `  改写覆盖 ${covered}/${total} 条变更行；其余 ${total - covered} 行仍以代码形式阅读。`,
      );
    }
  } else {
    for (let i = 0; i < subs.length; i++) {
      const meta = JSON.stringify(groups[i]!);
      process.stdout.write(`${i > 0 ? "\n" : ""}${SUB_PATCH_SEPARATOR} ${meta}\n`);
      process.stdout.write(subs[i]!);
    }
  }
}

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

async function cmdIndex(args: string[]) {
  if (wantsHelp(args)) {
    printIndexUsage();
    return;
  }

  const { values, positionals } = parseArgs({
    args,
    options: { output: { type: "string", short: "o" } },
    allowPositionals: true,
  });

  const diffFile = positionals[0];
  if (!diffFile) {
    printIndexUsage();
    process.exit(1);
  }

  const text = await readFile(diffFile, "utf-8");
  const patches = parsePatch(text);
  const changes = indexChanges(patches);
  const output = formatIndexedChanges(changes) + `\n\nTotal: ${changes.length} change lines\n`;

  if (values.output) {
    writeFileSync(values.output, output);
    console.error(`已写入 ${values.output}（${changes.length} 条变更）`);
  } else {
    process.stdout.write(output);
  }
}

// ---------------------------------------------------------------------------
// split (with built-in verification)
// ---------------------------------------------------------------------------

async function cmdSplit(args: string[]) {
  if (wantsHelp(args)) {
    printSplitUsage();
    return;
  }

  const { values, positionals } = parseArgs({
    args,
    options: { output: { type: "string", short: "o" } },
    allowPositionals: true,
  });

  const [diffFile, splitFile] = positionals;
  if (!diffFile || !splitFile) {
    printSplitUsage();
    process.exit(1);
  }

  // Parse inputs
  const diffText = readFileSync(diffFile, "utf-8");
  let meta: SplitMeta;
  const metaRaw = await readFileOrStdin(splitFile);
  try {
    meta = JSON.parse(metaRaw);
  } catch {
    console.error(`错误：split 元数据不是合法 JSON。
输入必须是符合以下结构的 JSON 对象：
{
  "groups": [
    { "description": "...", "changes": [0, 1, "2-5"] }
  ]
}

实际收到：${metaRaw.slice(0, 200)}${metaRaw.length > 200 ? "..." : ""}`);
    process.exit(1);
  }

  // Validate meta
  const patches = parsePatch(diffText);
  const changes = indexChanges(patches);
  const errors = validateMeta(meta, changes.length);

  if (errors.length > 0) {
    console.error(`错误：split 元数据不合法（${errors.length} 个问题）：
${errors.map((e) => `  - ${e}`).join("\n")}

本 diff 的变更编号范围：0-${changes.length - 1}（共 ${changes.length} 条变更）。
每个编号必须恰好归入一个组。修正 meta JSON 后重试。`);
    process.exit(1);
  }

  console.error(`切分：${meta.groups.length} 组，${changes.length} 条变更`);
  for (let i = 0; i < meta.groups.length; i++) {
    const g = meta.groups[i]!;
    console.error(`  ${i + 1}. ${g.description}（${g.changes.length} 项）`);
  }

  // Generate sub-patches
  const subs = generateSubPatches(diffText, meta);

  // Verify composition
  const base = reconstructBase(patches);
  const expected = applyPatch(base, patches);

  let state = base;
  for (let i = 0; i < subs.length; i++) {
    try {
      state = applyPatch(state, parsePatch(subs[i]!));
    } catch (e: any) {
      console.error(`错误：子补丁 #${i + 1}（"${meta.groups[i]!.description}"）应用失败：${e.message}

这通常意味着第 ${i + 1} 组的变更与更早的组冲突。
请检查该组的变更编号是否正确、是否依赖了后面组里的变更。`);
      process.exit(1);
    }
  }

  const allFiles = [...new Set([...expected.keys(), ...state.keys()])].sort();
  const mismatches: string[] = [];

  for (const f of allFiles) {
    const exp = expected.get(f) ?? [];
    const act = state.get(f) ?? [];
    if (exp.length !== act.length || !exp.every((l, i) => l === act[i])) {
      mismatches.push(f);
    }
  }

  if (mismatches.length > 0) {
    console.error(`错误：组合校验失败——子补丁按序应用后与原 diff 不一致。
${mismatches.length} 个文件在依次应用全部子补丁后存在差异：
${mismatches.map((f) => `  - ${f}`).join("\n")}

这可能是切分算法的 bug，请反馈。`);
    process.exit(1);
  }

  // All good — output sub-patches
  console.error("校验通过：子补丁按序组合 == 原 diff。");
  const rewrites = resolveGroupRewrites(meta, subs);
  const groupMeta = resolveSplitGroupMeta(meta, changes).map((group, i) => ({
    ...group,
    ...rewrites[i],
  }));
  writeSubs(subs, groupMeta, values.output);

  if (values.output) {
    console.error(`下一步：执行 "codefree-review-helper render ${values.output}" 评审这些子补丁。`);
  } else {
    console.error('下一步：把本输出通过管道传给 "codefree-review-helper render -" 启动评审。');
  }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

async function cmdRender(args: string[]) {
  if (wantsHelp(args)) {
    printRenderUsage();
    return;
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      port: { type: "string", short: "p" },
    },
    allowPositionals: true,
  });

  const { startReviewServer, parseSubPatchesFromStdin, parseSubPatchesFromDir } =
    await import("./render.ts");

  const source = positionals[0] ?? "-";
  let subPatches;

  if (source === "-") {
    const input = await readStdin();
    subPatches = parseSubPatchesFromStdin(input, SUB_PATCH_SEPARATOR);
  } else {
    subPatches = await parseSubPatchesFromDir(source);
  }

  if (subPatches.length === 0) {
    console.error("错误：没有可评审的子补丁。");
    process.exit(1);
  }

  console.error(`已加载 ${subPatches.length} 个子补丁。`);

  const port = values.port ? parseInt(values.port, 10) : undefined;
  const submission = await startReviewServer(subPatches, { port });

  // Output submission as JSON to stdout
  process.stdout.write(JSON.stringify(submission, null, 2));
  process.stdout.write("\n");
}
