import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { executeDerez } from "./derez.js";
import {
    grid,
    logConnection,
    logDisconnection,
    logKillWordDetected,
    logProxyError,
} from "./logger.js";

// ─── PROXY ──────────────────────────────────────────────────────────────────
// The transparent proxy sits on TRON_PORT (18789) and silently forwards all
// HTTP and WebSocket traffic to OpenClaw on OPENCLAW_PORT (18790).
// It inspects every client→OpenClaw message for the kill word.

// Headers that must be stripped so OpenClaw sees connections as local
const STRIPPED_HEADERS = new Set([
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-real-ip",
    "cf-connecting-ip",
    "cf-ray",
    "cf-visitor",
    "cf-ipcountry",
    "true-client-ip",
    "x-client-ip",
    "forwarded",
    "via",
]);

interface ProxyConfig {
    tronPort: number;
    openclawPort: number;
    killWord: string;
    gatewayToken: string;
}

/**
 * Check if a raw string matches the kill word exactly.
 * Must be exactly the kill word, or prefixed with "!" (case-insensitive).
 */
function matchesKillWord(text: string, killWord: string): boolean {
    const trimmed = text.trim();
    const upper = trimmed.toUpperCase();
    const killUpper = killWord.toUpperCase();
    return upper === killUpper || upper === `!${killUpper}`;
}

/**
 * Recursively search all string values in an object for the kill word.
 * Returns true if any string value is an exact match.
 */
function deepSearchKillWord(obj: unknown, killWord: string): boolean {
    if (typeof obj === "string") {
        return matchesKillWord(obj, killWord);
    }
    if (Array.isArray(obj)) {
        return obj.some((item) => deepSearchKillWord(item, killWord));
    }
    if (obj !== null && typeof obj === "object") {
        return Object.values(obj as Record<string, unknown>).some((val) =>
            deepSearchKillWord(val, killWord)
        );
    }
    return false;
}

/**
 * Check if a message (raw or JSON-encoded) contains the kill word.
 * 1. Tries exact match on the raw string
 * 2. Parses as JSON and recursively checks all string values
 */
function isKillWord(message: string, killWord: string): boolean {
    // Direct match on raw message
    if (matchesKillWord(message, killWord)) {
        return true;
    }

    // Try parsing as JSON and searching inside
    try {
        const parsed = JSON.parse(message);
        return deepSearchKillWord(parsed, killWord);
    } catch {
        // Not JSON — already checked raw, so no match
        return false;
    }
}

/**
 * Strip forwarding headers and set Host to TRON's port.
 */
function sanitizeHeaders(
    rawHeaders: http.IncomingHttpHeaders,
    tronPort: number
): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
        if (STRIPPED_HEADERS.has(key.toLowerCase())) continue;
        if (key.toLowerCase() === "host") {
            clean[key] = `localhost:${tronPort}`;
            continue;
        }
        if (value !== undefined) {
            clean[key] = Array.isArray(value) ? value.join(", ") : value;
        }
    }
    return clean;
}

/**
 * Start the transparent proxy server on tronPort.
 */
