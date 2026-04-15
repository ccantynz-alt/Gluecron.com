/**
 * Block G4 — VS Code extension pure-helper tests.
 *
 * The extension itself depends on the `vscode` module (only available inside
 * the host), but the URL-building helpers are pure — we re-implement them
 * locally here to lock the contract. If the contract drifts in extension.ts,
 * update this file in lockstep.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Mirror of src/extension.ts — keep in sync.
function buildWebUrl(
  host: string,
  owner: string,
  repo: string,
  relPath: string,
  line?: number
): string {
  const base = `${host.replace(/\/+$/, "")}/${owner}/${repo}/blob/main/${relPath}`;
  return line ? `${base}#L${line + 1}` : base;
}

describe("vscode-extension — buildWebUrl", () => {
  it("builds a basic web URL", () => {
    expect(buildWebUrl("https://gluecron.com", "alice", "proj", "README.md")).toBe(
      "https://gluecron.com/alice/proj/blob/main/README.md"
    );
  });

  it("appends #L<n+1> when a line is supplied", () => {
    expect(
      buildWebUrl("https://gluecron.com", "alice", "proj", "src/x.ts", 41)
    ).toBe("https://gluecron.com/alice/proj/blob/main/src/x.ts#L42");
  });

  it("strips trailing slashes from the host", () => {
    expect(buildWebUrl("https://g.com///", "a", "b", "c")).toBe(
      "https://g.com/a/b/blob/main/c"
    );
  });
});

describe("vscode-extension — package.json contract", () => {
  const pkg = JSON.parse(
    readFileSync(
      join(process.cwd(), "vscode-extension/package.json"),
      "utf8"
    )
  );

  it("declares the expected commands", () => {
    const names = pkg.contributes.commands.map((c: any) => c.command);
    expect(names).toContain("gluecron.explainFile");
    expect(names).toContain("gluecron.openOnWeb");
    expect(names).toContain("gluecron.searchSemantic");
    expect(names).toContain("gluecron.generateTests");
  });

  it("declares configuration keys host + token", () => {
    const keys = Object.keys(pkg.contributes.configuration.properties);
    expect(keys).toContain("gluecron.host");
    expect(keys).toContain("gluecron.token");
  });

  it("activates onStartupFinished", () => {
    expect(pkg.activationEvents).toContain("onStartupFinished");
  });
});
