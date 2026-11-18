import { describe, expect, it, afterEach } from "vite-plus/test";
import { submitReview } from "./data.ts";
import type { ReviewSubmission } from "../core/types.ts";

const fakeSubmission = {
  comments: [
    { sub: 0, file: "a.ts", line: 3, side: "additions", body: "这里可能有问题", source: "human" },
  ],
  draftComments: [],
} as unknown as ReviewSubmission;

describe("submitReview", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("非 2xx 抛含状态码的错误", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 502 })) as typeof fetch;
    await expect(submitReview(fakeSubmission)).rejects.toThrow("502");
  });

  it("2xx 正常 resolve", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    await expect(submitReview(fakeSubmission)).resolves.toBeUndefined();
    expect(called).toBe(true);
  });
});
