import { createServer, request, type Server } from "node:http";
import { connect, type Socket } from "node:net";

/**
 * A forward proxy that lets every host through. Claude Code's sandbox only reaches the network through a proxy,
 * and its own one refuses a bare `*` in `allowedDomains` ("overly broad patterns are not allowed"), so open egress
 * means giving it ours (`sandbox.network.httpProxyPort`). It listens on 127.0.0.1 only.
 */
function startOpenProxy(): Promise<Server> {
  const server = createServer((req, res) => {
    // Plain HTTP: the client sends the absolute URL.
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const out = request(
      {
        host: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: req.method,
        headers: req.headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    out.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(out);
  });
  // HTTPS and anything else: a CONNECT tunnel.
  server.on("connect", (req, client: Socket, head) => {
    const [host, port] = (req.url ?? "").split(/:(?=\d+$)/);
    let tunneled = false;
    const up = connect(Number(port) || 443, (host ?? "").replace(/^\[|\]$/g, ""), () => {
      tunneled = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    const close = () => {
      up.destroy();
      client.destroy();
    };
    up.on("error", () => (tunneled ? close() : client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")));
    up.on("close", close);
    client.on("error", close);
    client.on("close", close);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve(server);
    });
  });
}

let started: Promise<number> | undefined;

/** The port of this process's open proxy, started on first use and kept for the life of the process. */
export function openProxyPort(): Promise<number> {
  started ??= startOpenProxy().then((s) => {
    const addr = s.address();
    if (!addr || typeof addr === "string") throw new Error("The network proxy has no port.");
    return addr.port;
  });
  started.catch(() => (started = undefined));
  return started;
}
