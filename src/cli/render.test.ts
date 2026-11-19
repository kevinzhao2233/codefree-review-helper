import { describe, expect, it, beforeEach, afterEach } from "vite-plus/test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSubPatchesFromDir,
  parseSubPatchesFromStdin,
  startReviewServer,
  type StartReviewServerOptions,
  type SubPatch,
} from "./render.ts";
import type { ReviewSubmission } from "../core/types.ts";

const SEPARATOR = "===SUB_PATCH===";

const fakeDiff = (file: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,1 @@\n-old\n+new\n`;

// ---------------------------------------------------------------------------
// parseSubPatchesFromStdin
// ---------------------------------------------------------------------------

describe("parseSubPatchesFromStdin", () => {
  it("parses single patch", () => {
    const input = fakeDiff("foo.ts");
    const result = parseSubPatchesFromStdin(input, SEPARATOR);
    expect(result).toHaveLength(1);
    expect(result[0]!.index).toBe(0);
    expect(result[0]!.diff).toContain("foo.ts");
    expect(result[0]!.draftComments).toEqual([]);
  });

  it("parses multiple patches with descriptions", () => {
    const input = [
      fakeDiff("a.ts"),
      `\n${SEPARATOR} Add helpers\n`,
      fakeDiff("b.ts"),
      `\n${SEPARATOR} Fix tests\n`,
      fakeDiff("c.ts"),
    ].join("");
    const result = parseSubPatchesFromStdin(input, SEPARATOR);
    expect(result).toHaveLength(3);
    expect(result[1]!.description).toBe("Add helpers");
    expect(result[2]!.description).toBe("Fix tests");
  });

  it("parses headered patches with JSON metadata", () => {
    const input = [
      `${SEPARATOR} {"index":0,"description":"Add helpers","draftComments":[{"id":"g1-draft1","sub":0,"change":3,"file":"a.ts","line":4,"side":"additions","body":"Potential regression.","source":"agent"}]}\n`,
      fakeDiff("a.ts"),
      `\n${SEPARATOR} {"index":1,"description":"Fix tests","draftComments":[]}\n`,
      fakeDiff("b.ts"),
    ].join("");
    const result = parseSubPatchesFromStdin(input, SEPARATOR);
    expect(result).toHaveLength(2);
    expect(result[0]!.description).toBe("Add helpers");
    expect(result[0]!.draftComments).toHaveLength(1);
    expect(result[0]!.draftComments[0]!.body).toBe("Potential regression.");
    expect(result[1]!.description).toBe("Fix tests");
  });
});

// ---------------------------------------------------------------------------
// parseSubPatchesFromDir
// ---------------------------------------------------------------------------

describe("parseSubPatchesFromDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codefree-review-helper-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads .diff files in numeric order", () => {
    // Write files that would sort wrong lexicographically
    for (const i of [1, 2, 10, 11, 3, 20]) {
      writeFileSync(join(dir, `sub${i}.diff`), fakeDiff(`file${i}.ts`));
    }

    return parseSubPatchesFromDir(dir).then((result) => {
      expect(result).toHaveLength(6);
      expect(result.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
      // Verify numeric order: 1, 2, 3, 10, 11, 20
      expect(result[0]!.diff).toContain("file1.ts");
      expect(result[1]!.diff).toContain("file2.ts");
      expect(result[2]!.diff).toContain("file3.ts");
      expect(result[3]!.diff).toContain("file10.ts");
      expect(result[4]!.diff).toContain("file11.ts");
      expect(result[5]!.diff).toContain("file20.ts");
    });
  });

  it("reads descriptions from meta.json", () => {
    writeFileSync(join(dir, "sub1.diff"), fakeDiff("a.ts"));
    writeFileSync(join(dir, "sub2.diff"), fakeDiff("b.ts"));
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify([
        { index: 0, description: "First change" },
        {
          index: 1,
          description: "Second change",
          draftComments: [
            {
              id: "g2-draft1",
              sub: 1,
              change: 7,
              file: "b.ts",
              line: 3,
              side: "additions",
              body: "Check null handling.",
              source: "agent",
            },
          ],
        },
      ]),
    );

    return parseSubPatchesFromDir(dir).then((result) => {
      expect(result[0]!.description).toBe("First change");
      expect(result[1]!.description).toBe("Second change");
      expect(result[1]!.draftComments[0]!.body).toBe("Check null handling.");
    });
  });

  it("falls back to filename when no meta.json", () => {
    writeFileSync(join(dir, "sub1.diff"), fakeDiff("pkg/util.go"));

    return parseSubPatchesFromDir(dir).then((result) => {
      expect(result[0]!.description).toBe("pkg/util.go");
    });
  });

  it("ignores non-.diff files", () => {
    writeFileSync(join(dir, "sub1.diff"), fakeDiff("a.ts"));
    writeFileSync(join(dir, "meta.json"), "[]");
    writeFileSync(join(dir, "notes.txt"), "some notes");

    return parseSubPatchesFromDir(dir).then((result) => {
      expect(result).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// startReviewServer
// ---------------------------------------------------------------------------

interface TestServer {
  port: number;
  url: string;
  close: () => Promise<void>;
  submission: Promise<ReviewSubmission>;
}

describe("startReviewServer", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codefree-review-helper-server-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const makeSubPatch = (): SubPatch => ({
    index: 0,
    description: "测试子补丁",
    diff: fakeDiff("a.ts"),
    draftComments: [],
  });

  const fakeSubmission = {
    comments: [
      { sub: 0, file: "a.ts", line: 3, side: "additions", body: "这里可能有问题", source: "human" },
    ],
    draftComments: [],
  } as unknown as ReviewSubmission;

  async function startTestServer(
    opts: Partial<StartReviewServerOptions> = {},
  ): Promise<TestServer> {
    // Fake dist dir: tests must not depend on a locally built dist/web
    // (on CI, npm test runs before npm run build).
    const distDir = join(dir, "fake-dist");
    mkdirSync(distDir);
    writeFileSync(join(distDir, "index.html"), "<!doctype html><title>test</title>");

    let handle!: TestServer;
    await new Promise<void>((ready) => {
      const submission = startReviewServer([makeSubPatch()], {
        port: 0,
        openBrowser: false,
        distDir,
        ...opts,
        onReady: (info) => {
          handle = { ...info, submission };
          ready();
        },
      });
    });
    return handle;
  }

  function postSubmit(port: number, body: string): Promise<Response> {
    return fetch(`http://localhost:${port}/api/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }

  it("提交后落盘且内容与 stdout JSON 一致", async () => {
    const submissionPath = join(dir, "submission.json");
    const server = await startTestServer({ submissionPath });

    const res = await postSubmit(server.port, JSON.stringify(fakeSubmission));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const stdoutJson = await server.submission;
    const onDisk = JSON.parse(readFileSync(submissionPath, "utf-8")) as unknown;
    expect(onDisk).toEqual(stdoutJson);
    expect(onDisk).toEqual(fakeSubmission);
    expect(existsSync(`${submissionPath}.tmp`)).toBe(false);
  });

  it("非法 JSON 返回 400，之后仍可正常提交", async () => {
    const server = await startTestServer({ submissionPath: join(dir, "submission.json") });

    const bad = await postSubmit(server.port, "not-json");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "非法 JSON" });

    const good = await postSubmit(server.port, JSON.stringify(fakeSubmission));
    expect(good.status).toBe(200);
    expect(await server.submission).toEqual(fakeSubmission);
  });

  it("落盘失败返回 500 且服务器保持存活", async () => {
    const submissionPath = join(dir, "nonexistent-dir", "submission.json");
    const server = await startTestServer({ submissionPath });

    const first = await postSubmit(server.port, JSON.stringify(fakeSubmission));
    expect(first.status).toBe(500);

    const second = await postSubmit(server.port, JSON.stringify(fakeSubmission));
    expect(second.status).toBe(500);

    await server.close();
  });

  it("未指定落盘路径时正常返回且不落盘", async () => {
    const server = await startTestServer({});

    const res = await postSubmit(server.port, JSON.stringify(fakeSubmission));
    expect(res.status).toBe(200);
    expect(await server.submission).toEqual(fakeSubmission);
    expect(existsSync(join(dir, "submission.json"))).toBe(false);
  });
});
