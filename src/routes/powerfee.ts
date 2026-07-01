import { Router, type Request } from "express";
import { env } from "../config/env.js";
import { HttpError } from "../shared/error.js";
import { PowerFeeMonitor } from "../services/powerfee/monitor.js";
import type { PowerFeeLocation } from "../services/powerfee/client.js";

type ManualCheckBody = {
  accessToken?: unknown;
  debugPush?: unknown;
  schoolAreaNo?: unknown;
  dormBuildingName?: unknown;
  roomNumber?: unknown;
  captchaCode?: unknown;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return readString(value[0]);
  }

  return readString(value);
}

function readAccessToken(request: Request, body: ManualCheckBody | undefined) {
  const authorization = readHeaderValue(request.headers.authorization);
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return readHeaderValue(request.headers["x-access-token"]) ?? readString(request.query.accessToken) ?? readString(body?.accessToken);
}

function readCronSecret(request: Request): string | undefined {
  const authorization = readHeaderValue(request.headers.authorization);
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return readHeaderValue(request.headers["x-cron-secret"]) ?? readString(request.query.cronSecret);
}

function buildLocationOverride(body: ManualCheckBody | undefined): Partial<PowerFeeLocation> | undefined {
  const location: Partial<PowerFeeLocation> = {};
  const schoolAreaNo = readString(body?.schoolAreaNo);
  const dormBuildingName = readString(body?.dormBuildingName);
  const roomNumber = readString(body?.roomNumber);

  if (schoolAreaNo) {
    location.schoolAreaNo = schoolAreaNo;
  }

  if (dormBuildingName) {
    location.dormBuildingName = dormBuildingName;
  }

  if (roomNumber) {
    location.roomNumber = roomNumber;
  }

  return Object.keys(location).length ? location : undefined;
}

function assertAccessAuthorized(request: Request, body: ManualCheckBody | undefined): void {
  if (!env.accessToken) {
    throw new HttpError(503, "ACCESS_TOKEN_NOT_CONFIGURED", "访问令牌未配置。");
  }

  if (readAccessToken(request, body) !== env.accessToken) {
    throw new HttpError(401, "UNAUTHORIZED", "访问令牌无效。");
  }
}

export function createPowerFeeRouter(monitor: PowerFeeMonitor) {
  const router = Router();

  router.post("/powerfee/fetch", async (request, response, next) => {
    try {
      const body = request.body as ManualCheckBody | undefined;
      assertAccessAuthorized(request, body);

      const location = buildLocationOverride(body);
      const result = await monitor.runManualCheck({
        debugPush: body?.debugPush === true,
        ...(location ? { location } : {})
      });

      response.status(200).json({
        balance: result.balance,
        reminded: result.reminded,
        repeated: result.repeated,
        debugPushed: result.debugPushed,
        nextRunAt: result.nextRunAt,
        raw: result.raw
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/powerfee/login/captcha", async (request, response, next) => {
    try {
      const body = request.body as ManualCheckBody | undefined;
      assertAccessAuthorized(request, body);

      const captcha = await monitor.createLoginCaptcha();

      response.status(200).json({
        captchaImageBase64: captcha.toString("base64"),
        expiresInSeconds: 600
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/powerfee/login/complete", async (request, response, next) => {
    try {
      const body = request.body as ManualCheckBody | undefined;
      assertAccessAuthorized(request, body);
      const captchaCode = readString(body?.captchaCode);
      if (!captchaCode || !/^\d{4}$/.test(captchaCode)) {
        throw new HttpError(400, "INVALID_CAPTCHA_CODE", "验证码格式无效。");
      }

      const balance = await monitor.completeLoginCaptcha(captchaCode);

      response.status(200).json({
        balance
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/powerfee/cron", async (request, response, next) => {
    try {
      if (!env.cronSecret) {
        throw new HttpError(503, "CRON_SECRET_NOT_CONFIGURED", "定时任务密钥未配置。");
      }

      if (readCronSecret(request) !== env.cronSecret) {
        throw new HttpError(401, "UNAUTHORIZED", "定时任务密钥无效。");
      }

      const result = await monitor.runManualCheck({ debugPush: false });

      response.status(200).json({
        balance: result.balance,
        reminded: result.reminded,
        repeated: result.repeated,
        debugPushed: result.debugPushed,
        nextRunAt: result.nextRunAt
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
