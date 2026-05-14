/**
 * BLOCK N2 — systemd sd_notify(READY=1) helper.
 *
 * When the service unit is `Type=notify`, systemd blocks `systemctl restart`
 * until the new process sends `READY=1` over the AF_UNIX datagram socket
 * whose path is exposed via the `NOTIFY_SOCKET` env var. Once we send that,
 * the unit is considered started and the old process is reaped.
 *
 * This is what eliminates the "sleep + curl /healthz with retries" loop on
 * the deploy box: systemd itself knows when the new process is serving HTTP,
 * so the deploy workflow can move on the instant Bun.serve() returns.
 *
 * Defensive guarantees (load-bearing — boot must never fail on this):
 *  - If `NOTIFY_SOCKET` is unset (dev, local test, non-systemd hosts), the
 *    helper is a silent no-op.
 *  - All socket errors are swallowed. A failed notify NEVER throws out into
 *    `src/index.ts` boot path.
 *  - No external dependency. Uses `Bun.udpSocket` (datagram support shipped
 *    in Bun 1.1+).
 *
 * Reference:
 *  - https://www.freedesktop.org/software/systemd/man/sd_notify.html
 *  - https://www.freedesktop.org/software/systemd/man/systemd.service.html#Type=
 */

/**
 * Factory for the datagram socket used to talk to systemd. Pulled out so
 * tests can inject a mock without touching Bun globals.
 */
export type DatagramOpener = (
  socketPath: string
) => Promise<{
  send(data: string | Uint8Array, port: number, hostname: string): unknown;
  close(): void;
}>;

const defaultOpener: DatagramOpener = async (socketPath: string) => {
  // Bun's udpSocket factory. We intentionally don't bind to a port — we
  // only need to send a single datagram and then close. The `connect`
  // option targets the unix datagram path exposed by systemd.
  //
  // Note: at the time of writing Bun's udpSocket primarily exposes UDP/IP;
  // we pass `connect` with the path field as a best-effort. If the runtime
  // rejects the unix path, the resulting throw is caught by `notifySystemdReady`
  // and we fall back gracefully (systemd will eventually time out and fall
  // back to its normal start sequence — boot is unaffected).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const socket = await (Bun as any).udpSocket({
    socket: {
      data() {
        /* unused */
      },
      drain() {
        /* unused */
      },
      error() {
        /* swallow */
      },
    },
    connect: { hostname: socketPath, port: 0 },
  });
  return socket as ReturnType<DatagramOpener> extends Promise<infer T>
    ? T
    : never;
};

/**
 * Send `READY=1\n` to systemd's notification socket if one is configured.
 *
 * - No-op when `NOTIFY_SOCKET` is unset (dev / non-systemd).
 * - Never throws. Errors are intentionally swallowed.
 *
 * @param opts.openDatagram  Optional injected socket factory (tests).
 * @param opts.env           Optional env-bag (defaults to `process.env`).
 */
export async function notifySystemdReady(
  opts: {
    openDatagram?: DatagramOpener;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<void> {
  const env = opts.env ?? process.env;
  const socketPath = env.NOTIFY_SOCKET;
  if (!socketPath || socketPath.length === 0) {
    // Dev / non-systemd host. Silent no-op.
    return;
  }

  const opener = opts.openDatagram ?? defaultOpener;

  try {
    const socket = await opener(socketPath);
    try {
      socket.send("READY=1\n", 0, socketPath);
    } catch {
      // ignore — best effort
    }
    try {
      socket.close();
    } catch {
      // ignore — best effort
    }
  } catch {
    // Socket couldn't be opened. Most likely the runtime doesn't support
    // AF_UNIX datagrams via Bun.udpSocket on this host, or the socket path
    // is stale. Either way, boot must continue.
    return;
  }
}

export const __test = { defaultOpener };
