import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { HttpError } from "../../shared/error.js";
import type { Logger } from "../../shared/logger.js";

const YKT_ORIGIN = "https://yktportal.jyu.edu.cn";
const LOGIN_PAGE_URL = `${YKT_ORIGIN}/sso//login?t=12&redirectUrl=${encodeURIComponent(`${YKT_ORIGIN}/user/powerfee/index`)}`;
const LOGIN_RSA_URL = `${YKT_ORIGIN}/sso/login/rsa`;
const LOGIN_SUBMIT_URL = `${YKT_ORIGIN}/sso/doLogin`;
const BALANCE_URL = "https://yktportal.jyu.edu.cn/user/powerfee/getBalance";
const ROOM_INFO_URL = "https://yktportal.jyu.edu.cn/user/powerfee/getRoomInfo";
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_PREVIEW_LIMIT = 800;
const WECHAT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541a1f) XWEB/25047 miniProgram/wx84ddfd51a823dc58";

export type PowerFeeLocation = {
  schoolAreaNo: string;
  dormBuildingName: string;
  roomNumber: string;
};

export type PowerFeeBalance = {
  balance: number;
  raw: unknown;
};

type ResolvedRoomInfo = {
  buildingNo: string;
  roomId: string;
};

type YktSession = {
  token: string;
  cookieHeader: string;
};

type YktHttpResponse = {
  status: number;
  statusText: string;
  headers: Map<string, string>;
  text: string;
};

type LoginResponse = {
  code?: number;
  msg?: string;
  token?: string;
  [key: string]: unknown;
};

type RsaResponse = {
  code?: number;
  pubKey?: string;
  msg?: string;
};

export type CaptchaResolver = (image: Buffer) => Promise<string>;

class CookieJar {
  private readonly cookies = new Map<string, string>();

  addFromHeaders(headers: Headers): void {
    const setCookies = readSetCookieHeaders(headers);
    for (const setCookie of setCookies) {
      const [pair] = setCookie.split(";");
      const separator = pair?.indexOf("=") ?? -1;
      if (!pair || separator <= 0) {
        continue;
      }

      this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  toHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
}

function normalizeQueryValue(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new HttpError(400, "INVALID_POWER_FEE_QUERY", `${name} is required.`);
  }

  return normalized;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function previewResponseBody(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, RESPONSE_PREVIEW_LIMIT);
}

function previewPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return previewResponseBody(payload);
  }

  try {
    return previewResponseBody(JSON.stringify(payload));
  } catch {
    return "[unserializable payload]";
  }
}

function readSetCookieHeaders(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === "function") {
    return withGetter.getSetCookie();
  }

  const combined = headers.get("set-cookie");
  return combined ? combined.split(/,(?=\s*[^;,=\s]+=[^;,]+)/) : [];
}

function toHeadersMap(headers: Headers): Map<string, string> {
  const mapped = new Map<string, string>();
  headers.forEach((value, key) => mapped.set(key.toLowerCase(), value));
  return mapped;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function createBaseHeaders(cookieHeader?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": WECHAT_USER_AGENT,
    Accept: "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9"
  };

  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  return headers;
}

function createYktHeaders(session: YktSession): Record<string, string> {
  const headers: Record<string, string> = {
    ...createBaseHeaders(session.cookieHeader),
    "X-Requested-With": "XMLHttpRequest",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: YKT_ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Referer: `${YKT_ORIGIN}/user/powerfee/index?from=wxminiprogram&token=${encodeURIComponent(session.token)}`
  };

  return headers;
}

