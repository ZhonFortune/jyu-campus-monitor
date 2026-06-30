import net from "node:net";
import tls from "node:tls";
import { HttpError } from "../../shared/error.js";
import type { Logger } from "../../shared/logger.js";
import type { HttpProxy } from "./provider.js";

type ProxiedRequestOptions = {
  url: string;
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: URLSearchParams | Buffer | string;
  timeoutMs: number;
  proxy: HttpProxy;
  logger: Logger;
};

export type ProxiedHttpResponse = {
  status: number;
  statusText: string;
  headers: Map<string, string>;
  setCookieHeaders: string[];
  body: Buffer;
  text: string;
};

function waitForSocketConnect(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error("Socket timeout."));
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

function writeAll(socket: net.Socket | tls.TLSSocket, payload: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("drain", onDrain);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };

    socket.once("error", onError);
    if (socket.write(payload)) {
      cleanup();
      resolve();
      return;
    }

    socket.once("drain", onDrain);
  });
}

function readUntilClose(socket: net.Socket | tls.TLSSocket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("HTTP response timeout."));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
    };
    const onData = (chunk: Buffer) => chunks.push(chunk);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
  });
}

function readHttpHeaders(socket: net.Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("HTTP proxy tunnel response timeout."));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      cleanup();
      const rest = buffer.subarray(headerEnd + 4);
      if (rest.length > 0) {
        socket.unshift(rest);
      }
      resolve(buffer.subarray(0, headerEnd).toString("latin1"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error("Socket timeout."));
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

function readExact(socket: net.Socket, length: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("SOCKS5 proxy response timeout."));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < length) {
        return;
      }

      cleanup();
      const rest = buffer.subarray(length);
      if (rest.length > 0) {
        socket.unshift(rest);
      }
      resolve(buffer.subarray(0, length));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error("Socket timeout."));
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

function waitForSecureConnect(socket: tls.TLSSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("TLS handshake timeout."));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("secureConnect", onSecureConnect);
      socket.off("error", onError);
    };
    const onSecureConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.once("secureConnect", onSecureConnect);
    socket.once("error", onError);
  });
}

function createProxyAuthorization(proxy: HttpProxy): string | null {
  if (!proxy.username && !proxy.password) {
    return null;
  }

  return `Basic ${Buffer.from(`${proxy.username ?? ""}:${proxy.password ?? ""}`).toString("base64")}`;
}

