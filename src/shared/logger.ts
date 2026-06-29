import type { NextFunction, Request, Response } from "express";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
const MAX_BODY_LENGTH = 2048;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
};

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatTimestamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());

  return `${year}-${month}-${day}-${hour}:${minute}`;
}

export class Logger {
  constructor(private readonly minimumLevel: LogLevel) {}

  debug(message: string): void {
    this.write("DEBUG", message);
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }

  private write(level: LogLevel, message: string): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minimumLevel]) {
      return;
    }

    const line = `[${formatTimestamp()}] ${level} - ${message}`;
    const stream = level === "ERROR" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  }
}

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
