#!/usr/bin/env node
// to-diff.mjs — 把研发云 merge_file_changes / merge_file_diff 的返回转换成 git 风格 unified diff。
//
// 用法：node to-diff.mjs <data-dir> [-o review.diff]
//
// 输入目录结构（由调用方逐页/逐文件保存 MCP 工具的完整 JSON 返回）：
//   <data-dir>/manifest-<n>.json   merge_file_changes 第 n 页的完整返回（n 从 1 起，按页码升序）
//   <data-dir>/diffs/<i>.json      按 manifest 合并后顺序、第 i 个文件的 merge_file_diff 完整返回（i 从 0 起）
//
// 输出：stdout 一行 JSON 摘要；-o 指定时另写 unified diff 文件。
// 摘要含 files / skipped（codeLineExceed 跳过的文件）/ expectedAdd / expectedDel /
// actualAdd / actualDel / match。match=false 时退出码 1。

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function fail(msg) {
  console.error(`to-diff: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args[0] || args[0] === "-o") fail("用法: node to-diff.mjs <data-dir> [-o review.diff]");
const dataDir = resolve(args[0]);
const outIdx = args.indexOf("-o");
const outFile = outIdx > 0 ? resolve(args[outIdx + 1]) : null;

// 1. 合并 manifest 分页（按页码升序，fileName 去重）
const manifestFiles = readdirSync(dataDir)
  .filter((f) => /^manifest-\d+\.json$/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
if (manifestFiles.length === 0) fail(`${dataDir} 下没有 manifest-<n>.json`);

const entries = [];
for (const f of manifestFiles) {
  let list;
  try {
    list = JSON.parse(readFileSync(join(dataDir, f), "utf8"))?.data?.dataList ?? [];
  } catch (err) {
    fail(`解析 ${f} 失败: ${err.message}`);
  }
  for (const e of list) {
    if (!e || typeof e.fileName !== "string") fail(`${f} 的 dataList 里有非法条目`);
    if (!entries.some((x) => x.fileName === e.fileName)) entries.push(e);
  }
}
if (entries.length === 0) fail("合并后的 dataList 为空（MR 无变更文件？）");

// 2. 逐文件转换
const out = [];
const skipped = [];
let expectedAdd = 0;
let expectedDel = 0;
let actualAdd = 0;
let actualDel = 0;

for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  const df = join(dataDir, "diffs", `${i}.json`);
  if (!existsSync(df)) fail(`缺少 diffs/${i}.json（对应 ${e.fileName}）`);
  let data;
  try {
    data = JSON.parse(readFileSync(df, "utf8")).data;
  } catch (err) {
    fail(`解析 diffs/${i}.json 失败: ${err.message}`);
  }
  if (!data || !Array.isArray(data.content)) fail(`diffs/${i}.json 缺少 data.content`);

  // 超限文件：跳过并提示人工评审（不计入对账）
  if (data.codeLineExceed === true) {
    skipped.push(e.fileName);
    continue;
  }

  const type = e.diffType ?? (data.changeType === "ADD" ? "A" : "E");
  const newFile = data.metaB?.name ?? e.fileName;
  const oldFile = type === "A" ? null : (data.metaA?.name ?? e.fileName);
  if (type !== "A" && type !== "D" && !data.metaA?.name) {
    fail(`${e.fileName}: diffType=${type} 但 metaA.name 缺失，无法确定旧路径`);
  }

  // 尾部空串修正：研发云会把文件末尾换行塞成 b/ab 尾部 ""，以 hunk.newEnd 为准丢弃
  const blocks = data.content.map((blk) => ({
    ab: [...(blk.ab ?? [])],
    a: [...(blk.a ?? [])],
    b: [...(blk.b ?? [])],
    hunk: blk.hunk,
  }));
  const maxNewEnd = Math.max(0, ...data.content.map((blk) => blk.hunk?.newEnd ?? 0));
  let totalNew = blocks.reduce((n, blk) => n + blk.ab.length + blk.b.length, 0);
  let drop = totalNew - maxNewEnd;
  while (drop > 0) {
    const last = [...blocks].reverse().find((blk) => blk.ab.length + blk.b.length > 0);
    if (!last) break;
    const fromB = last.b.length > 0 && last.b[last.b.length - 1] === "";
    const fromAb = last.ab.length > 0 && last.ab[last.ab.length - 1] === "";
    if (fromB) {
      last.b.pop();
      drop--;
    } else if (fromAb) {
      last.ab.pop();
      drop--;
    } else break; // 尾部不是空串：数据异常，保留原样（对账会失败并暴露）
  }

  // 顺序指针遍历：oldLine/newLine 指针，块内顺序 ab → a → b
  let oldLine = 1;
  let newLine = 1;
  const body = [];
  for (const blk of blocks) {
    const oldStart = oldLine;
    const newStart = newLine;
    const oldCount = blk.ab.length + blk.a.length;
    const newCount = blk.ab.length + blk.b.length;
    if (oldCount === 0 && newCount === 0) continue;
    // A 文件 srcStart 恒 0、D 文件 dstStart 恒 0（git 标准，也是 codefree-review-helper 切分器
    // 识别新文件/删除文件的依据，src/core/split.ts 的 fixHunkLineNumbers 与
    // generateSubPatches 依赖 -0,0 / +0,0 信号）；E 文件用真实指针行号
    const srcOut = type === "A" ? 0 : oldStart;
    const dstOut = type === "D" ? 0 : newStart;
    body.push(`@@ -${srcOut},${oldCount} +${dstOut},${newCount} @@`);
    for (const l of blk.ab) body.push(" " + l);
    for (const l of blk.a) body.push("-" + l);
    for (const l of blk.b) body.push("+" + l);
    oldLine += oldCount;
    newLine += newCount;
  }

  // 文件头外壳（parsePatch 只认 diff --git + @@ 格式；diff --git 行总用 a/<path> b/<path>）
  const gitA = `a/${oldFile ?? newFile}`;
  const gitB = `b/${type === "D" ? oldFile : newFile}`;
  out.push(`diff --git ${gitA} ${gitB}`);
  if (type === "A") out.push("new file mode 100644");
  if (type === "D") out.push("deleted file mode 100644");
  out.push(
    `--- ${oldFile === null ? "/dev/null" : `a/${oldFile}`}`,
    `+++ ${type === "D" ? "/dev/null" : `b/${newFile}`}`,
    ...body,
  );

  expectedAdd += e.addLines ?? 0;
  expectedDel += e.delLines ?? 0;
  for (const l of body) {
    if (l.startsWith("+")) actualAdd++;
    else if (l.startsWith("-")) actualDel++;
  }
}

if (outFile) writeFileSync(outFile, out.join("\n") + "\n");

const summary = {
  files: entries.length,
  skipped,
  expectedAdd,
  expectedDel,
  actualAdd,
  actualDel,
  match: actualAdd === expectedAdd && actualDel === expectedDel,
  outFile,
};
console.log(JSON.stringify(summary));
if (!summary.match) process.exit(1);
