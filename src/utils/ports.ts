import { createServer } from "node:net";

/**
 * Ask the operating system to allocate an ephemeral loopback port, then
 * release it for the browser. There is necessarily a small handoff window;
 * launch retries in BrowserManager cover the rare collision.
 */
export async function findFreeLocalPort(host = "127.0.0.1"): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to determine a free local TCP port.")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

/** Backwards-friendly alias for consumers that prefer a generic name. */
export const getAvailableLocalPort = findFreeLocalPort;
