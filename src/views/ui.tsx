/**
 * Core UI Component Library — gluecron design system.
 *
 * Pure components. No raw HTML in routes. Every visual element
 * is a composable, typed, reusable component.
 */

import type { FC, PropsWithChildren } from "hono/jsx";
import { html } from "hono/html";

// ─── Primitive Components ───────────────────────────────────────────────────

/** Flex container with gap and alignment */
export const Flex: FC<
  PropsWithChildren<{
    direction?: "row" | "column";
    gap?: number;
    align?: string;
    justify?: string;
    wrap?: boolean;
    class?: string;
    style?: string;
  }>
> = ({ children, direction = "row", gap = 0, align, justify, wrap, class: cls, style }) => (
  <div
    class={cls || ""}
    style={`display:flex;flex-direction:${direction};${gap ? `gap:${gap}px;` : ""}${align ? `align-items:${align};` : ""}${justify ? `justify-content:${justify};` : ""}${wrap ? "flex-wrap:wrap;" : ""}${style || ""}`}
  >
    {children}
  </div>
);

/** Grid container */
export const Grid: FC<
  PropsWithChildren<{ cols?: string; gap?: number; class?: string }>
> = ({ children, cols = "repeat(auto-fill, minmax(340px, 1fr))", gap = 16, class: cls }) => (
  <div class={cls || "card-grid"} style={`display:grid;grid-template-columns:${cols};gap:${gap}px;`}>
    {children}
  </div>
);

/** Spacer element */
export const Spacer: FC<{ size?: number }> = ({ size = 16 }) => (
  <div style={`height:${size}px`} />
);

/** Text with semantic styling */
export const Text: FC<
  PropsWithChildren<{
    size?: number;
    color?: string;
    weight?: number | string;
    mono?: boolean;
    muted?: boolean;
    style?: string;
  }>
> = ({ children, size, color, weight, mono, muted, style }) => (
  <span
    style={`${size ? `font-size:${size}px;` : ""}${color ? `color:${color};` : ""}${weight ? `font-weight:${weight};` : ""}${mono ? "font-family:var(--font-mono);" : ""}${muted ? "color:var(--text-muted);" : ""}${style || ""}`}
  >
    {children}
  </span>
);

// ─── Buttons ────────────────────────────────────────────────────────────────

export const Button: FC<
  PropsWithChildren<{
    variant?: "default" | "primary" | "danger" | "success" | "ghost";
    size?: "sm" | "md" | "lg";
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    formaction?: string;
    class?: string;
  }>
> = ({ children, variant = "default", size = "md", type = "button", disabled, formaction, class: cls }: any) => {
  const variantCls =
    variant === "primary" ? " btn-primary" :
    variant === "danger" ? " btn-danger" :
    variant === "success" ? " btn-success" :
    variant === "ghost" ? " btn-ghost" : "";
  const sizeCls = size === "sm" ? " btn-sm" : size === "lg" ? " btn-lg" : "";
  return (
    <button
      type={type}
      class={`btn${variantCls}${sizeCls}${cls ? ` ${cls}` : ""}`}
      disabled={disabled}
      formaction={formaction}
    >
      {children}
    </button>
  );
};

export const LinkButton: FC<
  PropsWithChildren<{
    href: string;
    variant?: "default" | "primary" | "danger" | "success";
    size?: "sm" | "md";
  }>
> = ({ children, href, variant = "default", size = "md" }) => {
  const variantCls = variant === "primary" ? " btn-primary" : variant === "danger" ? " btn-danger" : variant === "success" ? " btn-success" : "";
  const sizeCls = size === "sm" ? " btn-sm" : "";
  return (
    <a href={href} class={`btn${variantCls}${sizeCls}`}>
      {children}
    </a>
  );
};

// ─── Forms ──────────────────────────────────────────────────────────────────

export const Form: FC<
  PropsWithChildren<{
    action: string;
    method?: string;
    csrfToken?: string;
    class?: string;
  }>
