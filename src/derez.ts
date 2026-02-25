import { execSync } from "child_process";
import { grid, logDerezStep } from "./logger.js";

// ─── DEREZ ──────────────────────────────────────────────────────────────────
// The 3-step kill chain. When a corrupted program is detected, TRON executes
// deresolution — the Grid equivalent of termination.

interface DerezResult {
    success: boolean;
    stepsExecuted: number;
    message: string;
}

/**
 * Timestamp helper for console output.
 */
function timestamp(): string {
    return new Date().toISOString();
}

/**
 * Print a highly visible banner to the console.
 */
function banner(lines: string[]): void {
    const width = 66;
    const border = "═".repeat(width);
    console.log("");
    console.log(`  ╔${border}╗`);
    for (const line of lines) {
        const padded = line.padEnd(width);
        console.log(`  ║${padded}║`);
    }
    console.log(`  ╚${border}╝`);
    console.log("");
}

/**
 * Execute the full 3-step DEREZ sequence against OpenClaw on the target port.
 */
export async function executeDerez(
    openclawPort: number,
    gatewayToken: string
): Promise<DerezResult> {
    const startTime = timestamp();

    banner([
        "",
        "  ⚡ DEREZ SEQUENCE INITIATED ⚡",
        "",
        `  Target:    port ${openclawPort}`,
        `  Timestamp: ${startTime}`,
        "",
    ]);

    grid.warn("[GRID] ═══════════════════════════════════════════════════");
    grid.warn("[GRID]   DEREZ SEQUENCE INITIATED — Target: port %d", openclawPort);
    grid.warn("[GRID] ═══════════════════════════════════════════════════");

    // Step 1: Graceful — POST to OpenClaw's stop endpoint
    console.log(`  [${timestamp()}] STEP 1/3 — GRACEFUL: POST /api/channels/stop ...`);
    const step1 = await step1Graceful(openclawPort, gatewayToken);
    if (step1) {
        const result: DerezResult = {
            success: true,
            stepsExecuted: 1,
            message: "Corrupted program derezzed gracefully.",
        };
        console.log(`  [${timestamp()}] ✓ STEP 1 SUCCEEDED — OpenClaw stopped gracefully.`);
        await postDerezReport(openclawPort, result);
        return result;
    }
    console.log(`  [${timestamp()}] ✗ STEP 1 FAILED — OpenClaw did not stop. Escalating...`);

    // Step 2: Force — find process and kill it
    console.log(`  [${timestamp()}] STEP 2/3 — FORCE: find-process + fkill ...`);
    const step2 = await step2Force(openclawPort);
    if (step2) {
        const result: DerezResult = {
            success: true,
            stepsExecuted: 2,
            message: "Corrupted program forcibly derezzed.",
        };
        console.log(`  [${timestamp()}] ✓ STEP 2 SUCCEEDED — Process force-killed.`);
        await postDerezReport(openclawPort, result);
        return result;
    }
    console.log(`  [${timestamp()}] ✗ STEP 2 FAILED — Process survived fkill. Escalating...`);

    // Step 3: Nuclear — platform-specific port kill
    console.log(`  [${timestamp()}] STEP 3/3 — NUCLEAR: OS-level port kill (${process.platform}) ...`);
    const step3 = await step3Nuclear(openclawPort);
    if (step3) {
        const result: DerezResult = {
            success: true,
            stepsExecuted: 3,
            message: "Corrupted program derezzed via nuclear fallback.",
        };
        console.log(`  [${timestamp()}] ✓ STEP 3 SUCCEEDED — Nuclear kill confirmed.`);
        await postDerezReport(openclawPort, result);
        return result;
    }

    console.log(`  [${timestamp()}] ✗ STEP 3 FAILED — All kill methods exhausted.`);
    grid.error("[GRID] All DEREZ steps failed. Corrupted program persists.");

    const failResult: DerezResult = {
        success: false,
        stepsExecuted: 3,
        message: "DEREZ sequence failed — corrupted program could not be terminated.",
    };

    banner([
        "",
        "  ✗ DEREZ FAILED",
        "",
        `  All 3 steps exhausted. Corrupted program persists on port ${openclawPort}.`,
        `  Timestamp: ${timestamp()}`,
        "",
    ]);

    return failResult;
}

/**
 * Post-derez report: waits 5 seconds to check if OpenClaw respawned (auto-restart detection).
 */
