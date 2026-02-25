import "dotenv/config";
import { startProxy } from "./proxy.js";
import { startApi } from "./api.js";
import { grid, logStartup } from "./logger.js";

// ─── TRON — Trusted Runtime Oversight Node ─────────────────────────────────
//
//   "I fight for the users."
//
//   TRON is a guardian program — a transparent proxy that silently monitors
//   all traffic flowing to OpenClaw and can execute an instant kill (DEREZ)
//   when a corrupted program is detected.
//
// ────────────────────────────────────────────────────────────────────────────

// ─── Configuration ──────────────────────────────────────────────────────────

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        grid.error("[GRID] ✕ Missing required env var: %s", name);
        console.error(
            `\n  ✕ TRON cannot initialize without ${name}.\n` +
            `    Set it in your .env file or export it.\n` +
            `    See .env.example for configuration reference.\n`
        );
        process.exit(1);
    }
    return value;
}

const TRON_DISC_KEY = requireEnv("TRON_DISC_KEY");
const OPENCLAW_GATEWAY_TOKEN = requireEnv("OPENCLAW_GATEWAY_TOKEN");

const TRON_PORT = parseInt(process.env.TRON_PORT ?? "18789", 10);
const OPENCLAW_PORT = parseInt(process.env.OPENCLAW_PORT ?? "18790", 10);
const TRON_API_PORT = parseInt(process.env.TRON_API_PORT ?? "9999", 10);
const TRON_KILL_WORD = process.env.TRON_KILL_WORD ?? "DEREZ";

// ─── Startup ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log(`
  ╔═══════════════════════════════════════════════════════════════╗
  ║                                                               ║
  ║   ████████╗██████╗  ██████╗ ███╗   ██╗                       ║
  ║   ╚══██╔══╝██╔══██╗██╔═══██╗████╗  ██║                       ║
  ║      ██║   ██████╔╝██║   ██║██╔██╗ ██║                       ║
  ║      ██║   ██╔══██╗██║   ██║██║╚██╗██║                       ║
  ║      ██║   ██║  ██║╚██████╔╝██║ ╚████║                       ║
  ║      ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝                       ║
  ║                                                               ║
  ║   Trusted Runtime Oversight Node                              ║
  ║   Guardian Program v1.0.0                                     ║
  ║                                                               ║
  ╚═══════════════════════════════════════════════════════════════╝
  `);

    grid.info("[GRID] ─── TRON initialization sequence ───");
    grid.info("[GRID] Proxy port     : %d (intercepting OpenClaw traffic)", TRON_PORT);
    grid.info("[GRID] OpenClaw port  : %d (forwarding target)", OPENCLAW_PORT);
    grid.info("[GRID] Remote API port: %d (Identity Disc secured)", TRON_API_PORT);
    grid.info("[GRID] Kill word      : %s", TRON_KILL_WORD);
    grid.info("[GRID] Identity Disc  : configured (not logged)");
    grid.info("[GRID] Gateway Token  : configured (not logged)");

    try {
        // Launch both servers concurrently
        await Promise.all([
            startProxy({
                tronPort: TRON_PORT,
                openclawPort: OPENCLAW_PORT,
                killWord: TRON_KILL_WORD,
                gatewayToken: OPENCLAW_GATEWAY_TOKEN,
            }),
            startApi({
                apiPort: TRON_API_PORT,
                openclawPort: OPENCLAW_PORT,
                discKey: TRON_DISC_KEY,
                gatewayToken: OPENCLAW_GATEWAY_TOKEN,
            }),
        ]);

        logStartup(TRON_PORT, TRON_API_PORT);
        grid.info("[GRID] ─── TRON is online. The Grid is watching. ───");
    } catch (err) {
        grid.error({ err }, "[GRID] TRON failed to initialize");
        process.exit(1);
    }
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────

process.on("SIGINT", () => {
    grid.info("[GRID] SIGINT received — TRON shutting down");
    process.exit(0);
});

process.on("SIGTERM", () => {
    grid.info("[GRID] SIGTERM received — TRON shutting down");
    process.exit(0);
});

process.on("uncaughtException", (err) => {
    grid.error({ err }, "[GRID] Uncaught exception");
    process.exit(1);
});

process.on("unhandledRejection", (reason) => {
    grid.error({ reason }, "[GRID] Unhandled rejection");
    process.exit(1);
});

// ─── Launch ─────────────────────────────────────────────────────────────────
main();
