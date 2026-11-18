/**
 * Render command: starts a local web server for diff review.
 *
 * Reads sub-patches from stdin or files, serves pre-built static UI,
 * blocks until the user submits review decisions, then outputs them to stdout.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve, extname } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import type { AgentDraftComment, ResolvedRewriteBlock, ReviewSubmission } from "../core/types.ts";

export interface SubPatch {
  index: number;
  description: string;
  diff: string;
  draftComments: AgentDraftComment[];
  rewrites?: ResolvedRewriteBlock[];
}

type SubPatchMeta = Partial<Omit<SubPatch, "diff">>;

async function findDir(candidates: string[]): Promise<string | null> {
  for (const dir of candidates) {
    try {
      const s = await stat(dir);
      if (s.isDirectory()) return dir;
    } catch {
      // continue
    }
  }
  return null;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

async function resolveDistDir(): Promise<string> {
  const candidates = [
    resolve(import.meta.dirname, "web"),
    resolve(import.meta.dirname, "../../dist/web"),
  ];
  const dir = await findDir(candidates);
  if (!dir) {
    console.error(`错误：Web UI 未构建，请先运行 "npm run build:web"。`);
    process.exit(1);
  }
  return dir;
}

export interface StartReviewServerOptions {
  port?: number;
  submissionPath?: string;
  openBrowser?: boolean;
  onReady?: (info: { port: number; url: string; close: () => Promise<void> }) => void;
}

/**
 * Start the review server. Returns a promise that resolves with the final
 * review submission when the user submits the review.
 */
export async function startReviewServer(
  subPatches: SubPatch[],
  opts: StartReviewServerOptions = {},
): Promise<ReviewSubmission> {
  const port = opts.port ?? 3847;
  const distDir = await resolveDistDir();

  return new Promise<ReviewSubmission>((resolveComments) => {
    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";

      // API: serve sub-patches data
      if (url === "/api/patches" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(subPatches));
        return;
      }

      // API: receive submitted comments
      if (url === "/api/submit" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          let submission: ReviewSubmission;
          try {
            submission = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as ReviewSubmission;
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "非法 JSON" }));
            return;
          }

          if (opts.submissionPath) {
            try {
              writeSubmissionFile(opts.submissionPath, submission);
            } catch (e) {
              console.error(
                `错误：评审结果落盘失败：${e instanceof Error ? e.message : String(e)}`,
              );
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "落盘失败" }));
              return;
            }
          } else {
            console.error("警告：未指定落盘路径，submission 仅输出到 stdout。");
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));

          // Shut down after a brief delay to let the response flush
          setTimeout(() => {
            httpServer.closeIdleConnections();
            httpServer.close(() => resolveComments(submission));
          }, 500);
        });
        return;
      }

      // Static file serving
      await serveStatic(distDir, url, res);
    });

    httpServer.listen(port, () => {
      const address = httpServer.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      const url = `http://localhost:${actualPort}`;
      console.error(`评审服务已启动：${url}`);
      console.error("等待评审提交…\n");
      if (opts.submissionPath) {
        console.error(`提交后将写入：${opts.submissionPath}`);
      }

      opts.onReady?.({
        port: actualPort,
        url,
        close: () =>
          new Promise<void>((done) => {
            httpServer.closeIdleConnections();
            httpServer.close(() => done());
          }),
      });

      if (opts.openBrowser === false) return;

      // Open browser
      import("node:child_process").then(({ exec }) => {
        const cmd =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : "xdg-open";
        exec(`${cmd} ${url}`);
      });
    });
  });
}

function writeSubmissionFile(target: string, submission: ReviewSubmission): void {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(submission, null, 2) + "\n");
  rmSync(target, { force: true });
  renameSync(tmp, target);
}

async function serveStatic(distDir: string, url: string, res: ServerResponse): Promise<void> {
  // Strip query string
  const pathname = url.split("?")[0]!;

  // Resolve file path (SPA: fallback to index.html)
  let filePath = resolve(distDir, pathname === "/" ? "index.html" : `.${pathname}`);

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = resolve(filePath, "index.html");
    }
  } catch {
    // File not found — SPA fallback
    filePath = resolve(distDir, "index.html");
  }

  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