> = ({ children, action, method = "POST", csrfToken, class: cls }) => (
  <form method={method.toLowerCase() as any} action={action} class={cls || ""}>
    {csrfToken && <input type="hidden" name="_csrf" value={csrfToken} />}
    {children}
  </form>
);

export const FormGroup: FC<
  PropsWithChildren<{ label?: string; htmlFor?: string; hint?: string }>
> = ({ children, label, htmlFor, hint }) => (
  <div class="form-group">
    {label && <label for={htmlFor}>{label}</label>}
    {children}
    {hint && <Text size={12} muted>{hint}</Text>}
  </div>
);

export const Input: FC<{
  name: string;
  type?: string;
  id?: string;
  value?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  pattern?: string;
  autocomplete?: string;
  autofocus?: boolean;
  minLength?: number;
  maxLength?: number;
  style?: string;
}> = (props) => (
  <input
    type={props.type || "text"}
    id={props.id || props.name}
    name={props.name}
    value={props.value}
    placeholder={props.placeholder}
    required={props.required}
    disabled={props.disabled}
    pattern={props.pattern}
    autocomplete={props.autocomplete}
    autofocus={props.autofocus}
    minLength={props.minLength}
    maxLength={props.maxLength}
    class={props.disabled ? "input-disabled" : ""}
    style={props.style}
  />
);

export const TextArea: FC<{
  name: string;
  id?: string;
  rows?: number;
  placeholder?: string;
  required?: boolean;
  value?: string;
  mono?: boolean;
  style?: string;
}> = (props) => (
  <textarea
    id={props.id || props.name}
    name={props.name}
    rows={props.rows || 6}
    placeholder={props.placeholder}
    required={props.required}
    style={`${props.mono ? "font-family:var(--font-mono);font-size:13px;" : ""}${props.style || ""}`}
  >
    {props.value}
  </textarea>
);

export const Select: FC<
  PropsWithChildren<{ name: string; id?: string; value?: string }>
> = ({ children, name, id, value }) => (
  <select id={id || name} name={name} value={value}>
    {children}
  </select>
);

// ─── Feedback Components ────────────────────────────────────────────────────

export const Alert: FC<
  PropsWithChildren<{ variant: "error" | "success" | "warning" | "info" }>
> = ({ children, variant }) => {
  const cls =
    variant === "error" ? "auth-error" :
    variant === "success" ? "auth-success" :
    variant === "warning" ? "alert-warning" :
    "alert-info";
  return <div class={cls}>{children}</div>;
};

export const EmptyState: FC<
  PropsWithChildren<{ title?: string; icon?: string }>
> = ({ children, title, icon }) => (
  <div class="empty-state">
    {icon && <div style="font-size:48px;margin-bottom:12px">{icon}</div>}
    {title && <h2>{title}</h2>}
    {children}
  </div>
);

export const Badge: FC<
  PropsWithChildren<{
    variant?: "default" | "open" | "closed" | "merged" | "success" | "danger" | "warning";
    style?: string;
  }>
> = ({ children, variant = "default", style }) => {
  const cls =
    variant === "open" ? "badge-open" :
    variant === "closed" ? "badge-closed" :
    variant === "merged" ? "badge-merged" :
    variant === "success" ? "badge-success" :
    variant === "danger" ? "badge-danger" :
    variant === "warning" ? "badge-warning" :
    "badge";
  return <span class={`issue-badge ${cls}`} style={style}>{children}</span>;
};

// ─── Card Components ────────────────────────────────────────────────────────

export const Card: FC<PropsWithChildren<{ class?: string; style?: string }>> = ({
  children,
  class: cls,
  style,
}) => (
  <div class={`card${cls ? ` ${cls}` : ""}`} style={style}>
    {children}
  </div>
);

export const CardMeta: FC<PropsWithChildren> = ({ children }) => (
  <div class="card-meta">{children}</div>
);

// ─── Navigation Components ──────────────────────────────────────────────────

export const TabNav: FC<{
  tabs: Array<{ label: string; href: string; active?: boolean; count?: number }>;
}> = ({ tabs }) => (
  <div class="repo-nav">
    {tabs.map((tab) => (
      <a href={tab.href} class={tab.active ? "active" : ""}>
        {tab.label}
        {tab.count !== undefined && (
          <span class="tab-count">{tab.count}</span>
        )}
      </a>
    ))}
  </div>
);

