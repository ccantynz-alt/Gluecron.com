/**
 * Legal pages — Terms, Privacy, AUP served from the website.
 */

import { Hono } from "hono";
import { readFileSync } from "fs";
import { join } from "path";
import { Layout } from "../views/layout";
import { renderMarkdown, markdownCss } from "../lib/markdown";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { html } from "hono/html";

const legal = new Hono<AuthEnv>();

legal.use("*", softAuth);

function serveLegalPage(title: string, filename: string) {
  return async (c: any) => {
    const user = c.get("user");
    let content: string;
    try {
      content = readFileSync(
        join(process.cwd(), "legal", filename),
        "utf-8"
      );
    } catch {
      content = `# ${title}\n\nThis page is being prepared. Check back soon.`;
    }

    const rendered = renderMarkdown(content);

    return c.html(
      <Layout title={title} user={user}>
        <style>{markdownCss}</style>
        <div class="markdown-body" style="max-width: 800px; margin: 0 auto">
          {html([rendered] as unknown as TemplateStringsArray)}
        </div>
      </Layout>
    );
  };
}

legal.get("/terms", serveLegalPage("Terms of Service", "TERMS.md"));
legal.get("/privacy", serveLegalPage("Privacy Policy", "PRIVACY.md"));
legal.get("/acceptable-use", serveLegalPage("Acceptable Use Policy", "AUP.md"));

export default legal;
