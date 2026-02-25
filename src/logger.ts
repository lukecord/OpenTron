import pino from "pino";
import { createWriteStream } from "fs";
import path from "path";

// ─── THE GRID ───────────────────────────────────────────────────────────────
// Structured logging for TRON — every event on the Grid is recorded.

const logFilePath = path.resolve(process.cwd(), "grid.log");

const fileStream = createWriteStream(logFilePath, { flags: "a" });

const streams: pino.StreamEntry[] = [
    { level: "info", stream: process.stdout },
    { level: "info", stream: fileStream },
];

export const grid = pino(
    {
        level: "info",
        timestamp: pino.stdTimeFunctions.isoTime,
        base: { grid: "TRON" },
        formatters: {
            level(label: string) {
                return { level: label };
            },
        },
    },
    pino.multistream(streams)
);

// ─── Convenience helpers ────────────────────────────────────────────────────

export function logStartup(tronPort: number, apiPort: number): void {
    grid.info(
        { tronPort, apiPort },
        "[GRID] TRON online — proxy on %d, remote API on %d. The Grid is watching.",
        tronPort,
        apiPort
    );
}

export function logConnection(clientIp: string): void {
    grid.info({ clientIp }, "[GRID] Program connected from %s", clientIp);
}

export function logDisconnection(clientIp: string, reason?: string): void {
    grid.info(
        { clientIp, reason },
        "[GRID] Program disconnected from %s — %s",
        clientIp,
        reason ?? "connection closed"
    );
}

export function logKillWordDetected(clientIp: string, channel: string): void {
    grid.warn(
        { clientIp, channel },
        "[GRID] ⚡ Kill word detected from %s (channel: %s) — initiating DEREZ sequence",
        clientIp,
        channel
    );
}

export function logDerezStep(
    step: number,
    description: string,
    success: boolean,
    error?: string
): void {
    const level = success ? "info" : "warn";
    grid[level](
        { step, success, error },
        "[GRID] DEREZ step %d (%s): %s",
        step,
        description,
        success ? "SUCCESS" : `FAILED — ${error}`
    );
}

export function logAuthAttempt(
    ip: string,
    success: boolean,
    endpoint: string
): void {
    const level = success ? "info" : "warn";
    grid[level](
        { ip, success, endpoint },
        "[GRID] Identity Disc %s from %s on %s",
        success ? "validated" : "REJECTED",
        ip,
        endpoint
    );
}

export function logApiCall(
    ip: string,
    method: string,
    path: string,
    statusCode: number
): void {
    grid.info(
        { ip, method, path, statusCode },
        "[GRID] API %s %s from %s → %d",
        method,
        path,
        ip,
        statusCode
    );
}

export function logProxyError(context: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    grid.error({ context, error: message }, "[GRID] Proxy error in %s: %s", context, message);
}
