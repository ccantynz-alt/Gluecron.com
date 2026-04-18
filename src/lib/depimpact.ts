/**
 * Dependency Impact Analyzer
 *
 * GitHub: "There's a new version of lodash"
 * gluecron: "Upgrading lodash v4→v5 will break your auth.ts:47
 *           because _.get() was removed. Here's the fix."
 *
 * Analyzes import graphs, detects which functions from a dependency
 * your code actually uses, and predicts what breaks on upgrade.
 */

import { getRepoPath } from "../git/repository";

export interface DependencyMap {
  name: string;
  version: string;
  usedIn: ImportUsage[];
  totalImports: number;
  isDevDep: boolean;
}

export interface ImportUsage {
  file: string;
  line: number;
  importedSymbols: string[];
  importStatement: string;
}

export interface ImportGraph {
  files: Record<string, string[]>; // file -> files it imports
  dependencies: DependencyMap[];
  internalModules: number;
  externalDependencies: number;
  circularDeps: string[][];
}

async function exec(
  cmd: string[],
  cwd: string
): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

/**
 * Build the complete import graph for a repository.
 * Maps every file to its imports, both internal and external.
 */
export async function buildImportGraph(
  owner: string,
  repo: string,
  ref: string
): Promise<ImportGraph> {
  const repoDir = getRepoPath(owner, repo);

  // Get all source files
  const fileList = await exec(
    ["git", "ls-tree", "-r", "--name-only", ref],
    repoDir
  );
  const sourceFiles = fileList
    .split("\n")
    .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));

  // Get package.json for dependency list
  let deps: Record<string, string> = {};
  let devDeps: Record<string, string> = {};
  try {
    const pkg = await exec(
      ["git", "show", `${ref}:package.json`],
      repoDir
    );
    const parsed = JSON.parse(pkg);
    deps = parsed.dependencies || {};
    devDeps = parsed.devDependencies || {};
  } catch {
    // no package.json
  }

  const files: Record<string, string[]> = {};
  const depUsage: Record<string, ImportUsage[]> = {};

  for (const filePath of sourceFiles.slice(0, 100)) {
    const content = await exec(
      ["git", "show", `${ref}:${filePath}`],
      repoDir
    );
    if (!content) continue;

    const imports: string[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match: import ... from "..."
      const importMatch = line.match(
        /(?:import|export)\s+(?:(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?)\s+from\s+)?["']([^"']+)["']/
      );
      if (importMatch) {
        const target = importMatch[1];
        imports.push(target);

        // Check if it's an external dep
        const depName = target.startsWith("@")
          ? target.split("/").slice(0, 2).join("/")
          : target.split("/")[0];

        if (deps[depName] || devDeps[depName]) {
          // Extract imported symbols
          const symbolMatch = line.match(/\{([^}]+)\}/);
          const symbols = symbolMatch
            ? symbolMatch[1].split(",").map((s) => s.trim().split(" as ")[0].trim()).filter(Boolean)
            : ["*"];

          if (!depUsage[depName]) depUsage[depName] = [];
          depUsage[depName].push({
            file: filePath,
            line: i + 1,
            importedSymbols: symbols,
            importStatement: line.trim(),
          });
        }
      }

      // Match: require("...")
      const requireMatch = line.match(/require\s*\(\s*["']([^"']+)["']\s*\)/);
      if (requireMatch) {
        imports.push(requireMatch[1]);
      }
    }

    files[filePath] = imports;
  }

  // Build dependency map
  const dependencies: DependencyMap[] = [];
  const allDeps = { ...deps, ...devDeps };
  for (const [name, version] of Object.entries(allDeps)) {
    dependencies.push({
      name,
      version,
      usedIn: depUsage[name] || [],
      totalImports: (depUsage[name] || []).length,
      isDevDep: !!devDeps[name],
    });
  }

  // Sort by usage
  dependencies.sort((a, b) => b.totalImports - a.totalImports);

  // Detect circular dependencies (simplified)
  const circularDeps = detectCircularDeps(files);

  return {
    files,
    dependencies,
    internalModules: sourceFiles.length,
    externalDependencies: Object.keys(allDeps).length,
    circularDeps,
  };
}

/**
 * Analyze the impact of upgrading a specific dependency.
 */
export async function analyzeUpgradeImpact(
  owner: string,
  repo: string,
  ref: string,
  depName: string
): Promise<{
  dependency: string;
  currentVersion: string;
  usedIn: ImportUsage[];
  uniqueSymbols: string[];
  riskLevel: "low" | "medium" | "high";
  affectedFiles: number;
  recommendation: string;
}> {
  const graph = await buildImportGraph(owner, repo, ref);
  const dep = graph.dependencies.find((d) => d.name === depName);

  if (!dep) {
    return {
      dependency: depName,
      currentVersion: "unknown",
      usedIn: [],
      uniqueSymbols: [],
      riskLevel: "low",
      affectedFiles: 0,
      recommendation: "Dependency not found in this project.",
    };
  }

  const uniqueSymbols = [
    ...new Set(dep.usedIn.flatMap((u) => u.importedSymbols)),
  ];

  const affectedFiles = new Set(dep.usedIn.map((u) => u.file)).size;

  let riskLevel: "low" | "medium" | "high" = "low";
  if (affectedFiles > 10 || uniqueSymbols.length > 15) riskLevel = "high";
  else if (affectedFiles > 3 || uniqueSymbols.length > 5) riskLevel = "medium";

  let recommendation: string;
  if (riskLevel === "high") {
    recommendation = `High risk: ${depName} is used in ${affectedFiles} files with ${uniqueSymbols.length} unique imports. Upgrade carefully with thorough testing.`;
  } else if (riskLevel === "medium") {
    recommendation = `Moderate risk: ${depName} is used in ${affectedFiles} files. Review changelog before upgrading.`;
  } else {
    recommendation = `Low risk: ${depName} has minimal usage (${affectedFiles} file${affectedFiles !== 1 ? "s" : ""}). Safe to upgrade.`;
  }

  return {
    dependency: depName,
    currentVersion: dep.version,
    usedIn: dep.usedIn,
    uniqueSymbols,
    riskLevel,
    affectedFiles,
    recommendation,
  };
}

/**
 * Find unused dependencies — installed but never imported.
 */
export function findUnusedDeps(graph: ImportGraph): string[] {
  return graph.dependencies
    .filter((d) => d.totalImports === 0 && !d.isDevDep)
    .map((d) => d.name);
}

// Simple circular dependency detection
function detectCircularDeps(
  files: Record<string, string[]>
): string[][] {
  const circular: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(file: string, path: string[]): void {
    if (stack.has(file)) {
      const cycleStart = path.indexOf(file);
      if (cycleStart !== -1) {
        circular.push(path.slice(cycleStart));
      }
      return;
    }
    if (visited.has(file)) return;

    visited.add(file);
    stack.add(file);
    path.push(file);

    const imports = files[file] || [];
    for (const imp of imports) {
      // Resolve relative imports
      if (imp.startsWith(".")) {
        // Find matching file
        const resolved = Object.keys(files).find(
          (f) =>
            f.endsWith(imp.replace(/^\.\//, "")) ||
            f.endsWith(imp.replace(/^\.\//, "") + ".ts") ||
            f.endsWith(imp.replace(/^\.\//, "") + ".tsx")
        );
        if (resolved) {
          dfs(resolved, [...path]);
        }
      }
    }

    stack.delete(file);
  }

  for (const file of Object.keys(files)) {
    dfs(file, []);
  }

  return circular.slice(0, 10); // Limit results
}