function normalizePublicKey(value: string): string {
  if (value.includes("BEGIN PUBLIC KEY")) {
    return value;
  }

  const body = value.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? value;
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

function encryptPassword(password: string, publicKey: string): string {
  return crypto
    .publicEncrypt(
      {
        key: normalizePublicKey(publicKey),
        padding: crypto.constants.RSA_PKCS1_PADDING
      },
      Buffer.from(password, "utf8")
    )
    .toString("base64");
}

function parseLoginJson(text: string): unknown {
  const parsed = parseJson(text);
  if (typeof parsed === "string") {
    throw new HttpError(502, "YKT_LOGIN_RESPONSE_INVALID", "登录响应解析失败。");
  }

  return parsed;
}

async function createYktSession(logger: Logger, captchaResolver: CaptchaResolver | null): Promise<YktSession> {
  if (!captchaResolver) {
    throw new HttpError(409, "YKT_CAPTCHA_RESOLVER_REQUIRED", "验证码服务未就绪。");
  }

  const jar = new CookieJar();

  const loginPage = await fetchWithTimeout(LOGIN_PAGE_URL, {
    headers: createBaseHeaders(),
    redirect: "manual"
  });
  jar.addFromHeaders(loginPage.headers);

  if (loginPage.status < 200 || loginPage.status >= 400) {
    throw new HttpError(loginPage.status, "YKT_LOGIN_PAGE_FAILED", "登录页访问失败。");
  }

  const rsaResponse = await fetchWithTimeout(LOGIN_RSA_URL, {
    headers: {
      ...createBaseHeaders(jar.toHeader()),
      "X-Requested-With": "XMLHttpRequest",
      Referer: LOGIN_PAGE_URL
    }
  });
  jar.addFromHeaders(rsaResponse.headers);
  const rsaText = await rsaResponse.text();
  const rsaPayload = parseLoginJson(rsaText) as RsaResponse;
  if (rsaResponse.status < 200 || rsaResponse.status >= 300 || rsaPayload.code !== 200 || !rsaPayload.pubKey) {
    logger.error(`YKT login RSA request failed | status=${rsaResponse.status} | body=${previewResponseBody(rsaText)}`);
    throw new HttpError(502, "YKT_LOGIN_RSA_FAILED", "登录密钥获取失败。");
  }

  const encryptedPassword = encryptPassword(env.password, rsaPayload.pubKey);
  const captchaResponse = await fetchWithTimeout(`${YKT_ORIGIN}/sso/captchaCode?v=${Date.now()}`, {
    headers: {
      ...createBaseHeaders(jar.toHeader()),
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      Referer: LOGIN_PAGE_URL
    }
  });
  jar.addFromHeaders(captchaResponse.headers);

  if (captchaResponse.status < 200 || captchaResponse.status >= 300) {
    throw new HttpError(captchaResponse.status, "YKT_CAPTCHA_REQUEST_FAILED", "验证码获取失败。");
  }

  const captchaCode = await captchaResolver(Buffer.from(await captchaResponse.arrayBuffer()));
  const loginBody = new URLSearchParams({
    loginType: "rftSigner",
    plat: "",
    account: env.username,
    password: encryptedPassword,
    captchaCode,
    needBind: "",
    bindPlatform: "",
    openid: "",
    unionid: "",
    alipayUserid: "",
    ddUserid: "",
    t: "5",
    renter: ""
  });

  const submitResponse = await fetchWithTimeout(LOGIN_SUBMIT_URL, {
    method: "POST",
    headers: {
      ...createBaseHeaders(jar.toHeader()),
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: YKT_ORIGIN,
      Referer: LOGIN_PAGE_URL
    },
    body: loginBody
  });
  jar.addFromHeaders(submitResponse.headers);
  const submitText = await submitResponse.text();
  const submitPayload = parseLoginJson(submitText) as LoginResponse;

  if (submitResponse.status < 200 || submitResponse.status >= 300 || submitPayload.code !== 200 || !submitPayload.token) {
    logger.error(
      [
        "YKT login failed",
        `status=${submitResponse.status}`,
        `code=${submitPayload.code ?? "unknown"}`,
        `msg=${submitPayload.msg ?? "unknown"}`,
        `body=${previewResponseBody(submitText)}`
      ].join(" | ")
    );
    throw new HttpError(502, "YKT_LOGIN_FAILED", "一卡通登录失败。");
  }

  jar.set("token", submitPayload.token);
  const callbackUrl = `${YKT_ORIGIN}/user/powerfee/index?from=wxminiprogram&token=${encodeURIComponent(submitPayload.token)}`;
  const callbackResponse = await fetchWithTimeout(callbackUrl, {
    headers: createBaseHeaders(jar.toHeader()),
    redirect: "manual"
  });
  jar.addFromHeaders(callbackResponse.headers);

  if (callbackResponse.status < 200 || callbackResponse.status >= 400) {
    logger.error(`YKT login callback failed | status=${callbackResponse.status}`);
    throw new HttpError(502, "YKT_LOGIN_CALLBACK_FAILED", "登录回调失败。");
  }

  logger.info("YKT login completed");
  return {
    token: submitPayload.token,
    cookieHeader: jar.toHeader()
  };
}

async function postYktForm(
  session: YktSession,
  url: string,
  body: URLSearchParams
): Promise<{ response: YktHttpResponse; text: string; payload: unknown }> {
  const requestBody = new URLSearchParams(body);
  requestBody.set("from", "wxminiprogram");
  requestBody.set("token", session.token);

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: createYktHeaders(session),
    body: requestBody
  });
  const text = await response.text();
  const payload = parseJson(text);

  return {
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: toHeadersMap(response.headers),
      text
    },
    text,
    payload
  };
}

