import { env } from "../../config/env.js";
import { HttpError } from "../../shared/error.js";
import type { Logger } from "../../shared/logger.js";

type RelayRequestOptions = {
  url: string;
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: URLSearchParams | Buffer | string;
  timeoutMs: number;
  redirect?: "follow" | "error" | "manual";
  logger: Logger;
};

type RelayResponsePayload = {
  status?: unknown;
  statusText?: unknown;
  headers?: unknown;
  setCookieHeaders?: unknown;
  bodyBase64?: unknown;
};

export type RelayHttpResponse = {
  status: number;
  statusText: string;
  headers: Map<string, string>;
  setCookieHeaders: string[];
  body: Buffer;
  text: string;
};

const MAX_RELAY_BODY_BYTES = 1024 * 1024;

function normalizeBody(body: RelayRequestOptions["body"]): Buffer | null {
  if (body === undefined) {
    return null;
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  return Buffer.from(body.toString(), "utf8");
}

function assertRelayConfigured(): { url: string; secret: string } {
  if (!env.chinaRelayUrl) {
    throw new HttpError(500, "CHINA_RELAY_URL_MISSING", "回国中继未配置。");
  }

  if (!env.chinaRelaySecret) {
    throw new HttpError(500, "CHINA_RELAY_SECRET_MISSING", "回国中继密钥未配置。");
  }

  return {
    url: env.chinaRelayUrl,
    secret: env.chinaRelaySecret
  };
}

function parseHeaders(value: unknown): Map<string, string> {
  const headers = new Map<string, string>();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return headers;
  }

  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") {
      headers.set(key.toLowerCase(), headerValue);
    }
  }

  return headers;
}

function parseSetCookieHeaders(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function parseRelayPayload(payload: RelayResponsePayload): RelayHttpResponse {
  const status = payload.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new HttpError(502, "CHINA_RELAY_RESPONSE_INVALID", "回国中继响应无效。");
  }

  if (typeof payload.bodyBase64 !== "string") {
    throw new HttpError(502, "CHINA_RELAY_RESPONSE_INVALID", "回国中继响应无效。");
  }

  const body = Buffer.from(payload.bodyBase64, "base64");
  return {
    status,
    statusText: typeof payload.statusText === "string" ? payload.statusText : "",
    headers: parseHeaders(payload.headers),
    setCookieHeaders: parseSetCookieHeaders(payload.setCookieHeaders),
    body,
    text: body.toString("utf8")
  };
}

export async function requestThroughChinaRelay(options: RelayRequestOptions): Promise<RelayHttpResponse> {
  const relay = assertRelayConfigured();
  const body = normalizeBody(options.body);
  if (body && body.byteLength > MAX_RELAY_BODY_BYTES) {
    throw new HttpError(413, "CHINA_RELAY_BODY_TOO_LARGE", "请求内容过大。");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const target = new URL(options.url);

  try {
    options.logger.info(`China relay request started | host=${target.hostname}`);
    const response = await fetch(relay.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-Secret": relay.secret
      },
      body: JSON.stringify({
        url: options.url,
        method: options.method ?? (body ? "POST" : "GET"),
        headers: options.headers,
        redirect: options.redirect ?? "follow",
        bodyBase64: body ? body.toString("base64") : null
      }),
      signal: controller.signal
    });

    const payload = (await response.json()) as RelayResponsePayload;
    if (!response.ok) {
      const code = typeof payload.statusText === "string" && payload.statusText ? payload.statusText : "CHINA_RELAY_REQUEST_FAILED";
      options.logger.error(`China relay rejected request | status=${response.status} | host=${target.hostname}`);
      throw new HttpError(response.status, code, "回国中继请求失败。");
    }

    return parseRelayPayload(payload);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      options.logger.error(`China relay request timeout after ${options.timeoutMs} ms | host=${target.hostname}`);
      throw new HttpError(504, "CHINA_RELAY_REQUEST_TIMEOUT", "回国中继请求超时。");
    }

    const message = error instanceof Error ? error.message : String(error);
    options.logger.error(`China relay request failed | host=${target.hostname} | cause=${message}`);
    throw new HttpError(502, "CHINA_RELAY_REQUEST_FAILED", "回国中继请求失败。");
  } finally {
    clearTimeout(timeout);
  }
}
