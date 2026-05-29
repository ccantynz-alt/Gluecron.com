/**
 * PR size analysis — computes lines-changed from a git diff and maps to
 * an XS/S/M/L/XL label with a matching colour. Zero DB tables; pure git
 * subprocess + arithmetic.
 */

import { join } from "path";

export type PrSizeLabel = "XS" | "S" | "M" | "L" | "XL";

export interface PrSizeInfo {
  label: PrSizeLabel;
  linesChanged: number;
  added: number;
  deleted: number;
  color: string;
  bgColor: string;
}

const SIZE_COLORS: Record<PrSizeLabel, { fg: string; bg: string }> = {
  XS: { fg: "#34d399", bg: "rgba(52,211,153,0.12)" },
  S:  { fg: "#60a5fa", bg: "rgba(96,165,250,0.12)" },
  M:  { fg: "#facc15", bg: "rgba(250,204,21,0.12)" },
  L:  { fg: "#f97316", bg: "rgba(249,115,22,0.12)" },
  XL: { fg: "#f87171", bg: "rgba(248,113,113,0.12)" },
};

export function computeSizeLabel(linesChanged: number): PrSizeLabel {
  if (linesChanged < 10)  return "XS";
  if (linesChanged < 50)  return "S";
  if (linesChanged < 200) return "M";
  if (linesChanged < 500) return "L";
  return "XL";
}

export async function computePrSize(
  ownerName: string,
  repoName: string,
  baseBranch: string,
  headBranch: string
): Promise<PrSizeInfo | null> {
  try {
    const repoBase = process.env.GIT_REPOS_PATH || "./repos";
    const diskPath = join(repoBase, `${ownerName}/${repoName}.git`);

    const proc = Bun.spawn(
      ["git", "--git-dir", diskPath, "diff", "--numstat", `${baseBranch}...${headBranch}`],
      { stdout: "pipe", stderr: "pipe" }
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    let added = 0;
    let deleted = 0;
    for (const line of out.trim().split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length >= 2) {
        const a = parseInt(parts[0], 10);
        const d = parseInt(parts[1], 10);
        if (!isNaN(a)) added += a;
        if (!isNaN(d)) deleted += d;
      }
    }

    const linesChanged = added + deleted;
    const label = computeSizeLabel(linesChanged);
    const { fg, bg } = SIZE_COLORS[label];
    return { label, linesChanged, added, deleted, color: fg, bgColor: bg };
  } catch {
    return null;
  }
}