async function connectHttpProxy(proxy: HttpProxy, targetHost: string, targetPort: number, timeoutMs: number): Promise<net.Socket> {
  const socket = net.createConnection({ host: proxy.host, port: proxy.port });
  socket.setTimeout(timeoutMs);

  try {
    await waitForSocketConnect(socket);
    const authority = `${targetHost}:${targetPort}`;
    const authorization = createProxyAuthorization(proxy);
    const request = [
      `CONNECT ${authority} HTTP/1.1`,
      `Host: ${authority}`,
      "Proxy-Connection: Keep-Alive",
      authorization ? `Proxy-Authorization: ${authorization}` : null,
      "",
      ""
    ].filter((line): line is string => line !== null);

    await writeAll(socket, request.join("\r\n"));
    const responseHeaders = await readHttpHeaders(socket, timeoutMs);
    const statusMatch = responseHeaders.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    if (status < 200 || status >= 300) {
      throw new Error(`HTTP proxy tunnel failed with status ${status || "unknown"}.`);
    }

    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function connectSocks5Proxy(proxy: HttpProxy, targetHost: string, targetPort: number, timeoutMs: number): Promise<net.Socket> {
  const socket = net.createConnection({ host: proxy.host, port: proxy.port });
  socket.setTimeout(timeoutMs);

  try {
    await waitForSocketConnect(socket);
    const methods = proxy.username || proxy.password ? [0x00, 0x02] : [0x00];
    await writeAll(socket, Buffer.from([0x05, methods.length, ...methods]));

    const methodResponse = await readExact(socket, 2, timeoutMs);
    if (methodResponse[0] !== 0x05 || methodResponse[1] === 0xff) {
      throw new Error("SOCKS5 proxy has no acceptable authentication method.");
    }

    if (methodResponse[1] === 0x02) {
      const username = Buffer.from(proxy.username ?? "", "utf8");
      const password = Buffer.from(proxy.password ?? "", "utf8");
      if (username.length > 255 || password.length > 255) {
        throw new Error("SOCKS5 proxy credentials are too long.");
      }

      await writeAll(socket, Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
      const authResponse = await readExact(socket, 2, timeoutMs);
      if (authResponse[0] !== 0x01 || authResponse[1] !== 0x00) {
        throw new Error("SOCKS5 proxy authentication failed.");
      }
    }

    const host = Buffer.from(targetHost, "utf8");
    if (host.length > 255) {
      throw new Error("SOCKS5 target host is too long.");
    }

    const port = Buffer.allocUnsafe(2);
    port.writeUInt16BE(targetPort, 0);
    await writeAll(socket, Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]));

    const responseHead = await readExact(socket, 4, timeoutMs);
    if (responseHead[0] !== 0x05 || responseHead[1] !== 0x00) {
      throw new Error(`SOCKS5 proxy connect failed with code ${responseHead[1] ?? "unknown"}.`);
    }

    const addressType = responseHead[3];
    const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : addressType === 0x03 ? (await readExact(socket, 1, timeoutMs))[0] : 0;
    if (!addressLength) {
      throw new Error("SOCKS5 proxy returned invalid address type.");
    }

    await readExact(socket, addressLength + 2, timeoutMs);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function connectSocks4Proxy(proxy: HttpProxy, targetHost: string, targetPort: number, timeoutMs: number): Promise<net.Socket> {
  const socket = net.createConnection({ host: proxy.host, port: proxy.port });
  socket.setTimeout(timeoutMs);

  try {
    await waitForSocketConnect(socket);
    const port = Buffer.allocUnsafe(2);
    port.writeUInt16BE(targetPort, 0);
    const userId = Buffer.from(proxy.username ?? "", "utf8");
    const host = Buffer.from(targetHost, "utf8");
    if (userId.includes(0) || host.includes(0)) {
      throw new Error("SOCKS4 proxy target contains invalid null byte.");
    }

    await writeAll(
      socket,
      Buffer.concat([
        Buffer.from([0x04, 0x01]),
        port,
        Buffer.from([0x00, 0x00, 0x00, 0x01]),
        userId,
        Buffer.from([0x00]),
        host,
        Buffer.from([0x00])
      ])
    );

    const response = await readExact(socket, 8, timeoutMs);
    if (response[0] !== 0x00 || response[1] !== 0x5a) {
      throw new Error(`SOCKS4 proxy connect failed with code ${response[1] ?? "unknown"}.`);
    }

    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function connectProxy(proxy: HttpProxy, targetHost: string, targetPort: number, timeoutMs: number): Promise<net.Socket> {
  if (proxy.protocol === "socks5") {
    return connectSocks5Proxy(proxy, targetHost, targetPort, timeoutMs);
  }

  if (proxy.protocol === "socks4") {
    return connectSocks4Proxy(proxy, targetHost, targetPort, timeoutMs);
  }

  return connectHttpProxy(proxy, targetHost, targetPort, timeoutMs);
}

function decodeChunkedBody(body: Buffer): Buffer {
  let offset = 0;
  const chunks: Buffer[] = [];

  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd === -1) {
      break;
    }

    const sizeText = body.subarray(offset, lineEnd).toString("ascii").split(";")[0]?.trim() ?? "";
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) {
      break;
    }

    offset = lineEnd + 2;
    if (size === 0) {
      break;
    }

    chunks.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }

  return Buffer.concat(chunks);
}

function parseResponse(buffer: Buffer): ProxiedHttpResponse {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    throw new Error("Invalid HTTP response.");
  }

  const headerText = buffer.subarray(0, headerEnd).toString("latin1");
  const body = buffer.subarray(headerEnd + 4);
  const [statusLine = "", ...headerLines] = headerText.split("\r\n");
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/i);
  if (!statusMatch) {
    throw new Error("Invalid HTTP status line.");
  }

  const headers = new Map<string, string>();
  const setCookieHeaders: string[] = [];
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === "set-cookie") {
      setCookieHeaders.push(value);
    }

    const existingValue = headers.get(name);
    headers.set(name, existingValue ? `${existingValue}, ${value}` : value);
  }

  const responseBody = headers.get("transfer-encoding")?.toLowerCase().includes("chunked") ? decodeChunkedBody(body) : body;

  return {
    status: Number(statusMatch[1] ?? 0),
    statusText: statusMatch[2] ?? "",
    headers,
    setCookieHeaders,
    body: responseBody,
    text: responseBody.toString("utf8")
  };
}

function normalizeBody(body: ProxiedRequestOptions["body"]): Buffer | null {
  if (body === undefined) {
    return null;
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  return Buffer.from(body.toString(), "utf8");
}

export async function requestThroughHttpProxy(options: ProxiedRequestOptions): Promise<ProxiedHttpResponse> {
  let proxySocket: net.Socket | null = null;
  let secureSocket: tls.TLSSocket | null = null;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    secureSocket?.destroy();
    proxySocket?.destroy();
  }, options.timeoutMs);

  const target = new URL(options.url);
  const targetPort = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
  const method = options.method ?? (options.body ? "POST" : "GET");
  const body = normalizeBody(options.body);

  try {
    proxySocket = await connectProxy(options.proxy, target.hostname, targetPort, options.timeoutMs);
    secureSocket = tls.connect({
      socket: proxySocket,
      servername: target.hostname,
      rejectUnauthorized: true
    });
    secureSocket.setTimeout(options.timeoutMs);

    const requestHeaders = {
      ...options.headers,
      Host: target.host,
      ...(body ? { "Content-Length": body.length.toString() } : {}),
      Connection: "close"
    };
    const request = [
      `${method} ${target.pathname}${target.search} HTTP/1.1`,
      ...Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`),
      "",
      ""
    ].join("\r\n");

    await waitForSecureConnect(secureSocket, options.timeoutMs);
    const responsePromise = readUntilClose(secureSocket, options.timeoutMs);
    await writeAll(secureSocket, request);
    if (body) {
      await writeAll(secureSocket, body);
    }
    return parseResponse(await responsePromise);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (timedOut) {
      options.logger.error(`Proxied request timeout after ${options.timeoutMs} ms | protocol=${options.proxy.protocol} | host=${target.hostname}`);
      throw new HttpError(504, "HTTP_PROXY_REQUEST_TIMEOUT", "代理请求超时。");
    }

    options.logger.error(`Proxied request failed | protocol=${options.proxy.protocol} | host=${target.hostname} | cause=${message}`);
    throw new HttpError(502, "HTTP_PROXY_REQUEST_FAILED", "代理请求失败。");
  } finally {
    clearTimeout(timeout);
    secureSocket?.destroy();
    proxySocket?.destroy();
  }
}
