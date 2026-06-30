import net from "node:net";
import { HttpError } from "../../shared/error.js";
import type { Logger } from "../../shared/logger.js";

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
  protocol: "http";
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
  if (url.protocol !== "http:") {
    throw new Error("CHINA_HTTP_PROXY_URL must use http.");
  }

  const port = url.port ? Number(url.port) : 80;
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CHINA_HTTP_PROXY_URL must include a valid host and port.");
  }

  return {
    host: url.hostname,
    port,
    username: url.username ? decodeURIComponent(url.username) : null,
    password: url.password ? decodeURIComponent(url.password) : null,
    protocol: "http",
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

  if (row.protocol.trim().toLowerCase() !== "http") {
    return null;
  }

  if (row.anonymity.trim().toLowerCase() !== "elite (hia)") {
    return null;
  }

  return {
    host: row.host,
    port,
    username: row.username || null,
    password: row.password || null,
    protocol: "http",
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

async function checkHttpProxy(proxy: HttpProxy): Promise<HttpProxy | null> {
  const startedAt = Date.now();
  const socket = net.createConnection({ host: proxy.host, port: proxy.port });

  try {
    await waitForSocketConnect(socket, PROXY_HEALTH_CHECK_TIMEOUT_MS);
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
    logger.info(`China HTTP proxy configured | host=${configuredProxy.host} | port=${configuredProxy.port}`);
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
    const checked = await Promise.all(healthCheckPool.map(checkHttpProxy));
    const healthy = checked.filter((proxy): proxy is HttpProxy => proxy !== null);
    const selected = healthy.slice(0, Math.max(1, limit));
    if (selected.length === 0) {
      throw new HttpError(502, "PROXY_SOURCE_EMPTY", "未找到可用代理节点。");
    }

    logger.info(`China HTTP proxy candidates selected | count=${selected.length} | healthy=${healthy.length} | available=${candidates.length}`);

    return selected;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error(`China HTTP proxy selection failed | cause=${message}`);
    throw new HttpError(502, "PROXY_SOURCE_REQUEST_ERROR", "代理节点获取异常。");
  } finally {
    clearTimeout(timeout);
  }
}
