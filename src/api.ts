import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { executeDerez, derezByName } from "./derez.js";
import { grid, logAuthAttempt, logApiCall } from "./logger.js";

// ─── REMOTE API ─────────────────────────────────────────────────────────────
// The Fastify HTTPS server on TRON_API_PORT (9999) provides remote DEREZ
// capability — trigger the kill chain from a phone, another machine, or
// a one-tap iOS/Android Shortcut. Secured with the Identity Disc (Bearer token).

interface ApiConfig {
    apiPort: number;
    openclawPort: number;
    discKey: string;
    gatewayToken: string;
}

/**
 * Ensure TLS certificate files exist. If not, generate self-signed ones.
 */
function ensureTlsCerts(): { cert: string; key: string } {
    const certPath = path.resolve(process.cwd(), "tron.cert.pem");
    const keyPath = path.resolve(process.cwd(), "tron.key.pem");

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        grid.info("[GRID] TLS certs found — %s, %s", certPath, keyPath);
        return {
            cert: fs.readFileSync(certPath, "utf-8"),
            key: fs.readFileSync(keyPath, "utf-8"),
        };
    }

    grid.warn("[GRID] No TLS certs found — generating self-signed Identity Disc certs...");
    grid.warn("[GRID] ⚠ Replace tron.cert.pem and tron.key.pem with real certs for production.");

    // Generate RSA key pair
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    // Write the private key
    fs.writeFileSync(keyPath, privateKey);

    // Try to generate a self-signed cert using openssl
    try {
        const subj =
            process.platform === "win32"
                ? "/CN=TRON/O=TheGrid/C=US"
                : "/CN=TRON/O=TheGrid/C=US";

        execSync(
            `openssl req -new -x509 -key "${keyPath}" -out "${certPath}" -days 365 -subj "${subj}" -nodes`,
            { timeout: 10000, stdio: "pipe" }
        );

        grid.info("[GRID] Self-signed TLS certs generated — valid for 365 days.");
        return {
            cert: fs.readFileSync(certPath, "utf-8"),
            key: privateKey,
        };
    } catch {
        // openssl not available — try PowerShell on Windows
        if (process.platform === "win32") {
            try {
                execSync(
                    `powershell -Command "` +
                    `$cert = New-SelfSignedCertificate -DnsName 'TRON' -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddDays(365); ` +
                    `$pwd = ConvertTo-SecureString -String 'tron' -Force -AsPlainText; ` +
                    `Export-PfxCertificate -Cert $cert -FilePath tron.pfx -Password $pwd; ` +
                    `openssl pkcs12 -in tron.pfx -out '${certPath}' -clcerts -nokeys -password pass:tron; ` +
                    `Remove-Item tron.pfx"`,
                    { timeout: 30000, stdio: "pipe" }
                );
                if (fs.existsSync(certPath)) {
                    grid.info("[GRID] Self-signed TLS cert generated via PowerShell.");
                    return {
                        cert: fs.readFileSync(certPath, "utf-8"),
                        key: privateKey,
                    };
                }
            } catch {
                // PowerShell method also failed
            }
        }

        grid.warn("[GRID] Could not generate TLS cert — starting remote API WITHOUT TLS.");
        grid.warn("[GRID] Use a reverse proxy (nginx, Caddy) for production TLS!");
        return { cert: "", key: privateKey };
    }
}

/**
 * Check if OpenClaw is running on the specified port.
 */
async function isOpenClawRunning(port: number): Promise<boolean> {
    try {
        const findProcess = (await import("find-process")).default;
        const processes = await findProcess("port", port);
        return processes.length > 0;
    } catch {
        return false;
    }
}

/**
 * Start the Fastify remote REST API server.
 */
export async function startApi(config: ApiConfig): Promise<void> {
    const { apiPort, openclawPort, discKey, gatewayToken } = config;

    // Get TLS certs
    const tls = ensureTlsCerts();

    const useTls = tls.cert.length > 0;

    const fastify = Fastify({
        logger: false, // We use our own pino logger
        ...(useTls
            ? {
                https: {
                    cert: tls.cert,
                    key: tls.key,
                },
            }
            : {}),
    });

    // ─── Rate limiting ──────────────────────────────────────────────────
    await fastify.register(rateLimit, {
        max: 10,
        timeWindow: "1 minute",
        keyGenerator: (req: FastifyRequest) => req.ip,
        errorResponseBuilder: () => ({
            statusCode: 429,
            error: "Too Many Requests",
            message: "[TRON] Rate limit exceeded. The Grid prevents brute-force intrusions.",
        }),
    });

    // ─── Auth middleware (Identity Disc validation) ─────────────────────
    fastify.addHook(
        "onRequest",
        async (request: FastifyRequest, reply: FastifyReply) => {
            const endpoint = `${request.method} ${request.url}`;
            const ip = request.ip;
            const authHeader = request.headers.authorization;

            if (!authHeader || !authHeader.startsWith("Bearer ")) {
                logAuthAttempt(ip, false, endpoint);
                return reply.status(403).send({
                    error: "[TRON] Identity Disc required. Access denied.",
                });
            }

            const token = authHeader.slice(7);
            if (token !== discKey) {
                logAuthAttempt(ip, false, endpoint);
                return reply.status(403).send({
                    error: "[TRON] Invalid Identity Disc. Access denied.",
                });
            }

            logAuthAttempt(ip, true, endpoint);
        }
    );

    // ─── Response logging ───────────────────────────────────────────────
    fastify.addHook(
        "onResponse",
        async (request: FastifyRequest, reply: FastifyReply) => {
            logApiCall(request.ip, request.method, request.url, reply.statusCode);
        }
    );

    // ─── Routes ─────────────────────────────────────────────────────────

    // GET /status — Grid status
    fastify.get("/status", async () => {
        const running = await isOpenClawRunning(openclawPort);
        return {
            grid: "TRON",
            status: "online",
            openClaw: {
                port: openclawPort,
                running,
                status: running ? "active" : "derezzed",
            },
            message: running
                ? "[TRON] OpenClaw is running. The Grid is monitored."
                : "[TRON] OpenClaw is not detected. The Grid is clear.",
        };
    });

    // POST /derez — Full kill chain
    fastify.post("/derez", async () => {
        grid.warn("[GRID] Remote DEREZ triggered via REST API");
        const result = await executeDerez(openclawPort, gatewayToken);
        return {
            grid: "TRON",
            ...result,
            message: result.success
                ? "[TRON] Corrupted program derezzed. The Grid is safe."
                : "[TRON] DEREZ failed. Corrupted program persists.",
        };
    });

    // POST /derez/:target — Kill specific process
    fastify.post<{ Params: { target: string } }>(
        "/derez/:target",
        async (request) => {
            const { target } = request.params;
            grid.warn("[GRID] Remote DEREZ by name triggered — target: %s", target);
            const result = await derezByName(target);
            return {
                grid: "TRON",
                ...result,
            };
        }
    );

    // ─── Start server ──────────────────────────────────────────────────
    try {
        await fastify.listen({ port: apiPort, host: "0.0.0.0" });
        const protocol = useTls ? "HTTPS" : "HTTP";
        grid.info(
            "[GRID] Remote API online — %s://0.0.0.0:%d — Identity Disc required for all endpoints",
            protocol,
            apiPort
        );
    } catch (err) {
        grid.error({ err }, "[GRID] Failed to start remote API");
        throw err;
    }
}
