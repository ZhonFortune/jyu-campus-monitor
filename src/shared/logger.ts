type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

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