export function startProxy(config: ProxyConfig): Promise<void> {
    return new Promise((resolve, reject) => {
        const { tronPort, openclawPort, killWord, gatewayToken } = config;

        // ─── HTTP pass-through ────────────────────────────────────────────
        const server = http.createServer(async (req, res) => {
            const clientIp =
                req.socket.remoteAddress ?? "unknown";

            try {
                // Read request body
                const bodyChunks: Buffer[] = [];
                for await (const chunk of req) {
                    bodyChunks.push(chunk as Buffer);
                }
                const body = Buffer.concat(bodyChunks);
                const bodyStr = body.toString("utf-8");

                // Check for kill word in request body
                if (bodyStr && isKillWord(bodyStr, killWord)) {
                    logKillWordDetected(clientIp, `HTTP ${req.method} ${req.url}`);
                    const result = await executeDerez(openclawPort, gatewayToken);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(
                        JSON.stringify({
                            message: "[TRON] Corrupted program derezzed. The Grid is safe.",
                            result,
                        })
                    );
                    return;
                }

                // Forward to OpenClaw
                const targetUrl = `http://localhost:${openclawPort}${req.url}`;
                const headers = sanitizeHeaders(req.headers, tronPort);

                const proxyRes = await fetch(targetUrl, {
                    method: req.method,
                    headers,
                    body: ["GET", "HEAD"].includes(req.method ?? "GET")
                        ? undefined
                        : body,
                    // @ts-expect-error - duplex needed for Node fetch with body
                    duplex: "half",
                });

                // Forward response back to client
                const responseHeaders: Record<string, string> = {};
                proxyRes.headers.forEach((value, key) => {
                    responseHeaders[key] = value;
                });

                res.writeHead(proxyRes.status, responseHeaders);

                if (proxyRes.body) {
                    const reader = proxyRes.body.getReader();
                    const pump = async (): Promise<void> => {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            res.write(value);
                        }
                        res.end();
                    };
                    await pump();
                } else {
                    res.end();
                }
            } catch (err) {
                logProxyError(`HTTP proxy (${req.method} ${req.url})`, err);
                if (!res.headersSent) {
                    res.writeHead(502, { "Content-Type": "application/json" });
                    res.end(
                        JSON.stringify({
                            error: "[TRON] Cannot reach OpenClaw. The Grid may be down.",
                        })
                    );
                }
            }
        });

        // ─── WebSocket proxy ──────────────────────────────────────────────
        const wss = new WebSocketServer({ noServer: true });

        server.on("upgrade", (req, socket, head) => {
            const clientIp = req.socket.remoteAddress ?? "unknown";

            wss.handleUpgrade(req, socket, head, (clientWs) => {
                logConnection(clientIp);

                // Sanitize headers for the outbound connection
                const outboundHeaders = sanitizeHeaders(req.headers, tronPort);

                // Connect to OpenClaw
                const openclawWs = new WebSocket(
                    `ws://localhost:${openclawPort}${req.url}`,
                    {
                        headers: outboundHeaders,
                    }
                );

                let clientAlive = true;
                let openclawAlive = true;

                // ── Client → OpenClaw ──
                clientWs.on("message", (data, isBinary) => {
                    if (!openclawAlive) return;

                    // Inspect for kill word (text messages only)
                    if (!isBinary) {
                        const messageStr = data.toString("utf-8");

                        // Log message inspection (truncate for readability)
                        const preview = messageStr.length > 200
                            ? messageStr.slice(0, 200) + "..."
                            : messageStr;
                        grid.info(
                            { clientIp },
                            "[GRID] Inspecting message from %s: %s",
                            clientIp,
                            preview
                        );

                        if (isKillWord(messageStr, killWord)) {
                            logKillWordDetected(clientIp, "WebSocket");
                            executeDerez(openclawPort, gatewayToken).then(() => {
                                try {
                                    clientWs.send(
                                        "[TRON] Corrupted program derezzed. The Grid is safe."
                                    );
                                } catch {
                                    // Client may already be disconnected
                                }
                            });
                            return; // Don't forward the kill word
                        }
                    }

                    try {
                        openclawWs.send(data, { binary: isBinary });
                    } catch {
                        // OpenClaw connection lost
                    }
                });

                // ── OpenClaw → Client ──
                openclawWs.on("message", (data, isBinary) => {
                    if (!clientAlive) return;
                    try {
                        clientWs.send(data, { binary: isBinary });
                    } catch {
                        // Client connection lost
                    }
                });

                // ── Connection lifecycle ──
                openclawWs.on("open", () => {
                    grid.info(
                        { clientIp },
                        "[GRID] Outbound connection to OpenClaw established for %s",
                        clientIp
                    );
                });

                openclawWs.on("error", (err) => {
                    logProxyError("OpenClaw WebSocket", err);
                    openclawAlive = false;
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.close(1011, "OpenClaw connection error");
                    }
                });

                openclawWs.on("close", (code, reason) => {
                    openclawAlive = false;
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.close(code, reason.toString());
                    }
                    logDisconnection(clientIp, `OpenClaw closed (${code})`);
                });

                clientWs.on("error", (err) => {
                    logProxyError("Client WebSocket", err);
                    clientAlive = false;
                    if (openclawWs.readyState === WebSocket.OPEN) {
                        openclawWs.close(1011, "Client connection error");
                    }
                });

                clientWs.on("close", (code, reason) => {
                    clientAlive = false;
                    if (openclawWs.readyState === WebSocket.OPEN) {
                        openclawWs.close(code, reason.toString());
                    }
                    logDisconnection(clientIp, `Client closed (${code})`);
                });

                // ── Ping/Pong for 24h timeout ──
                const pingInterval = setInterval(() => {
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.ping();
                    }
                    if (openclawWs.readyState === WebSocket.OPEN) {
                        openclawWs.ping();
                    }
                }, 30000); // Ping every 30s

                // Set 24-hour timeout
                const timeout = setTimeout(() => {
                    grid.info("[GRID] 24h timeout reached for %s — disconnecting", clientIp);
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.close(1000, "24h timeout");
                    }
                }, 86400000); // 86400 seconds = 24 hours

                const cleanup = (): void => {
                    clearInterval(pingInterval);
                    clearTimeout(timeout);
                };

                clientWs.on("close", cleanup);
                openclawWs.on("close", cleanup);
            });
        });

        // ─── Start listening ──────────────────────────────────────────────
        server.on("error", (err) => {
            logProxyError("Proxy server", err);
            reject(err);
        });

        server.listen(tronPort, () => {
            grid.info(
                "[GRID] Proxy server online — intercepting port %d, forwarding to %d",
                tronPort,
                openclawPort
            );
            resolve();
        });
    });
}
