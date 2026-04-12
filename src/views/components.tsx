import type { FC } from "hono/jsx";
import { html } from "hono/html";
import type { GitCommit, GitTreeEntry, GitDiffFile } from "../git/repository";
import type { Repository } from "../db/schema";

export const RepoHeader: FC<{
  owner: string;
  repo: string;
  starCount?: number;
  starred?: boolean;
  currentUser?: string | null;
}> = ({ owner, repo, starCount, starred, currentUser }) => (
  <div class="repo-header">
    <a href={`/${owner}`} class="owner">
      {owner}
    </a>
    <span class="separator">/</span>
    <a href={`/${owner}/${repo}`} class="name">
      {repo}
    </a>
    <div class="repo-header-actions">
      {starCount !== undefined && (
        currentUser ? (
          <form method="POST" action={`/${owner}/${repo}/star`} style="display:inline">
            <button
              type="submit"
              class={`star-btn${starred ? " starred" : ""}`}
            >
              {starred ? "\u2605" : "\u2606"} {starCount}
            </button>
          </form>
        ) : (
          <span class="star-btn">
            {"\u2606"} {starCount}
          </span>
        )
      )}
    </div>
  </div>
);

export const RepoNav: FC<{
  owner: string;
  repo: string;
  active: "code" | "commits";
}> = ({ owner, repo, active }) => (
  <div class="repo-nav">
    <a href={`/${owner}/${repo}`} class={active === "code" ? "active" : ""}>
      Code
    </a>
    <a
      href={`/${owner}/${repo}/commits`}
      class={active === "commits" ? "active" : ""}
    >
      Commits
    </a>
  </div>
);

export const BranchSwitcher: FC<{
  owner: string;
  repo: string;
  currentRef: string;
  branches: string[];
  pathType: "tree" | "blob" | "commits";
  subPath?: string;
}> = ({ owner, repo, currentRef, branches, pathType, subPath }) => {
  if (branches.length <= 1) {
    return <div class="branch-selector">{currentRef}</div>;
  }

  return (
    <div class="branch-dropdown">
      <button class="branch-selector" type="button">
        {currentRef} &#9662;
      </button>
      <div class="branch-dropdown-content">
        {branches.map((branch) => {
          let href: string;
          if (pathType === "commits") {
            href = `/${owner}/${repo}/commits/${branch}`;
          } else if (subPath) {
            href = `/${owner}/${repo}/${pathType}/${branch}/${subPath}`;
          } else {
            href = `/${owner}/${repo}/tree/${branch}`;
          }
          return (
            <a
              href={href}
              class={branch === currentRef ? "active-branch" : ""}
            >
              {branch}
            </a>
          );
        })}
      </div>
    </div>
  );
};

export const Breadcrumb: FC<{
  owner: string;
  repo: string;
  ref: string;
  path: string;
}> = ({ owner, repo, ref, path }) => {
  const parts = path.split("/").filter(Boolean);
  const crumbs: { name: string; href: string }[] = [
    { name: repo, href: `/${owner}/${repo}/tree/${ref}` },
  ];
  let accumulated = "";
  for (const part of parts) {
    accumulated += (accumulated ? "/" : "") + part;
    crumbs.push({
      name: part,
      href: `/${owner}/${repo}/tree/${ref}/${accumulated}`,
    });
  }
  return (
    <div class="breadcrumb">
      {crumbs.map((crumb, i) => (
        <>
          {i > 0 && <span>/</span>}
          {i === crumbs.length - 1 ? (
            <strong>{crumb.name}</strong>
          ) : (
            <a href={crumb.href}>{crumb.name}</a>
          )}
        </>
      ))}
    </div>
  );
};

