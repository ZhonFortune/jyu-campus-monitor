import net from "node:net";
import { HttpError } from "../../shared/error.js";
import type { Logger } from "../../shared/logger.js";

type ProxyProtocol = "http" | "socks4" | "socks5";

const PROXY_SOURCE_URL = "https://proxychina.github.io/free-proxy-for-china/";
const PROXY_SOURCE_TIMEOUT_MS = 15_000;
const PROXY_HEALTH_CHECK_TIMEOUT_MS = 3_000;
const DEFAULT_PROXY_LIMIT = 3;
const HEALTH_CHECK_POOL_SIZE = 12;

export type HttpProxy = {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  protocol: ProxyProtocol;
  anonymity: string;
  uptimeScore: number;
  latencyMs: number;
};

type RawProxyRow = {
  host: string;
  port: string;
  username: string;
  password: string;
  protocol: string;
  anonymity: string;
  uptime: string;
  latency: string;
};

function parseConfiguredProxy(): HttpProxy | null {
  const rawValue = process.env.CHINA_HTTP_PROXY_URL?.trim();
  if (!rawValue) {
    return null;
  }

  const url = new URL(rawValue);
  const protocol = parseProxyProtocol(url.protocol.replace(":", ""));
  if (!protocol) {
    throw new Error("CHINA_HTTP_PROXY_URL must use http, socks4, or socks5.");
  }

  const port = url.port ? Number(url.port) : protocol === "http" ? 80 : 1080;
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CHINA_HTTP_PROXY_URL must include a valid host and port.");
  }

  return {
    host: url.hostname,
    port,
    username: url.username ? decodeURIComponent(url.username) : null,
    password: url.password ? decodeURIComponent(url.password) : null,
    protocol,
    anonymity: "configured",
    uptimeScore: Number.POSITIVE_INFINITY,
    latencyMs: 0
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(value: string): number | null {
  const matched = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!matched) {
    return null;
  }

  const parsed = Number(matched[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLatencyMs(value: string): number {
  const parsed = parseNumber(value);
  if (parsed === null) {
    return Number.POSITIVE_INFINITY;
  }

  const normalized = value.toLowerCase();
  return normalized.includes("ms") ? parsed : normalized.includes("s") ? parsed * 1000 : parsed;
}

function parseUptimeScore(value: string): number {
  return parseNumber(value) ?? 0;
}

function parseProxyProtocol(value: string): ProxyProtocol | null {
  const protocol = value.trim().toLowerCase();
  return protocol === "http" || protocol === "socks4" || protocol === "socks5" ? protocol : null;
}

function normalizeCredential(value: string): string | null {
  const normalized = value.trim();
  return normalized && normalized !== "****" ? normalized : null;
}

function parseRows(html: string): RawProxyRow[] {
  const rows = html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];

  return rows.flatMap((row) => {
    const cells = Array.from(row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi), (match) => decodeHtml(match[1] ?? ""));

    if (cells.length < 12 || cells.some((cell) => cell.toLowerCase() === "ip")) {
      return [];
    }

    return [
      {
        host: cells[0] ?? "",
        port: cells[1] ?? "",
        username: cells[2] ?? "",
        password: cells[3] ?? "",
        protocol: cells[5] ?? "",
        anonymity: cells[6] ?? "",
        uptime: cells[8] ?? "",
        latency: cells[10] ?? ""
      }
    ];
  });
}

function normalizeProxy(row: RawProxyRow): HttpProxy | null {
  const port = Number(row.port);
  if (!row.host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  const protocol = parseProxyProtocol(row.protocol);
  if (!protocol) {
    return null;
  }

  if (row.anonymity.trim().toLowerCase() !== "elite (hia)") {
    return null;
  }

  return {
    host: row.host,
    port,
    username: normalizeCredential(row.username),
    password: normalizeCredential(row.password),
    protocol,
    anonymity: row.anonymity,
    uptimeScore: parseUptimeScore(row.uptime),
    latencyMs: parseLatencyMs(row.latency)
  };
}

function closeSocket(socket: net.Socket): void {
  socket.removeAllListeners();
  socket.destroy();
}

function waitForSocketConnect(socket: net.Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("HTTP proxy health check timeout."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function readHttpHeaders(socket: net.Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("HTTP proxy health check response timeout."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      cleanup();
      resolve(buffer.subarray(0, headerEnd).toString("latin1"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function createProxyAuthorization(proxy: HttpProxy): string | null {
  if (!proxy.username && !proxy.password) {
    return null;
  }

  return `Basic ${Buffer.from(`${proxy.username ?? ""}:${proxy.password ?? ""}`).toString("base64")}`;
}

function readExact(socket: net.Socket, length: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("SOCKS5 proxy health check response timeout."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
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

    socket.on("data", onData);
    socket.once("error", onError);
  });
}

async function connectSocks5Target(socket: net.Socket, proxy: HttpProxy, targetHost: string, targetPort: number, timeoutMs: number): Promise<void> {
  const methods = proxy.username || proxy.password ? [0x00, 0x02] : [0x00];
  socket.write(Buffer.from([0x05, methods.length, ...methods]));
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

    socket.write(Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
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
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]));

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
}

async function connectSocks4Target(socket: net.Socket, proxy: HttpProxy, targetHost: string, targetPort: number, timeoutMs: number): Promise<void> {
  const port = Buffer.allocUnsafe(2);
  port.writeUInt16BE(targetPort, 0);
  const userId = Buffer.from(proxy.username ?? "", "utf8");
  const host = Buffer.from(targetHost, "utf8");
  if (userId.includes(0) || host.includes(0)) {
    throw new Error("SOCKS4 proxy target contains invalid null byte.");
  }

  socket.write(
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
}

async function checkProxy(proxy: HttpProxy): Promise<HttpProxy | null> {
  const startedAt = Date.now();
  const socket = net.createConnection({ host: proxy.host, port: proxy.port });

  try {
    await waitForSocketConnect(socket, PROXY_HEALTH_CHECK_TIMEOUT_MS);
    if (proxy.protocol === "socks5") {
      await connectSocks5Target(socket, proxy, "yktportal.jyu.edu.cn", 443, PROXY_HEALTH_CHECK_TIMEOUT_MS);
      return {
        ...proxy,
        latencyMs: Math.max(1, Date.now() - startedAt)
      };
    }

    if (proxy.protocol === "socks4") {
      await connectSocks4Target(socket, proxy, "yktportal.jyu.edu.cn", 443, PROXY_HEALTH_CHECK_TIMEOUT_MS);
      return {
        ...proxy,
        latencyMs: Math.max(1, Date.now() - startedAt)
      };
    }

    const authorization = createProxyAuthorization(proxy);
    const request = [
      "CONNECT yktportal.jyu.edu.cn:443 HTTP/1.1",
      "Host: yktportal.jyu.edu.cn:443",
      "Proxy-Connection: close",
      authorization ? `Proxy-Authorization: ${authorization}` : null,
      "",
      ""
    ].filter((line): line is string => line !== null);
    socket.write(request.join("\r\n"));

    const response = await readHttpHeaders(socket, PROXY_HEALTH_CHECK_TIMEOUT_MS);
    const statusMatch = response.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    if (status < 200 || status >= 300) {
      return null;
    }

    return {
      ...proxy,
      latencyMs: Math.max(1, Date.now() - startedAt)
    };
  } catch {
    return null;
  } finally {
    closeSocket(socket);
  }
}

export async function selectChinaHttpProxies(logger: Logger, limit = DEFAULT_PROXY_LIMIT): Promise<HttpProxy[]> {
  const configuredProxy = parseConfiguredProxy();
  if (configuredProxy) {
    logger.info(`China proxy configured | protocol=${configuredProxy.protocol} | host=${configuredProxy.host} | port=${configuredProxy.port}`);
    return [configuredProxy];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_SOURCE_TIMEOUT_MS);

  try {
    const response = await fetch(PROXY_SOURCE_URL, { signal: controller.signal });
    const html = await response.text();

    if (!response.ok) {
      throw new HttpError(response.status, "PROXY_SOURCE_REQUEST_FAILED", "代理节点获取失败。");
    }

    const candidates = parseRows(html)
      .map(normalizeProxy)
      .filter((proxy): proxy is HttpProxy => proxy !== null)
      .sort((left, right) => right.uptimeScore - left.uptimeScore || left.latencyMs - right.latencyMs);

    const healthCheckPool = candidates.slice(0, Math.max(limit, HEALTH_CHECK_POOL_SIZE));
    const checked = await Promise.all(healthCheckPool.map(checkProxy));
    const healthy = checked.filter((proxy): proxy is HttpProxy => proxy !== null);
    const selected = healthy.slice(0, Math.max(1, limit));
    if (selected.length === 0) {
      const fallback = candidates.slice(0, Math.max(1, limit));
      if (fallback.length === 0) {
        throw new HttpError(502, "PROXY_SOURCE_EMPTY", "未找到可用代理节点。");
      }

      logger.warn(`China proxy health check empty; using unchecked candidates | available=${candidates.length}`);
      return fallback;
    }

    logger.info(`China proxy candidates selected | count=${selected.length} | healthy=${healthy.length} | available=${candidates.length}`);

    return selected;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error(`China proxy selection failed | cause=${message}`);
    throw new HttpError(502, "PROXY_SOURCE_REQUEST_ERROR", "代理节点获取异常。");
  } finally {
    clearTimeout(timeout);
  }
}
