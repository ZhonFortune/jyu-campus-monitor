import { env } from "../config/env.js";
import { HttpError } from "../shared/http-error.js";
import type { Logger } from "../shared/logger.js";

const BALANCE_URL = "https://yktportal.jyu.edu.cn/user/powerfee/getBalance";
const ROOM_INFO_URL = "https://yktportal.jyu.edu.cn/user/powerfee/getRoomInfo";
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_PREVIEW_LIMIT = 800;

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

function createHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Requested-With": "XMLHttpRequest",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: "https://yktportal.jyu.edu.cn",
    Referer: "https://yktportal.jyu.edu.cn/user/powerfee/index"
  };

  if (env.yktSessionId) {
    headers.Cookie = `JSESSIONID=${env.yktSessionId}`;
  }

  return headers;
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

export class PowerFeeClient {
  private readonly roomInfoCache = new Map<string, ResolvedRoomInfo>();

  constructor(private readonly logger: Logger) {}

  async getBalance(location: PowerFeeLocation): Promise<PowerFeeBalance> {
    const schoolAreaNo = normalizeQueryValue("schoolAreaNo", location.schoolAreaNo);
    const resolvedRoom = await this.resolveRoom({
      schoolAreaNo,
      dormBuildingName: location.dormBuildingName,
      roomNumber: location.roomNumber
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(BALANCE_URL, {
        method: "POST",
        headers: createHeaders(),
        body: new URLSearchParams({
          implType: "CGCOMMON0001",
          schoolAreaNo,
          buildingNo: resolvedRoom.buildingNo,
          roomNum: resolvedRoom.roomId,
          from: "",
          token: ""
        }),
        signal: controller.signal
      });

      const text = await response.text();
      const payload = parseJson(text);

      if (!response.ok) {
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
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveRoom(location: PowerFeeLocation): Promise<ResolvedRoomInfo> {
    const schoolAreaNo = normalizeQueryValue("schoolAreaNo", location.schoolAreaNo);
    const dormBuildingName = normalizeQueryValue("dormBuildingName", location.dormBuildingName);
    const roomNumber = normalizeQueryValue("roomNumber", location.roomNumber);
    const cacheKey = `${schoolAreaNo}:${dormBuildingName}:${roomNumber}`;
    const cached = this.roomInfoCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(ROOM_INFO_URL, {
        method: "POST",
        headers: createHeaders(),
        body: new URLSearchParams({
          from: "",
          token: "",
          implType: "CGCOMMON0001",
          buyMark: ""
        }),
        signal: controller.signal
      });
      const text = await response.text();
      const payload = parseJson(text);

      if (!response.ok) {
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
    } finally {
      clearTimeout(timeout);
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
