/**
 * SBOM (Software Bill of Materials) export.
 *
 * Generates SPDX 2.3 and CycloneDX 1.5 documents from the repo_dependencies
 * table. This is a key differentiator — GitHub charges enterprise prices for
 * what we ship free.
 */

import { listDependenciesForRepo } from "./deps";
import type { RepoDependency } from "../db/schema";

const ECOSYSTEM_PURL_TYPE: Record<string, string> = {
  npm: "npm",
  pypi: "pypi",
  go: "golang",
  cargo: "cargo",
  rubygems: "gem",
  composer: "composer",
};

function toPurl(dep: RepoDependency): string {
  const type = ECOSYSTEM_PURL_TYPE[dep.ecosystem] ?? dep.ecosystem;
  const version = dep.versionSpec?.replace(/^[~^>=<!\s]+/, "") || "unknown";
  return `pkg:${type}/${encodeURIComponent(dep.name)}@${encodeURIComponent(version)}`;
}

// ── SPDX 2.3 ───────────────────────────────────────────────────────────────

interface SpdxDocument {
  spdxVersion: string;
  dataLicense: string;
  SPDXID: string;
  name: string;
  documentNamespace: string;
  creationInfo: {
    created: string;
    creators: string[];
    licenseListVersion: string;
  };
  packages: SpdxPackage[];
  relationships: SpdxRelationship[];
}

interface SpdxPackage {
  SPDXID: string;
  name: string;
  versionInfo: string;
  downloadLocation: string;
  filesAnalyzed: boolean;
  externalRefs: Array<{
    referenceCategory: string;
    referenceType: string;
    referenceLocator: string;
  }>;
  primaryPackagePurpose?: string;
}

interface SpdxRelationship {
  spdxElementId: string;
  relatedSpdxElement: string;
  relationshipType: string;
}

export async function generateSpdx(
  repositoryId: string,
  repoFullName: string
): Promise<SpdxDocument> {
  const deps = await listDependenciesForRepo(repositoryId);

  const rootId = "SPDXRef-DOCUMENT";
  const rootPkgId = "SPDXRef-RootPackage";

  const packages: SpdxPackage[] = [
    {
      SPDXID: rootPkgId,
      name: repoFullName,
      versionInfo: "HEAD",
      downloadLocation: `https://gluecron.com/${repoFullName}`,
      filesAnalyzed: false,
      externalRefs: [],
      primaryPackagePurpose: "APPLICATION",
    },
  ];

  const relationships: SpdxRelationship[] = [
    {
      spdxElementId: rootId,
      relatedSpdxElement: rootPkgId,
      relationshipType: "DESCRIBES",
    },
  ];

  for (let i = 0; i < deps.length; i++) {
    const dep = deps[i];
    const pkgId = `SPDXRef-Package-${i}`;
    const version = dep.versionSpec?.replace(/^[~^>=<!\s]+/, "") || "NOASSERTION";

    packages.push({
      SPDXID: pkgId,
      name: dep.name,
      versionInfo: version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: toPurl(dep),
        },
      ],
    });

    relationships.push({
      spdxElementId: rootPkgId,
      relatedSpdxElement: pkgId,
      relationshipType: dep.isDev ? "DEV_DEPENDENCY_OF" : "DEPENDENCY_OF",
    });
  }

  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: rootId,
    name: `SBOM for ${repoFullName}`,
    documentNamespace: `https://gluecron.com/spdx/${repoFullName}/${Date.now()}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ["Tool: GlueCron-SBOM-1.0"],
      licenseListVersion: "3.22",
    },
    packages,
    relationships,
  };
}

// ── CycloneDX 1.5 ──────────────────────────────────────────────────────────

interface CycloneDxBom {
  bomFormat: string;
  specVersion: string;
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    tools: Array<{ vendor: string; name: string; version: string }>;
    component: {
      type: string;
      name: string;
      version: string;
      "bom-ref": string;
    };
  };
  components: CycloneDxComponent[];
  dependencies: Array<{ ref: string; dependsOn: string[] }>;
}

interface CycloneDxComponent {
  type: string;
  name: string;
  version: string;
  purl: string;
  "bom-ref": string;
  scope?: string;
  properties?: Array<{ name: string; value: string }>;
}

export async function generateCycloneDx(
  repositoryId: string,
  repoFullName: string
): Promise<CycloneDxBom> {
  const deps = await listDependenciesForRepo(repositoryId);

  const rootRef = `pkg:gluecron/${encodeURIComponent(repoFullName)}`;
  const components: CycloneDxComponent[] = [];
  const depRefs: string[] = [];

  for (const dep of deps) {
    const purl = toPurl(dep);
    const version = dep.versionSpec?.replace(/^[~^>=<!\s]+/, "") || "unknown";

    components.push({
      type: "library",
      name: dep.name,
      version,
      purl,
      "bom-ref": purl,
      scope: dep.isDev ? "optional" : "required",
      properties: [
        { name: "gluecron:ecosystem", value: dep.ecosystem },
        { name: "gluecron:manifest", value: dep.manifestPath },
      ],
    });

    depRefs.push(purl);
  }

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: "GlueCron", name: "SBOM Generator", version: "1.0.0" }],
      component: {
        type: "application",
        name: repoFullName,
        version: "HEAD",
        "bom-ref": rootRef,
      },
    },
    components,
    dependencies: [
      { ref: rootRef, dependsOn: depRefs },
      ...components.map((c) => ({ ref: c["bom-ref"], dependsOn: [] })),
    ],
  };
}