export const FilterTabs: FC<{
  tabs: Array<{ label: string; href: string; active?: boolean }>;
}> = ({ tabs }) => (
  <div class="issue-tabs">
    {tabs.map((tab) => (
      <a href={tab.href} class={tab.active ? "active" : ""}>
        {tab.label}
      </a>
    ))}
  </div>
);

// ─── Page Layout Components ─────────────────────────────────────────────────

export const PageHeader: FC<
  PropsWithChildren<{ title: string; actions?: any }>
> = ({ title, actions, children }) => (
  <Flex justify="space-between" align="center" style="margin-bottom:20px">
    <h2>{title}</h2>
    {actions}
    {children}
  </Flex>
);

export const Section: FC<
  PropsWithChildren<{ title?: string; style?: string }>
> = ({ children, title, style }) => (
  <div style={`margin-bottom:24px;${style || ""}`}>
    {title && <h3 style="margin-bottom:12px">{title}</h3>}
    {children}
  </div>
);

export const Container: FC<
  PropsWithChildren<{ maxWidth?: number; class?: string }>
> = ({ children, maxWidth = 800, class: cls }) => (
  <div class={cls || ""} style={`max-width:${maxWidth}px`}>
    {children}
  </div>
);

// ─── Data Display Components ────────────────────────────────────────────────

export const StatGroup: FC<{
  stats: Array<{ label: string; value: string | number; color?: string }>;
}> = ({ stats }) => (
  <Flex gap={24} wrap>
    {stats.map((stat) => (
      <div>
        <div style={`font-size:24px;font-weight:700;${stat.color ? `color:${stat.color};` : ""}`}>
          {stat.value}
        </div>
        <Text size={13} muted>{stat.label}</Text>
      </div>
    ))}
  </Flex>
);

export const KeyValue: FC<{ label: string; value: string | number }> = ({
  label,
  value,
}) => (
  <Flex justify="space-between" align="center" style="padding:8px 0;border-bottom:1px solid var(--border)">
    <Text size={14} muted>{label}</Text>
    <Text size={14}>{String(value)}</Text>
  </Flex>
);

