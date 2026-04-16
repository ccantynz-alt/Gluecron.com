/**
 * License compliance scanner.
 *
 * Analyzes repo dependencies for license compatibility issues. Flags
 * copyleft licenses (GPL, AGPL) that may contaminate proprietary codebases,
 * and unknown/missing licenses that need manual review.
 */

import { listDependenciesForRepo } from "./deps";
import type { RepoDependency } from "../db/schema";

export type LicenseRisk = "none" | "low" | "medium" | "high" | "unknown";

export interface LicenseInfo {
  name: string;
  ecosystem: string;
  version: string;
  license: string;
  risk: LicenseRisk;
  reason?: string;
}

export interface LicenseReport {
  totalDeps: number;
  scanned: number;
  risks: {
    high: LicenseInfo[];
    medium: LicenseInfo[];
    low: LicenseInfo[];
    unknown: LicenseInfo[];
  };
  compliant: boolean;
  summary: string;
}

const COPYLEFT_HIGH: string[] = [
  "AGPL-3.0",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "GPL-3.0",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "GPL-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "SSPL-1.0",
  "EUPL-1.2",
];

const COPYLEFT_MEDIUM: string[] = [
  "LGPL-3.0",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "LGPL-2.1",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "MPL-2.0",
  "EPL-2.0",
  "EPL-1.0",
  "CDDL-1.0",
  "OSL-3.0",
];

const PERMISSIVE: string[] = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-3.0",
  "Zlib",
  "BSL-1.0",
  "PSF-2.0",
  "Python-2.0",
  "BlueOak-1.0.0",
];

// Well-known package licenses (avoids registry lookups for the most common packages)
const KNOWN_LICENSES: Record<string, string> = {
  "react": "MIT",
  "react-dom": "MIT",
  "typescript": "Apache-2.0",
  "express": "MIT",
  "lodash": "MIT",
  "axios": "MIT",
  "next": "MIT",
  "vue": "MIT",
  "angular": "MIT",
  "hono": "MIT",
  "drizzle-orm": "Apache-2.0",
  "esbuild": "MIT",
  "bun": "MIT",
  "tailwindcss": "MIT",
  "postcss": "MIT",
  "webpack": "MIT",
  "vite": "MIT",
  "eslint": "MIT",
  "prettier": "MIT",
  "jest": "MIT",
  "@types/node": "MIT",
  "@types/react": "MIT",
  "zod": "MIT",
  "prisma": "Apache-2.0",
  "@prisma/client": "Apache-2.0",
  "pg": "MIT",
  "mysql2": "MIT",
  "mongoose": "MIT",
  "cors": "MIT",
  "dotenv": "BSD-2-Clause",
  "chalk": "MIT",
  "commander": "MIT",
  "inquirer": "MIT",
  "glob": "ISC",
  "rimraf": "ISC",
  "uuid": "MIT",
  "moment": "MIT",
  "dayjs": "MIT",
  "date-fns": "MIT",
  "sharp": "Apache-2.0",
  "bcrypt": "MIT",
  "jsonwebtoken": "MIT",
  "socket.io": "MIT",
  "redis": "MIT",
  "ioredis": "MIT",
  "aws-sdk": "Apache-2.0",
  "@aws-sdk/client-s3": "Apache-2.0",
  "stripe": "MIT",
  "nodemailer": "MIT",
  "highlight.js": "BSD-3-Clause",
  "marked": "MIT",
  "@anthropic-ai/sdk": "MIT",
  "openai": "Apache-2.0",
  "mysql": "MIT",
  "sqlite3": "BSD-3-Clause",
  "better-sqlite3": "MIT",
  "ffmpeg": "LGPL-2.1",
  "readline-sync": "MIT",
  "puppeteer": "Apache-2.0",
  "playwright": "Apache-2.0",
};

function classifyLicense(spdxId: string): { risk: LicenseRisk; reason?: string } {
  const normalized = spdxId.trim();

  if (COPYLEFT_HIGH.some((l) => normalized.includes(l))) {
    return { risk: "high", reason: `Copyleft license (${normalized}) — may require source disclosure` };
  }
  if (COPYLEFT_MEDIUM.some((l) => normalized.includes(l))) {
    return { risk: "medium", reason: `Weak copyleft (${normalized}) — review linking requirements` };
  }
  if (PERMISSIVE.some((l) => normalized.includes(l))) {
    return { risk: "none" };
  }
  return { risk: "low", reason: `Uncommon license (${normalized}) — verify compatibility` };
}

function lookupLicense(name: string): string | null {
  return KNOWN_LICENSES[name] ?? null;
}

export async function scanLicenses(repositoryId: string): Promise<LicenseReport> {
  const deps = await listDependenciesForRepo(repositoryId);

  const results: LicenseInfo[] = [];
  const risks: LicenseReport["risks"] = { high: [], medium: [], low: [], unknown: [] };

  for (const dep of deps) {
    const license = lookupLicense(dep.name);
    const version = dep.versionSpec?.replace(/^[~^>=<!\s]+/, "") || "unknown";

    if (!license) {
      const info: LicenseInfo = {
        name: dep.name,
        ecosystem: dep.ecosystem,
        version,
        license: "UNKNOWN",
        risk: "unknown",
        reason: "License not in local database — verify manually",
      };
      results.push(info);
      risks.unknown.push(info);
      continue;
    }

    const { risk, reason } = classifyLicense(license);
    const info: LicenseInfo = {
      name: dep.name,
      ecosystem: dep.ecosystem,
      version,
      license,
      risk,
      reason,
    };
    results.push(info);

    if (risk === "high") risks.high.push(info);
    else if (risk === "medium") risks.medium.push(info);
    else if (risk === "low") risks.low.push(info);
  }

  const highCount = risks.high.length;
  const medCount = risks.medium.length;
  const unknownCount = risks.unknown.length;

  let summary: string;
  if (highCount > 0) {
    summary = `${highCount} high-risk copyleft license${highCount === 1 ? "" : "s"} detected — review required before shipping.`;
  } else if (medCount > 0) {
    summary = `${medCount} weak copyleft license${medCount === 1 ? "" : "s"} found — verify linking requirements.`;
  } else if (unknownCount > 0) {
    summary = `All known licenses are permissive. ${unknownCount} package${unknownCount === 1 ? "" : "s"} with unknown licenses need manual review.`;
  } else {
    summary = "All dependencies use permissive licenses. No compliance issues detected.";
  }

  return {
    totalDeps: deps.length,
    scanned: results.length,
    risks,
    compliant: highCount === 0,
    summary,
  };
}