function findBalanceValue(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const preferredKeys = [
    "formatPowerBalance",
    "powerBalance",
    "balance",
    "fee",
    "powerFee",
    "remain",
    "remaining",
    "amount",
    "money"
  ];

  for (const record of collectRecords(payload)) {
    for (const key of preferredKeys) {
      const value = readRecordValue(record, [key]);
      if (!value) {
        continue;
      }

      const parsed = parseBalance(value);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return null;
}

function parseBalance(value: string): number | null {
  const normalized = value.replace(/[^\d.-]/g, "");
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function readPayloadText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return "";
  }

  return Object.values(payload as Record<string, unknown>)
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(String)
    .join(" ");
}

function isSessionExpiredResponse(response: YktHttpResponse, text: string, payload: unknown): boolean {
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    return true;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const bodyText = `${text} ${readPayloadText(payload)}`.toLowerCase();
  if (bodyText.includes("过期") || bodyText.includes("失效") || bodyText.includes("未登录") || bodyText.includes("未授权")) {
    return true;
  }

  return (
    contentType.includes("text/html") &&
    (bodyText.includes("/sso/") || bodyText.includes("login") || bodyText.includes("登录") || bodyText.includes("token"))
  );
}

function isSessionExpiredError(error: unknown): boolean {
  return error instanceof HttpError && error.code === "YKT_SESSION_EXPIRED";
}

export class PowerFeeClient {
  private readonly roomInfoCache = new Map<string, ResolvedRoomInfo>();
  private captchaResolver: CaptchaResolver | null = null;
  private session: YktSession | null = null;
  private sessionPromise: Promise<YktSession> | null = null;

  constructor(private readonly logger: Logger) {}

  setCaptchaResolver(captchaResolver: CaptchaResolver): void {
    this.captchaResolver = captchaResolver;
  }

  async initializeSession(): Promise<void> {
    await this.ensureSession();
  }

  isSessionReady(): boolean {
    return this.session !== null;
  }

  async getBalance(location: PowerFeeLocation): Promise<PowerFeeBalance> {
    const schoolAreaNo = normalizeQueryValue("schoolAreaNo", location.schoolAreaNo);
    const session = await this.ensureSession();
    try {
      return await this.getBalanceWithSession(location, schoolAreaNo, session);
    } catch (error) {
      if (!isSessionExpiredError(error)) {
        throw error;
      }

      this.logger.warn("YKT session expired; refreshing session.");
      this.clearSession();
      const refreshedSession = await this.ensureSession();
      return this.getBalanceWithSession(location, schoolAreaNo, refreshedSession);
    }
  }

  private async getBalanceWithSession(location: PowerFeeLocation, schoolAreaNo: string, session: YktSession): Promise<PowerFeeBalance> {
    const resolvedRoom = await this.resolveRoom({
      schoolAreaNo,
      dormBuildingName: location.dormBuildingName,
      roomNumber: location.roomNumber
    }, session);

    try {
      const { response, text, payload } = await postYktForm(
        session,
        BALANCE_URL,
        new URLSearchParams({
          implType: "CGCOMMON0001",
          schoolAreaNo,
          buildingNo: resolvedRoom.buildingNo,
          roomNum: resolvedRoom.roomId,
          from: "wxminiprogram",
          token: ""
        })
      );

      if (isSessionExpiredResponse(response, text, payload)) {
        throw new HttpError(401, "YKT_SESSION_EXPIRED", "登录态已失效。");
      }

      if (response.status < 200 || response.status >= 300) {
        this.logger.error(
          [
            "Power fee balance request failed",
            `status=${response.status}`,
            `statusText=${response.statusText}`,
            `contentType=${response.headers.get("content-type") ?? "unknown"}`,
            `body=${previewResponseBody(text)}`
          ].join(" | ")
        );
        throw new HttpError(response.status, "POWER_FEE_REQUEST_FAILED", "电费查询失败。");
      }

      const balance = findBalanceValue(payload);
      if (balance === null) {
        this.logger.error(`Power fee balance parse failed | payload=${previewPayload(payload)}`);
        throw new HttpError(502, "POWER_FEE_BALANCE_UNREADABLE", "电费余额解析失败。");
      }

      return { balance, raw: payload };
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        this.logger.error(`Power fee balance request timeout after ${REQUEST_TIMEOUT_MS} ms`);
        throw new HttpError(504, "POWER_FEE_REQUEST_TIMEOUT", "电费查询超时。");
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Power fee balance request error | cause=${message}`);
      throw new HttpError(502, "POWER_FEE_REQUEST_ERROR", "电费查询异常。");
    }
  }

  private async ensureSession(): Promise<YktSession> {
    if (this.session) {
      return this.session;
    }

    if (!this.sessionPromise) {
      this.sessionPromise = createYktSession(this.logger, this.captchaResolver)
        .then((session) => {
          this.session = session;
          return session;
        })
        .finally(() => {
          this.sessionPromise = null;
        });
    }

    return this.sessionPromise;
  }

  private clearSession(): void {
    this.session = null;
    this.sessionPromise = null;
    this.roomInfoCache.clear();
  }

  private async resolveRoom(location: PowerFeeLocation, session: YktSession): Promise<ResolvedRoomInfo> {
    const schoolAreaNo = normalizeQueryValue("schoolAreaNo", location.schoolAreaNo);
    const dormBuildingName = normalizeQueryValue("dormBuildingName", location.dormBuildingName);
    const roomNumber = normalizeQueryValue("roomNumber", location.roomNumber);
    const cacheKey = `${schoolAreaNo}:${dormBuildingName}:${roomNumber}`;
    const cached = this.roomInfoCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      const { response, text, payload } = await postYktForm(
        session,
        ROOM_INFO_URL,
        new URLSearchParams({
          from: "",
          token: "",
          implType: "CGCOMMON0001",
          buyMark: ""
        })
      );

      if (isSessionExpiredResponse(response, text, payload)) {
        throw new HttpError(401, "YKT_SESSION_EXPIRED", "登录态已失效。");
      }

      if (response.status < 200 || response.status >= 300) {
        this.logger.error(
          [
            "Room info request failed",
            "method=POST",
            `status=${response.status}`,
            `statusText=${response.statusText}`,
            `contentType=${response.headers.get("content-type") ?? "unknown"}`,
            `body=${previewResponseBody(text)}`
          ].join(" | ")
        );
        throw new HttpError(response.status, "ROOM_INFO_REQUEST_FAILED", "房间索引查询失败。");
      }

      const resolvedRoom = findRoomInfo(payload, dormBuildingName, roomNumber);
      if (!resolvedRoom) {
        this.logger.error(
          [
            "Room info match failed",
            `schoolAreaNo=${schoolAreaNo}`,
            `dormBuildingName=${dormBuildingName}`,
            `roomNumber=${roomNumber}`,
            `payload=${previewPayload(payload)}`
          ].join(" | ")
        );
        throw new HttpError(502, "ROOM_INFO_NOT_FOUND", "未找到匹配的宿舍房间。");
      }

      this.roomInfoCache.set(cacheKey, resolvedRoom);
      return resolvedRoom;
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        this.logger.error(`Room info request timeout after ${REQUEST_TIMEOUT_MS} ms`);
        throw new HttpError(504, "ROOM_INFO_REQUEST_TIMEOUT", "房间索引查询超时。");
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Room info request error | cause=${message}`);
      throw new HttpError(502, "ROOM_INFO_REQUEST_ERROR", "房间索引查询异常。");
    }
  }
}

