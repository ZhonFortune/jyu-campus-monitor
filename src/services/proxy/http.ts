import net from "node:net";
import tls from "node:tls";
import { HttpError } from "../../shared/error.js";
import type { Logger } from "../../shared/logger.js";
import type { HttpProxy } from "./provider.js";

type ProxiedPostOptions = {
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
  timeoutMs: number;
  proxy: HttpProxy;
  logger: Logger;
};

export type ProxiedHttpResponse = {
  status: number;
  statusText: string;
  headers: Map<string, string>;
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
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }

  const responseBody = headers.get("transfer-encoding")?.toLowerCase().includes("chunked") ? decodeChunkedBody(body) : body;

  return {
    status: Number(statusMatch[1] ?? 0),
    statusText: statusMatch[2] ?? "",
    headers,
    text: responseBody.toString("utf8")
  };
}

export async function postFormThroughHttpProxy(options: ProxiedPostOptions): Promise<ProxiedHttpResponse> {
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
  const bodyText = options.body.toString();

  try {
    proxySocket = await connectHttpProxy(options.proxy, target.hostname, targetPort, options.timeoutMs);
    secureSocket = tls.connect({
      socket: proxySocket,
      servername: target.hostname,
      rejectUnauthorized: true
    });
    secureSocket.setTimeout(options.timeoutMs);

    const requestHeaders = {
      ...options.headers,
      Host: target.host,
      "Content-Length": Buffer.byteLength(bodyText).toString(),
      Connection: "close"
    };
    const request = [
      `POST ${target.pathname}${target.search} HTTP/1.1`,
      ...Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`),
      "",
      bodyText
    ].join("\r\n");

    await waitForSecureConnect(secureSocket, options.timeoutMs);
    const responsePromise = readUntilClose(secureSocket, options.timeoutMs);
    await writeAll(secureSocket, request);
    return parseResponse(await responsePromise);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (timedOut) {
      options.logger.error(`HTTP proxied request timeout after ${options.timeoutMs} ms | host=${target.hostname}`);
      throw new HttpError(504, "HTTP_PROXY_REQUEST_TIMEOUT", "代理请求超时。");
    }

    options.logger.error(`HTTP proxied request failed | host=${target.hostname} | cause=${message}`);
    throw new HttpError(502, "HTTP_PROXY_REQUEST_FAILED", "代理请求失败。");
  } finally {
    clearTimeout(timeout);
    secureSocket?.destroy();
    proxySocket?.destroy();
  }
}
