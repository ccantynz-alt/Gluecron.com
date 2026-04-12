/**
 * Git Smart HTTP Protocol implementation.
 *
 * Handles the server side of:
 *   - GET  /:owner/:repo.git/info/refs?service=git-upload-pack
 *   - GET  /:owner/:repo.git/info/refs?service=git-receive-pack
 *   - POST /:owner/:repo.git/git-upload-pack
 *   - POST /:owner/:repo.git/git-receive-pack
 *
 * Reference: https://git-scm.com/docs/http-protocol
 */

import { getRepoPath } from "./repository";

function pktLine(data: string): string {
  const len = (data.length + 4).toString(16).padStart(4, "0");
  return `${len}${data}`;
}

function pktFlush(): string {
  return "0000";
}

export function infoRefsResponse(
  service: string,
  advertise: string
): Response {
  const body = pktLine(`# service=${service}\n`) + pktFlush() + advertise;

  return new Response(body, {
    headers: {
      "Content-Type": `application/x-${service}-advertisement`,
      "Cache-Control": "no-cache",
    },
  });
}

export async function getInfoRefs(
  owner: string,
  repo: string,
  service: string
): Promise<Response> {
  const repoDir = getRepoPath(owner, repo);
  const proc = Bun.spawn([service, "--stateless-rpc", "--advertise-refs", repoDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return infoRefsResponse(service, stdout);
}

export async function serviceRpc(
  owner: string,
  repo: string,
  service: string,
  body: ReadableStream<Uint8Array> | ArrayBuffer | null
): Promise<Response> {
  const repoDir = getRepoPath(owner, repo);
  const inputBytes = body
    ? body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : new Uint8Array(await new Response(body).arrayBuffer())
    : new Uint8Array();

  const proc = Bun.spawn([service, "--stateless-rpc", repoDir], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(inputBytes);
  proc.stdin.end();

  const stdout = await new Response(proc.stdout).arrayBuffer();
  await proc.exited;

  return new Response(stdout, {
    headers: {
      "Content-Type": `application/x-${service}-result`,
      "Cache-Control": "no-cache",
    },
  });
}
