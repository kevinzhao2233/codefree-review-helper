#!/usr/bin/env node
// save-raw.mjs — 把研发云 merge_file_changes / merge_file_diff 的返回**原样**校验落盘。
//
// 为什么需要它：
//   研发云 MCP 返回的是结构化 JSON（manifest / diff），落在会话上下文里。若让 LLM 用
//   write 工具"重写"这段 JSON 再落盘，等于让模型逐字符转录超大文本：又慢又易错
//   （缺引号/截断/摘抄），to-diff.mjs 会在对账阶段才暴露，返工成本高。
//   本脚本把"转录"变成"透传 + 校验"：LLM 只需把 MCP 返回的**原始字符串**通过 stdin
//   原样交进来，脚本负责 JSON.parse 合法性、结构校验、规范化落盘。
//
// 用法：
//   cat resp.json | node save-raw.mjs <kind> <out-file>
//   Get-Content resp.json -Raw | node save-raw.mjs <kind> <out-file>
//
//   <kind>      必填：manifest | diff
//     manifest 校验 .data.dataList 为非空数组（merge_file_changes 分页返回）
//     diff     校验 .data.content 为数组（merge_file_diff 单文件返回）
//   <out-file>  必填：输出 JSON 路径（目录不存在会自动创建）
//
// 退出码：0 成功；1 参数/读取/解析/结构校验失败。
// 成功时 stdout 一行 JSON 摘要 { kind, outFile, listLen|contentLen, bytes }。
// 失败时 stderr 带精确错误信息（解析错误含 position 与出错片段），不落盘。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function fail(msg) {
  console.error(`save-raw: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 2) {
  fail("用法: <kind=manifest|diff> <out-file>，JSON 从 stdin 读取");
}
const [kind, outRaw] = args;
if (kind !== "manifest" && kind !== "diff") {
  fail(`kind 必须是 manifest 或 diff，实际是 "${kind}"`);
}

// 1. 从 stdin 读原始字节（不假设已 parse，保留原文用于报错定位）
let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch (err) {
  fail(`读取 stdin 失败: ${err.message}`);
}
const trimmed = raw.trim();
if (!trimmed) fail("stdin 为空，未收到任何内容");

// 2. JSON.parse：失败时给出精确 position + 附近片段（含 UTF-16 校正）
let data;
try {
  data = JSON.parse(trimmed);
} catch (err) {
  const posMatch = err.message.match(/position (\d+)/);
  let snippet = "";
  if (posMatch) {
    const pos = Number(posMatch[1]);
    const start = Math.max(0, pos - 30);
    snippet = ` 出错片段: ${JSON.stringify(trimmed.slice(start, pos + 30))}`;
  }
  fail(`stdin 不是合法 JSON: ${err.message}${snippet ? "\n" + snippet : ""}`);
}

// 3. 结构校验（按 kind）
let listLen = 0;
let contentLen = 0;
if (kind === "manifest") {
  const list = data?.data?.dataList;
  if (!Array.isArray(list)) fail("结构校验失败: 缺少 data.dataList（非数组）");
  listLen = list.length;
  if (listLen === 0) fail("结构校验失败: data.dataList 为空数组");
  for (const e of list) {
    if (!e || typeof e.fileName !== "string") {
      fail("结构校验失败: dataList 存在非法条目（缺少 fileName 字符串）");
    }
  }
} else {
  const content = data?.data?.content;
  if (!Array.isArray(content)) fail("结构校验失败: 缺少 data.content（非数组）");
  contentLen = content.length;
  for (const blk of content) {
    if (!blk || !Array.isArray(blk.ab) || !Array.isArray(blk.a) || !Array.isArray(blk.b)) {
      fail("结构校验失败: content 块缺少 ab/a/b（需为数组）");
    }
  }
}

// 4. 规范化落盘（目录不存在自动创建）
const outFile = resolve(outRaw);
const payload = JSON.stringify(data);
try {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, payload + "\n", "utf8");
} catch (err) {
  fail(`写文件失败 ${outFile}: ${err.message}`);
}

console.log(
  JSON.stringify({
    kind,
    outFile,
    listLen,
    contentLen,
    bytes: payload.length,
  }),
);
