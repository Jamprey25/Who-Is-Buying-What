import fs from "fs";
import path from "path";

export interface Filing {
  accessionNumber: string;
  formType: string;
  companyName: string;
  [key: string]: unknown;
}

interface FilteredLogEntry {
  timestamp: string;
  accessionNumber: string;
  formType: string;
  companyName: string;
  reason: string;
}

const LOGS_DIR = path.resolve(process.cwd(), "logs");

function getLogPath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOGS_DIR, `filtered.${date}.jsonl`);
}

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

export function logFiltered(filing: Filing, reason: string): void {
  const entry: FilteredLogEntry = {
    timestamp: new Date().toISOString(),
    accessionNumber: filing.accessionNumber ?? "",
    formType: filing.formType ?? "",
    companyName: filing.companyName ?? "",
    reason: reason ?? "unspecified",
  };

  const line = JSON.stringify(entry) + "\n";

  try {
    ensureLogsDir();
    fs.appendFileSync(getLogPath(), line, "utf8");
  } catch (err) {
    console.error(
      `[auditLogger] Failed to write filtered log entry for ${entry.accessionNumber}:`,
      err
    );
  }
}
