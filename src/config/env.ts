import dotenv from "dotenv";

dotenv.config({ override: true });

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const DEFAULT_PORT = 6888;
const DEFAULT_SCHOOL_AREA_NO = "1";
const DEFAULT_POWER_FEE_REMIND_THRESHOLD = 20;
const DEFAULT_POWER_FEE_REPEAT_THRESHOLD = 10;
const ALLOWED_LOG_LEVELS = new Set<LogLevel>(["DEBUG", "INFO", "WARN", "ERROR"]);

function parsePort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return port;
}

function parseCorsOrigin(value: string | undefined): string {
  return value?.trim() || "*";
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = (value ?? "INFO").toUpperCase();
  if (!ALLOWED_LOG_LEVELS.has(level as LogLevel)) {
    throw new Error("LOG_LEVEL must be one of DEBUG, INFO, WARN, ERROR.");
  }

  return level as LogLevel;
}

function parseRequiredString(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function parseOptionalString(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function parseOptionalStringList(name: string): readonly string[] {
  const value = process.env[name]?.trim();
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${name} must be true or false.`);
}

function parseVercelUrl(value: string | undefined): string | null {
  const trimmedValue = value?.trim();
  if (!trimmedValue) {
    return null;
  }

  return trimmedValue.startsWith("http://") || trimmedValue.startsWith("https://") ? trimmedValue : `https://${trimmedValue}`;
}

function parseDefaultTelegramWebhookUrl(): string | null {
  return parseVercelUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) ?? parseVercelUrl(process.env.VERCEL_URL);
}

function parseOptionalHttpUrl(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) {
    return null;
  }

  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an HTTP or HTTPS URL.`);
  }

  return url.toString();
}

function parsePositiveNumber(name: string, defaultValue: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return defaultValue;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a number greater than or equal to 0.`);
  }

  return value;
}

function parseThresholds() {
  const remindThreshold = parsePositiveNumber("POWER_FEE_REMIND_THRESHOLD", DEFAULT_POWER_FEE_REMIND_THRESHOLD);
  const repeatThreshold = parsePositiveNumber("POWER_FEE_REPEAT_THRESHOLD", DEFAULT_POWER_FEE_REPEAT_THRESHOLD);

  if (repeatThreshold >= remindThreshold) {
    throw new Error("POWER_FEE_REPEAT_THRESHOLD must be lower than POWER_FEE_REMIND_THRESHOLD.");
  }

  return { remindThreshold, repeatThreshold };
}

const thresholds = parseThresholds();

export const env = {
  port: parsePort(process.env.PORT),
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN),
  accessToken: parseOptionalString("ACCESS_TOKEN"),
  cronSecret: parseOptionalString("CRON_SECRET"),
  telegramBotToken: parseOptionalString("TELEGRAM_BOT_TOKEN"),
  telegramWebhookUrl: parseOptionalString("TELEGRAM_WEBHOOK_URL") ?? parseDefaultTelegramWebhookUrl(),
  telegramWebhookSecret: parseOptionalString("TELEGRAM_WEBHOOK_SECRET"),
  telegramChatIds: parseOptionalStringList("TELEGRAM_CHAT_IDS"),
  useCnProxy: parseBoolean("USE_CN_PROXY", false),
  chinaRelayUrl: parseOptionalHttpUrl("CHINA_RELAY_URL"),
  chinaRelaySecret: parseOptionalString("CHINA_RELAY_SECRET"),
  username: parseRequiredString("USERNAME"),
  password: parseRequiredString("PASSWORD"),
  powerFeeRemindThreshold: thresholds.remindThreshold,
  powerFeeRepeatThreshold: thresholds.repeatThreshold,
  schoolAreaNo: process.env.SCHOOL_AREA_NO?.trim() || DEFAULT_SCHOOL_AREA_NO,
  dormBuildingName: parseRequiredString("DORM_BUILDING_NAME"),
  roomNumber: parseRequiredString("ROOM_NUMBER")
} as const;
