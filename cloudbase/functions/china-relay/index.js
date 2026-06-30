const crypto = require("node:crypto");

const DEFAULT_ALLOWED_TARGET_HOSTS = "yktportal.jyu.edu.cn";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const SERVER_PORT = Number(process.env.PORT || 9000);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(payload)
  };
}

function readHeader(headers, name) {
  if (!headers || typeof headers !== "object") {
    return "";
  }

  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName) {
      return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
    }
  }

  return "";
}

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function assertAuthorized(event) {
  const expectedSecret = process.env.RELAY_SHARED_SECRET || process.env.CHINA_RELAY_SECRET;
  if (!expectedSecret) {
    throw Object.assign(new Error("Relay secret is not configured."), { statusCode: 500, code: "RELAY_SECRET_MISSING" });
  }

  const actualSecret = readHeader(event.headers, "x-relay-secret");
  if (!actualSecret || !secureEquals(actualSecret, expectedSecret)) {
    throw Object.assign(new Error("Unauthorized."), { statusCode: 401, code: "RELAY_UNAUTHORIZED" });
  }
}

function parseEventBody(event) {
  if (typeof event.body !== "string") {
    throw Object.assign(new Error("Request body is required."), { statusCode: 400, code: "RELAY_BODY_REQUIRED" });
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(rawBody);
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400, code: "RELAY_BODY_INVALID" });
  }
}

function readAllowedHosts() {
  return new Set(
    (process.env.ALLOWED_TARGET_HOSTS || DEFAULT_ALLOWED_TARGET_HOSTS)
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );
}

function assertTargetAllowed(url) {
  if (url.protocol !== "https:") {
    throw Object.assign(new Error("Only HTTPS targets are allowed."), { statusCode: 400, code: "RELAY_TARGET_PROTOCOL_INVALID" });
  }

  if (url.port && url.port !== "443") {
    throw Object.assign(new Error("Custom target ports are not allowed."), { statusCode: 400, code: "RELAY_TARGET_PORT_INVALID" });
  }

  if (!readAllowedHosts().has(url.hostname.toLowerCase())) {
    throw Object.assign(new Error("Target host is not allowed."), { statusCode: 403, code: "RELAY_TARGET_FORBIDDEN" });
  }
}

function normalizeMethod(value) {
  const method = typeof value === "string" ? value.toUpperCase() : "GET";
  if (method !== "GET" && method !== "POST") {
    throw Object.assign(new Error("Method is not allowed."), { statusCode: 400, code: "RELAY_METHOD_INVALID" });
  }

  return method;
}

function normalizeRedirect(value) {
  if (value === "follow" || value === "error" || value === "manual") {
    return value;
  }

  return "follow";
}

function normalizeHeaders(value) {
  const headers = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return headers;
  }

  for (const [key, headerValue] of Object.entries(value)) {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey || HOP_BY_HOP_HEADERS.has(normalizedKey)) {
      continue;
    }

    if (typeof headerValue === "string") {
      headers[key] = headerValue;
    }
  }

  return headers;
}

function normalizeRequestBody(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw Object.assign(new Error("Request payload is invalid."), { statusCode: 400, code: "RELAY_PAYLOAD_INVALID" });
  }

  const body = Buffer.from(value, "base64");
  if (body.byteLength > MAX_REQUEST_BODY_BYTES) {
    throw Object.assign(new Error("Request payload is too large."), { statusCode: 413, code: "RELAY_PAYLOAD_TOO_LARGE" });
  }

  return body;
}

function readSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const combined = headers.get("set-cookie");
  return combined ? combined.split(/,(?=\s*[^;,=\s]+=[^;,]+)/) : [];
}

function serializeHeaders(headers) {
  const serialized = {};
  headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(normalizedKey) && normalizedKey !== "set-cookie") {
      serialized[normalizedKey] = value;
    }
  });

  return serialized;
}

async function fetchTarget(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(request.url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method === "POST" ? request.body : null,
      redirect: request.redirect,
      signal: controller.signal
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > MAX_RESPONSE_BODY_BYTES) {
      throw Object.assign(new Error("Target response is too large."), { statusCode: 502, code: "RELAY_RESPONSE_TOO_LARGE" });
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: serializeHeaders(response.headers),
      setCookieHeaders: readSetCookieHeaders(response.headers),
      bodyBase64: body.toString("base64")
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleRelayEvent(event) {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") {
      return jsonResponse(405, { statusText: "RELAY_METHOD_NOT_ALLOWED" });
    }

    assertAuthorized(event);
    const payload = parseEventBody(event);
    const url = new URL(String(payload.url || ""));
    assertTargetAllowed(url);

    const method = normalizeMethod(payload.method);
    const body = normalizeRequestBody(payload.bodyBase64);
    const relayResponse = await fetchTarget({
      url,
      method,
      headers: normalizeHeaders(payload.headers),
      body,
      redirect: normalizeRedirect(payload.redirect)
    });

    return jsonResponse(200, relayResponse);
  } catch (error) {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : error.name === "AbortError" ? 504 : 500;
    const code = typeof error.code === "string" ? error.code : error.name === "AbortError" ? "RELAY_TARGET_TIMEOUT" : "RELAY_INTERNAL_ERROR";
    return jsonResponse(statusCode, { statusText: code });
  }
}

exports.main = handleRelayEvent;

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.once("error", reject);
    request.once("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function writeFunctionResponse(response, result) {
  response.statusCode = result.statusCode;
  for (const [key, value] of Object.entries(result.headers || {})) {
    response.setHeader(key, value);
  }

  response.end(result.body);
}

async function startHttpServer() {
  const http = require("node:http");
  const server = http.createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      const result = await handleRelayEvent({
        httpMethod: request.method,
        headers: request.headers,
        body,
        isBase64Encoded: false
      });
      writeFunctionResponse(response, result);
    } catch {
      writeFunctionResponse(response, jsonResponse(500, { statusText: "RELAY_INTERNAL_ERROR" }));
    }
  });

  server.listen(SERVER_PORT, "0.0.0.0");
}

if (require.main === module) {
  void startHttpServer();
}
