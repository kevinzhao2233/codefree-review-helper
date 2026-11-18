import type { ResolvedRewriteBlock, ReviewSubmission } from "../core/types";

export interface SubPatch {
  index: number;
  description: string;
  diff: string;
  draftComments: {
    id: string;
    change: number;
    file: string;
    line: number;
    side: string;
    body: string;
    sub: number;
    source: "agent";
  }[];
  rewrites?: ResolvedRewriteBlock[];
}

export interface DataOptions {
  /** Base URL for API requests (default: current origin) */
  baseUrl?: string;
}

function buildUrl(path: string, opts: DataOptions): string {
  return `${opts.baseUrl ?? ""}${path}`;
}

export async function fetchPatches(opts: DataOptions = {}): Promise<SubPatch[]> {
  if ((window as { __PATCHES__?: SubPatch[] }).__PATCHES__) {
    return (window as { __PATCHES__: SubPatch[] }).__PATCHES__;
  }
  const res = await fetch(buildUrl("/api/patches", opts));
  if (!res.ok) throw new Error(`Failed to fetch patches: ${res.status}`);
  return res.json();
}

export async function submitReview(
  submission: ReviewSubmission,
  opts: DataOptions = {},
): Promise<void> {
  const res = await fetch(buildUrl("/api/submit", opts), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(submission),
  });
  if (!res.ok) {
    throw new Error(`提交评审失败：HTTP ${res.status}`);
  }
}
