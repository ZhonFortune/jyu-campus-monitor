import type { NextFunction, Request, Response } from "express";
import type { Logger } from "../shared/logger.js";

const MAX_BODY_LENGTH = 2048;

function toRequestJson(body: unknown): string {
  if (body === undefined || body === null) {
    return "{}";
  }

  try {
    const json = JSON.stringify(body);
    if (!json) {
      return "{}";
    }

    return json.length > MAX_BODY_LENGTH ? `${json.slice(0, MAX_BODY_LENGTH)}...` : json;
  } catch {
    return "{\"error\":\"unserializable_request_body\"}";
  }
}

export function createHttpLogger(logger: Logger) {
  return (request: Request, response: Response, next: NextFunction): void => {
    response.on("finish", () => {
      const requestJson = toRequestJson(request.body);
      logger.info(`${request.method} ${request.originalUrl} - ${requestJson} - ${response.statusCode}`);
    });

    next();
  };
}
