/**
 * BLOCK N2 — systemd_notify(READY=1) helper tests.
 *
 * Covers the three guarantees the helper makes:
 *   1. No-op when NOTIFY_SOCKET is unset (dev / non-systemd hosts).
 *   2. When NOTIFY_SOCKET IS set, attempts to open a datagram socket and
 *      send "READY=1\n" to it.
 *   3. Never throws — boot path must be safe even if the socket open fails.
 */

import { describe, expect, it } from "bun:test";
import { notifySystemdReady } from "../lib/systemd-notify";

describe("notifySystemdReady", () => {
  it("is a no-op when NOTIFY_SOCKET is unset", async () => {
    let opened = false;
    const opener = async () => {
      opened = true;
      return {
        send: () => undefined,
        close: () => undefined,
      };
    };
    await notifySystemdReady({ openDatagram: opener, env: {} });
    expect(opened).toBe(false);
  });

  it("is a no-op when NOTIFY_SOCKET is empty string", async () => {
    let opened = false;
    const opener = async () => {
      opened = true;
      return {
        send: () => undefined,
        close: () => undefined,
      };
    };
    await notifySystemdReady({
      openDatagram: opener,
      env: { NOTIFY_SOCKET: "" },
    });
    expect(opened).toBe(false);
  });

  it("opens a datagram socket and sends READY=1 when NOTIFY_SOCKET is set", async () => {
    const path = "/run/systemd/notify-test";
    const calls: Array<{
      kind: string;
      data?: string;
      socketPath?: string;
    }> = [];

    const opener = async (socketPath: string) => {
      calls.push({ kind: "open", socketPath });
      return {
        send(data: string | Uint8Array) {
          const s = typeof data === "string" ? data : new TextDecoder().decode(data);
          calls.push({ kind: "send", data: s });
        },
        close() {
          calls.push({ kind: "close" });
        },
      };
    };

    await notifySystemdReady({
      openDatagram: opener,
      env: { NOTIFY_SOCKET: path },
    });

    expect(calls[0]).toEqual({ kind: "open", socketPath: path });
    const sendCall = calls.find((c) => c.kind === "send");
    expect(sendCall).toBeDefined();
    expect(sendCall?.data).toBe("READY=1\n");
    const closeCall = calls.find((c) => c.kind === "close");
    expect(closeCall).toBeDefined();
  });

  it("never throws when the socket open fails", async () => {
    const opener = async () => {
      throw new Error("ENOENT: socket path missing");
    };
    // Test that this resolves without throwing.
    await expect(
      notifySystemdReady({
        openDatagram: opener,
        env: { NOTIFY_SOCKET: "/run/systemd/notify" },
      })
    ).resolves.toBeUndefined();
  });

  it("never throws when send() fails", async () => {
    const opener = async () => ({
      send() {
        throw new Error("EPIPE");
      },
      close() {
        /* clean close */
      },
    });
    await expect(
      notifySystemdReady({
        openDatagram: opener,
        env: { NOTIFY_SOCKET: "/run/systemd/notify" },
      })
    ).resolves.toBeUndefined();
  });

  it("never throws when close() fails", async () => {
    const opener = async () => ({
      send() {
        /* ok */
      },
      close() {
        throw new Error("EBADF");
      },
    });
    await expect(
      notifySystemdReady({
        openDatagram: opener,
        env: { NOTIFY_SOCKET: "/run/systemd/notify" },
      })
    ).resolves.toBeUndefined();
  });

  it("defaults to process.env when env is not provided", async () => {
    const original = process.env.NOTIFY_SOCKET;
    delete process.env.NOTIFY_SOCKET;
    try {
      let opened = false;
      const opener = async () => {
        opened = true;
        return {
          send: () => undefined,
          close: () => undefined,
        };
      };
      await notifySystemdReady({ openDatagram: opener });
      expect(opened).toBe(false);
    } finally {
      if (original !== undefined) process.env.NOTIFY_SOCKET = original;
    }
  });
});