/**
 * Parse sub-patches from the separator-delimited format.
 *
 * Supports both:
 *   1. Legacy format: first patch raw, then `\n===SUB_PATCH=== description\n`
 *   2. Headered format: every patch starts with `===SUB_PATCH=== <json-meta>\n`
 */
export function parseSubPatchesFromStdin(input: string, separator: string): SubPatch[] {
  if (input.trimStart().startsWith(separator)) {
    return parseHeaderedSubPatches(input, separator);
  }

  return parseLegacySubPatches(input, separator);
}

function parseHeaderedSubPatches(input: string, separator: string): SubPatch[] {
  const regex = new RegExp(`^${escapeRegex(separator)}(?: (.+))?$`, "gm");
  const matches = [...input.matchAll(regex)];
  const results: SubPatch[] = [];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const next = matches[i + 1];
    const metadataRaw = match[1]?.trim();
    const start = match.index! + match[0].length + 1;
    const end = next ? next.index! : input.length;
    const diff = input.slice(start, end).trim();
    if (!diff) continue;

    const metadata = parseSeparatorMetadata(metadataRaw, results.length);
    results.push({
      index: metadata.index ?? results.length,
      description: metadata.description,
      draftComments: metadata.draftComments ?? [],
      rewrites: metadata.rewrites,
      diff,
    });
  }

  return results;
}

function parseLegacySubPatches(input: string, separator: string): SubPatch[] {
  // Split on separator lines, capturing the description after the separator
  const separatorRegex = new RegExp(`\n${escapeRegex(separator)}(?: (.+))?\n`);
  const parts = input.split(separatorRegex);

  // parts alternates: [diff0, desc1, diff1, desc2, diff2, ...]
  const results: SubPatch[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const diff = parts[i]!.trim();
    if (!diff) continue;

    // Description comes from the separator before this part (except first)
    const desc = i > 0 ? parts[i - 1] : undefined;
    const fileMatch = diff.match(/^diff --git a\/(.+?) b\//m);
    const description =
      desc?.trim() ?? (fileMatch ? `对 ${fileMatch[1]} 的变更` : `子补丁 ${results.length + 1}`);

    results.push({ index: results.length, description, draftComments: [], diff });
  }
  return results;
}

function parseSeparatorMetadata(
  raw: string | undefined,
  fallbackIndex: number,
): SubPatchMeta & { description: string } {
  if (!raw) return { index: fallbackIndex, description: `子补丁 ${fallbackIndex + 1}` };
  try {
    const parsed = JSON.parse(raw) as SubPatchMeta;
    return {
      index: parsed.index ?? fallbackIndex,
      description: parsed.description?.trim() || `子补丁 ${fallbackIndex + 1}`,
      draftComments: parsed.draftComments ?? [],
      rewrites: parsed.rewrites,
    };
  } catch {
    return { index: fallbackIndex, description: raw.trim(), draftComments: [] };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse sub-patches from files in a directory.
 * Reads meta.json (written by `split -o`) for descriptions when available.
 */
export async function parseSubPatchesFromDir(dir: string): Promise<SubPatch[]> {
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".diff"))
    .sort((a, b) => {
      // Numeric sort: sub1.diff, sub2.diff, ..., sub10.diff
      const na = parseInt(a.match(/(\d+)/)?.[1] ?? "0");
      const nb = parseInt(b.match(/(\d+)/)?.[1] ?? "0");
      return na - nb || a.localeCompare(b);
    });

  // Try to load descriptions and agent draft comments from meta.json
  let metaRecords: (SubPatchMeta & { index: number })[] = [];
  try {
    const raw = await readFile(resolve(dir, "meta.json"), "utf-8");
    const meta: (SubPatchMeta & { index: number })[] = JSON.parse(raw);
    metaRecords = meta.sort((a, b) => a.index - b.index);
  } catch {
    // No meta.json — fall back to generated descriptions
  }

  const patches: SubPatch[] = [];
  for (let i = 0; i < files.length; i++) {
    const diff = await readFile(resolve(dir, files[i]!), "utf-8");
    const meta = metaRecords[i];
    const description =
      meta?.description ?? diff.match(/^diff --git a\/(.+?) b\//m)?.[1] ?? `子补丁 ${i + 1}`;
    patches.push({
      index: i,
      description,
      draftComments: meta?.draftComments ?? [],
      rewrites: meta?.rewrites,
      diff: diff.trim(),
    });
  }
  return patches;
}
