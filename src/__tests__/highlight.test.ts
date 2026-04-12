import { describe, it, expect } from "bun:test";
import { highlightCode } from "../lib/highlight";

describe("syntax highlighting", () => {
  it("should highlight TypeScript code", () => {
    const code = 'const x: number = 42;\nconsole.log(x);';
    const result = highlightCode(code, "index.ts");

    expect(result.language).toBe("typescript");
    expect(result.html).toContain("hljs-");
    expect(result.html).toContain("42");
  });

  it("should highlight Python code", () => {
    const code = 'def hello():\n    print("hello world")';
    const result = highlightCode(code, "main.py");

    expect(result.language).toBe("python");
    expect(result.html).toContain("hljs-");
  });

  it("should highlight JSON", () => {
    const code = '{"key": "value", "count": 42}';
    const result = highlightCode(code, "config.json");

    expect(result.language).toBe("json");
    expect(result.html).toContain("hljs-");
  });

  it("should highlight Go code", () => {
    const code = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n}';
    const result = highlightCode(code, "main.go");

    expect(result.language).toBe("go");
    expect(result.html).toContain("hljs-");
  });

  it("should highlight Rust code", () => {
    const code = 'fn main() {\n    println!("hello");\n}';
    const result = highlightCode(code, "main.rs");

    expect(result.language).toBe("rust");
    expect(result.html).toContain("hljs-");
  });

  it("should handle unknown extensions gracefully", () => {
    const code = "just some plain text";
    const result = highlightCode(code, "readme.xyz");

    // Should return escaped HTML
    expect(result.html).toContain("just some plain text");
  });

  it("should escape HTML in plain text", () => {
    const code = '<script>alert("xss")</script>';
    const result = highlightCode(code, "file.xyz");

    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });

  it("should highlight CSS", () => {
    const code = "body { color: red; font-size: 14px; }";
    const result = highlightCode(code, "style.css");

    expect(result.language).toBe("css");
    expect(result.html).toContain("hljs-");
  });

  it("should highlight SQL", () => {
    const code = "SELECT * FROM users WHERE id = 1;";
    const result = highlightCode(code, "query.sql");

    expect(result.language).toBe("sql");
    expect(result.html).toContain("hljs-");
  });

  it("should highlight Dockerfile", () => {
    const code = "FROM node:20\nRUN npm install\nCMD [\"node\", \"index.js\"]";
    const result = highlightCode(code, "Dockerfile");

    // Dockerfile extension is lowercase 'dockerfile'
    expect(result.html).toContain("node");
  });
});