async function postDerezReport(port: number, result: DerezResult): Promise<void> {
    banner([
        "",
        "  ✓ DEREZ SUCCESSFUL",
        "",
        `  Steps executed: ${result.stepsExecuted}/3`,
        `  Method:         ${result.message}`,
        `  Timestamp:      ${timestamp()}`,
        "",
        "  Checking for auto-restart in 5 seconds...",
        "",
    ]);

    await sleep(5000);
    const respawned = await isPortInUse(port);

    if (respawned) {
        banner([
            "",
            "  ⚠ AUTO-RESTART DETECTED ⚠",
            "",
            `  OpenClaw is BACK on port ${port} after being derezzed.`,
            "  Something (a service manager, Docker, etc.) is respawning it.",
            "  You may need to disable the auto-restart mechanism first.",
            `  Timestamp: ${timestamp()}`,
            "",
        ]);
        grid.warn("[GRID] ⚠ AUTO-RESTART DETECTED — OpenClaw respawned on port %d within 5s of derez", port);
    } else {
        console.log(`  [${timestamp()}] ✓ Port ${port} is clear. OpenClaw did NOT respawn. The Grid is safe.`);
        console.log("");
        grid.info("[GRID] Post-derez check: OpenClaw did not respawn. The Grid is safe.");
    }
}

/**
 * Kill a specific process by name.
 */
export async function derezByName(target: string): Promise<DerezResult> {
    grid.warn("[GRID] DEREZ by name — Target: %s", target);
    try {
        const fkill = await importFkill();
        await fkill(target, { force: true });
        logDerezStep(1, `kill process "${target}"`, true);
        return {
            success: true,
            stepsExecuted: 1,
            message: `Process "${target}" derezzed.`,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logDerezStep(1, `kill process "${target}"`, false, msg);
        return {
            success: false,
            stepsExecuted: 1,
            message: `Failed to derez "${target}": ${msg}`,
        };
    }
}

// ─── Step 1: Graceful ───────────────────────────────────────────────────────

async function step1Graceful(
    port: number,
    token: string
): Promise<boolean> {
    try {
        grid.info("[GRID] DEREZ step 1: graceful POST /api/channels/stop");
        const response = await fetch(
            `http://localhost:${port}/api/channels/stop`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
            }
        );

        // Wait 2 seconds and check if process is still running
        await sleep(2000);
        const stillRunning = await isPortInUse(port);

        if (!stillRunning) {
            logDerezStep(1, "graceful stop", true);
            return true;
        }

        logDerezStep(
            1,
            "graceful stop",
            false,
            `API returned ${response.status} but process still running`
        );
        return false;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logDerezStep(1, "graceful stop", false, msg);
        return false;
    }
}

// ─── Step 2: Force (find-process + fkill) ───────────────────────────────────

async function step2Force(port: number): Promise<boolean> {
    try {
        grid.info("[GRID] DEREZ step 2: force kill process on port %d", port);
        const findProcess = (await import("find-process")).default;
        const processes = await findProcess("port", port);

        if (processes.length === 0) {
            logDerezStep(2, "force kill", true);
            return true; // Already gone
        }

        const fkill = await importFkill();
        for (const proc of processes) {
            grid.info("[GRID] Force-killing PID %d (%s)", proc.pid, proc.name);
            await fkill(proc.pid, { force: true });
        }

        await sleep(1000);
        const stillRunning = await isPortInUse(port);

        if (!stillRunning) {
            logDerezStep(2, "force kill", true);
            return true;
        }

        logDerezStep(2, "force kill", false, "process still running after fkill");
        return false;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logDerezStep(2, "force kill", false, msg);
        return false;
    }
}

// ─── Step 3: Nuclear (platform-specific) ────────────────────────────────────

async function step3Nuclear(port: number): Promise<boolean> {
    try {
        const platform = process.platform;
        grid.info("[GRID] DEREZ step 3: nuclear fallback (%s)", platform);

        if (platform === "win32") {
            // Windows: find PID via netstat, then taskkill
            try {
                const netstatOutput = execSync(
                    `netstat -ano | findstr :${port} | findstr LISTENING`,
                    { encoding: "utf-8", timeout: 5000 }
                );
                const lines = netstatOutput.trim().split("\n");
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    const pid = parts[parts.length - 1];
                    if (pid && /^\d+$/.test(pid)) {
                        grid.info("[GRID] Nuclear: taskkill /F /PID %s", pid);
                        execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
                    }
                }
            } catch {
                // Also try Stop-Process via PowerShell
                execSync(
                    `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
                    { timeout: 10000 }
                );
            }
        } else {
            // Linux/macOS: fuser -k
            execSync(`fuser -k ${port}/tcp`, { timeout: 5000 });
        }

        await sleep(1000);
        const stillRunning = await isPortInUse(port);

        if (!stillRunning) {
            logDerezStep(3, "nuclear fallback", true);
            return true;
        }

        logDerezStep(3, "nuclear fallback", false, "process still running after nuclear");
        return false;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logDerezStep(3, "nuclear fallback", false, msg);
        return false;
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function importFkill(): Promise<(input: string | number | readonly (string | number)[], options?: { force?: boolean; tree?: boolean }) => Promise<void>> {
    const mod = await import("fkill");
    return mod.default;
}

async function isPortInUse(port: number): Promise<boolean> {
    try {
        const findProcess = (await import("find-process")).default;
        const processes = await findProcess("port", port);
        return processes.length > 0;
    } catch {
        return false;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