export const DataTable: FC<{
  headers: string[];
  rows: Array<Array<string | any>>;
  class?: string;
}> = ({ headers, rows, class: cls }) => (
  <table class={cls || "file-table"}>
    <thead>
      <tr>
        {headers.map((h) => (
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:var(--text-muted);border-bottom:1px solid var(--border)">{h}</th>
        ))}
      </tr>
    </thead>
    <tbody>
      {rows.map((row) => (
        <tr>
          {row.map((cell) => (
            <td style="padding:8px 16px;font-size:14px">{cell}</td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

// ─── List Components ────────────────────────────────────────────────────────

export const ListItem: FC<
  PropsWithChildren<{ style?: string }>
> = ({ children, style }) => (
  <div class="issue-item" style={style}>
    {children}
  </div>
);

export const List: FC<PropsWithChildren<{ class?: string }>> = ({ children, class: cls }) => (
  <div class={cls || "issue-list"}>
    {children}
  </div>
);

// ─── Code Display ───────────────────────────────────────────────────────────

export const CodeBlock: FC<{
  code: string;
  language?: string;
  showLineNumbers?: boolean;
}> = ({ code, showLineNumbers = true }) => {
  const lines = code.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return (
    <div class="blob-code">
      <table>
        <tbody>
          {lines.map((line, i) => (
            <tr>
              {showLineNumbers && <td class="line-num">{i + 1}</td>}
              <td class="line-content">{line}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const InlineCode: FC<PropsWithChildren> = ({ children }) => (
  <code style="font-size:12px;background:var(--bg-tertiary);padding:2px 6px;border-radius:3px;font-family:var(--font-mono)">
    {children}
  </code>
);

export const CopyBlock: FC<{
  text: string;
  label?: string;
}> = ({ text, label }) => (
  <Flex gap={8} align="center" class="copy-block">
    {label && <Text size={13} muted>{label}</Text>}
    <code
      style="flex:1;padding:8px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);font-family:var(--font-mono);font-size:13px;overflow-x:auto"
      data-copy={text}
    >
      {text}
    </code>
    <button
      type="button"
      class="btn btn-sm copy-btn"
      data-clipboard={text}
      title="Copy to clipboard"
    >
      Copy
    </button>
  </Flex>
);

// ─── Notification Components ────────────────────────────────────────────────

export const NotificationBell: FC<{ count: number; href: string }> = ({
  count,
  href,
}) => (
  <a href={href} class="notification-bell" title="Notifications">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 16a2 2 0 002-2H6a2 2 0 002 2zM8 1.918l-.797.161A4.002 4.002 0 004 6c0 .628-.134 2.197-.459 3.742-.16.767-.376 1.566-.663 2.258h10.244c-.287-.692-.502-1.49-.663-2.258C12.134 8.197 12 6.628 12 6a4.002 4.002 0 00-3.203-3.92L8 1.917zM14.22 12c.223.447.481.801.78 1H1c.299-.199.557-.553.78-1C2.68 10.2 3 6.88 3 6c0-2.42 1.72-4.44 4.005-4.901a1 1 0 111.99 0A5.002 5.002 0 0113 6c0 .88.32 4.2 1.22 6z" />
    </svg>
    {count > 0 && <span class="notification-count">{count > 99 ? "99+" : count}</span>}
  </a>
);

// ─── Profile Components ─────────────────────────────────────────────────────

export const Avatar: FC<{
  name: string;
  url?: string;
  size?: number;
}> = ({ name, url, size = 40 }) => {
  if (url) {
    return (
      <img
        src={url}
        alt={name}
        style={`width:${size}px;height:${size}px;border-radius:50%;object-fit:cover`}
        loading="lazy"
      />
    );
  }
  return (
    <div
      class="user-avatar"
      style={`width:${size}px;height:${size}px;font-size:${size * 0.4}px`}
    >
      {name[0].toUpperCase()}
    </div>
  );
};

export const UserCard: FC<{
  username: string;
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
}> = ({ username, displayName, bio, avatarUrl }) => (
  <div class="user-profile">
    <Avatar name={displayName || username} url={avatarUrl || undefined} size={96} />
    <div class="user-info">
      <h2>{displayName || username}</h2>
      <div class="username">@{username}</div>
      {bio && <div class="bio">{bio}</div>}
    </div>
  </div>
);

// ─── Onboarding Components ──────────────────────────────────────────────────

export const StepIndicator: FC<{
  steps: Array<{ label: string; completed: boolean; active: boolean }>;
}> = ({ steps }) => (
  <Flex gap={0} align="center" class="step-indicator">
    {steps.map((step, i) => (
      <>
        {i > 0 && <div class="step-line" data-completed={step.completed || steps[i - 1]?.completed ? "true" : "false"} />}
        <Flex direction="column" align="center" gap={4}>
          <div
            class={`step-circle${step.completed ? " step-completed" : ""}${step.active ? " step-active" : ""}`}
          >
            {step.completed ? "\u2713" : i + 1}
          </div>
          <Text size={12} muted={!step.active}>{step.label}</Text>
        </Flex>
      </>
    ))}
  </Flex>
);

export const WelcomeHero: FC<
  PropsWithChildren<{ title: string; subtitle?: string }>
> = ({ children, title, subtitle }) => (
  <div class="welcome-hero">
    <h1>{title}</h1>
    {subtitle && <p class="hero-subtitle">{subtitle}</p>}
    {children}
  </div>
);

export const FeatureCard: FC<{
  icon: string;
  title: string;
  description: string;
  href?: string;
}> = ({ icon, title, description, href }) => {
  const content = (
    <Card class="feature-card">
      <div class="feature-icon">{icon}</div>
      <h3>{title}</h3>
      <Text size={13} muted>{description}</Text>
    </Card>
  );
  return href ? <a href={href} style="text-decoration:none">{content}</a> : content;
};

// ─── Search Components ──────────────────────────────────────────────────────

export const SearchBar: FC<{
  action: string;
  value?: string;
  placeholder?: string;
  name?: string;
}> = ({ action, value, placeholder = "Search...", name = "q" }) => (
  <form method="get" action={action} style="margin-bottom:20px">
    <Flex gap={8}>
      <input
        type="text"
        name={name}
        value={value}
        placeholder={placeholder}
        class="search-input"
        autocomplete="off"
      />
      <Button type="submit" variant="primary">Search</Button>
    </Flex>
  </form>
);

export const SearchResults: FC<{
  query: string;
  count: number;
}> = ({ query, count }) => (
  <p style="font-size:14px;color:var(--text-muted);margin-bottom:16px">
    {count} result{count !== 1 ? "s" : ""} for{" "}
    <strong style="color:var(--text)">"{query}"</strong>
  </p>
);

// ─── Markdown Content ───────────────────────────────────────────────────────

export const MarkdownContent: FC<{ html: string }> = ({ html: htmlContent }) => (
  <div class="markdown-body">
    {html([htmlContent] as unknown as TemplateStringsArray)}
  </div>
);

// ─── Comment Components ─────────────────────────────────────────────────────

export const CommentBox: FC<{
  author: string;
  date: string | Date;
  body: string;
  isAi?: boolean;
}> = ({ author, date, body, isAi }) => {
  const dateStr = typeof date === "string" ? date : date.toISOString();
  return (
    <div class={`issue-comment-box${isAi ? " ai-review" : ""}`}>
      <div class="comment-header">
        <Flex gap={8} align="center">
          <strong>{author}</strong>
          {isAi && <Badge variant="default" style="font-size:11px">AI Review</Badge>}
          <Text size={13} muted>commented {formatRelative(dateStr)}</Text>
        </Flex>
      </div>
      <MarkdownContent html={body} />
    </div>
  );
};

export const CommentForm: FC<{
  action: string;
  csrfToken?: string;
  placeholder?: string;
  submitLabel?: string;
  extraActions?: any;
}> = ({ action, csrfToken, placeholder = "Leave a comment... (Markdown supported)", submitLabel = "Comment", extraActions }) => (
  <div style="margin-top:20px">
    <Form action={action} csrfToken={csrfToken}>
      <FormGroup>
        <div class="comment-editor">
          <div class="editor-tabs">
            <button type="button" class="editor-tab active" data-tab="write">Write</button>
            <button type="button" class="editor-tab" data-tab="preview">Preview</button>
          </div>
          <TextArea
            name="body"
            rows={6}
            required
            placeholder={placeholder}
            mono
          />
          <div class="editor-preview" style="display:none" />
        </div>
      </FormGroup>
      <Flex gap={8}>
        <Button type="submit" variant="primary">{submitLabel}</Button>
        {extraActions}
      </Flex>
    </Form>
  </div>
);

// ─── Tooltip Component ──────────────────────────────────────────────────────

export const Tooltip: FC<PropsWithChildren<{ text: string }>> = ({
  children,
  text,
}) => (
  <span class="tooltip-wrapper" data-tooltip={text}>
    {children}
  </span>
);

// ─── Loading & Progress ─────────────────────────────────────────────────────

export const Spinner: FC<{ size?: number }> = ({ size = 20 }) => (
  <div
    class="spinner"
    style={`width:${size}px;height:${size}px`}
  />
);

export const ProgressBar: FC<{ value: number; max?: number; color?: string }> = ({
  value,
  max = 100,
  color,
}) => (
  <div class="progress-bar">
    <div
      class="progress-fill"
      style={`width:${(value / max) * 100}%;${color ? `background:${color};` : ""}`}
    />
  </div>
);

// ─── Keyboard Shortcut Hint ─────────────────────────────────────────────────

export const Kbd: FC<PropsWithChildren> = ({ children }) => (
  <kbd class="kbd">{children}</kbd>
);

// ─── Utility Functions ──────────────────────────────────────────────────────

export function formatRelative(dateStr: string | Date): string {
  const date = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