export const FileTable: FC<{
  entries: GitTreeEntry[];
  owner: string;
  repo: string;
  ref: string;
  path: string;
}> = ({ entries, owner, repo, ref, path }) => (
  <table class="file-table">
    <tbody>
      {entries.map((entry) => {
        const fullPath = path ? `${path}/${entry.name}` : entry.name;
        const href =
          entry.type === "tree"
            ? `/${owner}/${repo}/tree/${ref}/${fullPath}`
            : `/${owner}/${repo}/blob/${ref}/${fullPath}`;
        return (
          <tr>
            <td class="file-icon">
              {entry.type === "tree" ? "\u{1F4C1}" : "\u{1F4C4}"}
            </td>
            <td class="file-name">
              <a href={href}>{entry.name}</a>
            </td>
            <td style="text-align: right; color: var(--text-muted); font-size: 13px;">
              {entry.size !== undefined ? formatSize(entry.size) : ""}
            </td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

export const HighlightedCode: FC<{
  highlightedHtml: string;
  lineCount: number;
}> = ({ highlightedHtml, lineCount }) => {
  const lineNums = Array.from({ length: lineCount }, (_, i) => i + 1);
  return (
    <div class="blob-code">
      <table>
        <tbody>
          <tr>
            <td class="line-num" style="vertical-align: top; padding-top: 0; padding-bottom: 0">
              <pre style="margin: 0; line-height: 1.6; font-size: 13px">
                {lineNums.map((n) => (
                  <>
                    <span>{n}</span>
                    {"\n"}
                  </>
                ))}
              </pre>
            </td>
            <td class="line-content" style="vertical-align: top; padding-top: 0; padding-bottom: 0">
              <pre style="margin: 0; line-height: 1.6; font-size: 13px">{html([highlightedHtml] as unknown as TemplateStringsArray)}</pre>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

export const PlainCode: FC<{ lines: string[] }> = ({ lines }) => (
  <div class="blob-code">
    <table>
      <tbody>
        {lines.map((line, i) => (
          <tr>
            <td class="line-num">{i + 1}</td>
            <td class="line-content">{line}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const CommitList: FC<{
  commits: GitCommit[];
  owner: string;
  repo: string;
}> = ({ commits, owner, repo }) => (
  <div class="commit-list">
    {commits.map((commit) => (
      <div class="commit-item">
        <div>
          <div class="commit-message">
            <a href={`/${owner}/${repo}/commit/${commit.sha}`}>
              {commit.message}
            </a>
          </div>
          <div class="commit-meta">
            {commit.author} committed {formatRelativeDate(commit.date)}
          </div>
        </div>
        <a
          href={`/${owner}/${repo}/commit/${commit.sha}`}
          class="commit-sha"
        >
          {commit.sha.slice(0, 7)}
        </a>
      </div>
    ))}
  </div>
);

export const DiffView: FC<{ raw: string; files: GitDiffFile[] }> = ({
  raw,
  files,
}) => {
  const sections = parseDiff(raw);

  return (
    <div class="diff-view">
      <div style="margin-bottom: 16px; font-size: 14px; color: var(--text-muted);">
        Showing{" "}
        <strong style="color: var(--text)">{files.length}</strong> changed
        file{files.length !== 1 ? "s" : ""} with{" "}
        <span class="stat-add">
          +{files.reduce((s, f) => s + f.additions, 0)}
        </span>{" "}
        and{" "}
        <span class="stat-del">
          -{files.reduce((s, f) => s + f.deletions, 0)}
        </span>
      </div>
      {sections.map((section) => (
        <div class="diff-file">
          <div class="diff-file-header">{section.path}</div>
          <div class="diff-content">
            {section.lines.map((line) => {
              let cls = "line";
              if (line.startsWith("+")) cls += " line-add";
              else if (line.startsWith("-")) cls += " line-del";
              else if (line.startsWith("@@")) cls += " line-hunk";
              return <span class={cls}>{line + "\n"}</span>;
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

export const RepoCard: FC<{ repo: Repository; ownerName: string }> = ({
  repo,
  ownerName,
}) => (
  <div class="card">
    <h3>
      <a href={`/${ownerName}/${repo.name}`}>{repo.name}</a>
    </h3>
    {repo.description && <p>{repo.description}</p>}
    <div class="card-meta">
      {repo.isPrivate && <span class="badge">Private</span>}
      <span>{"\u2606"} {repo.starCount}</span>
      {repo.pushedAt && (
        <span>Updated {formatRelativeDate(repo.pushedAt.toString())}</span>
      )}
    </div>
  </div>
);

function parseDiff(raw: string): Array<{ path: string; lines: string[] }> {
  const sections: Array<{ path: string; lines: string[] }> = [];
  const diffRegex = /^diff --git a\/(.+?) b\/.+$/;
  let current: { path: string; lines: string[] } | null = null;

  for (const line of raw.split("\n")) {
    const match = line.match(diffRegex);
    if (match) {
      if (current) sections.push(current);
      current = { path: match[1], lines: [] };
      continue;
    }
    if (current && !line.startsWith("diff --git")) {
      if (
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file") ||
        line.startsWith("old mode") ||
        line.startsWith("new mode")
      ) {
        continue;
      }
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24)
    return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