function findRoomInfo(payload: unknown, dormBuildingName: string, roomNumber: string): ResolvedRoomInfo | null {
  return findRoomInfoRecursive(payload, dormBuildingName, roomNumber, {
    buildingMatched: false,
    buildingNo: null
  });
}

type RoomInfoSearchContext = {
  buildingMatched: boolean;
  buildingNo: string | null;
};

function findRoomInfoRecursive(
  value: unknown,
  dormBuildingName: string,
  roomNumber: string,
  context: RoomInfoSearchContext
): ResolvedRoomInfo | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolvedRoom = findRoomInfoRecursive(item, dormBuildingName, roomNumber, context);
      if (resolvedRoom) {
        return resolvedRoom;
      }
    }

    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const scalarText = readScalarText(record);
  const recordHasBuildingName = scalarText.includes(dormBuildingName);
  const recordHasRoomNumber = scalarText.includes(roomNumber);
  const recordBuildingNo = readRecordValue(record, ["buildingNo", "buildNo", "buildingId", "buildingid", "buildId"]);
  const nextContext: RoomInfoSearchContext = {
    buildingMatched: context.buildingMatched || recordHasBuildingName,
    buildingNo: recordHasBuildingName && recordBuildingNo ? recordBuildingNo : context.buildingNo
  };
  const roomId = readRecordValue(record, ["roomId", "roomid", "roomNo", "roomNum", "roomCode", "id"]);

  if (nextContext.buildingMatched && nextContext.buildingNo && recordHasRoomNumber && roomId) {
    return { buildingNo: nextContext.buildingNo, roomId };
  }

  if (recordHasBuildingName && recordHasRoomNumber && recordBuildingNo && roomId) {
    return { buildingNo: recordBuildingNo, roomId };
  }

  for (const child of Object.values(record)) {
    const resolvedRoom = findRoomInfoRecursive(child, dormBuildingName, roomNumber, nextContext);
    if (resolvedRoom) {
      return resolvedRoom;
    }
  }

  return null;
}

function readScalarText(record: Record<string, unknown>): string {
  return Object.values(record)
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(String)
    .join(" ");
}

function collectRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(collectRecords);
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(collectRecords)];
}

function readRecordValue(record: Record<string, unknown>, keys: string[]): string | null {
  const normalizedEntries = Object.entries(record).map(([key, value]) => [key.toLowerCase(), value] as const);

  for (const key of keys) {
    const found = normalizedEntries.find(([entryKey]) => entryKey === key.toLowerCase());
    const value = found?.[1];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}
