import type { ErrorRequestHandler } from "express";
import type { Logger } from "./logger.js";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

type ErrorResponse = {
  error: {
    code: string;
    message: string;
  };
};

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error, request, response, _next): void => {
    const isHttpError = error instanceof HttpError;
    const statusCode = isHttpError ? error.statusCode : 500;
    const code = isHttpError ? error.code : "INTERNAL_SERVER_ERROR";
    const message = isHttpError ? error.message : "Service temporarily unavailable.";

    logger.error(`${request.method} ${request.originalUrl} - ${code} - ${statusCode}`);

    const payload: ErrorResponse = {
      error: {
        code,
        message
      }
    };

    if (process.env.NODE_ENV !== "production" && error instanceof Error && !isHttpError) {
      logger.debug(error.stack ?? error.message);
    }

    response.status(statusCode).json(payload);
  };
}
