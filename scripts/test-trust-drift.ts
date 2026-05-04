#!/usr/bin/env node
// Drift-detection script for trust-check.ts.
//
// Verifies our willHitTrustDialog predictor matches claude's actual behavior
// by toggling trust state and observing whether the dialog appears.
//
// REQUIRES: tmux on PATH, claude on PATH, write access to ~/.claude.json,
// no other claude --rc sessions actively contending for ~/.claude.json.
//
// Run with: npm run test:drift   (or: tsx scripts/test-trust-drift.ts)

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { willHitTrustDialog } from "../src/trust-check.js";

const TRUST_PROMPT_MARKER = "code.claude.com/docs/en/security";
const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");
const TMUX_NAME = `trust-drift-${Date.now()}`;

function requireBin(cmd: string): void {
    const r = spawnSync("command", ["-v", cmd], { stdio: "ignore", shell: true });
    if (r.status !== 0) {
        console.error(`Required command not on PATH: ${cmd}`);
        process.exit(2);
    }
}

function killTmux(): void {
    spawnSync("tmux", ["kill-session", "-t", `=${TMUX_NAME}`], { stdio: "ignore" });
}

function spawnClaudeInTmux(workspace: string): void {
    const r = spawnSync("tmux", ["new-session", "-d", "-s", TMUX_NAME, "-c", workspace, "-x", "120", "-y", "40", "claude --rc"]);
    if (r.status !== 0) {
        console.error(`tmux new-session failed`);
        process.exit(2);
    }
}

function capturePane(): string {
    const r = spawnSync("tmux", ["capture-pane", "-p", "-t", `=${TMUX_NAME}`], { encoding: "utf8" });
    return r.stdout ?? "";
}

async function waitForMarkerOrTimeout(marker: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (capturePane().includes(marker)) return true;
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}

async function main(): Promise<void> {
    requireBin("tmux");
    requireBin("claude");

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trust-drift-"));
    const backup = await fs.readFile(CLAUDE_JSON, "utf8").catch(() => "");
    let drift = false;
    try {
        const predUntrusted = await willHitTrustDialog(tmpDir);
        if (!predUntrusted) {
            console.error(`DRIFT: predictor says ${tmpDir} is trusted, but it shouldn't be`);
            drift = true;
        }

        spawnClaudeInTmux(tmpDir);
        const promptAppeared = await waitForMarkerOrTimeout(TRUST_PROMPT_MARKER, 10_000);
        if (!promptAppeared) {
            console.error(`DRIFT: predictor said dialog would appear, but no trust prompt observed`);
            console.error(`Last pane:\n${capturePane().slice(-500)}`);
            drift = true;
        }
        killTmux();

        const cfg = backup ? JSON.parse(backup) : {};
        cfg.projects ??= {};
        cfg.projects[path.resolve(tmpDir).normalize("NFC")] = { hasTrustDialogAccepted: true };
        await fs.writeFile(CLAUDE_JSON, JSON.stringify(cfg, null, 2));

        const predTrusted = await willHitTrustDialog(tmpDir);
        if (predTrusted) {
            console.error(`DRIFT: predictor says ${tmpDir} is untrusted after marking`);
            drift = true;
        }

        spawnClaudeInTmux(tmpDir);
        const promptStillAppeared = await waitForMarkerOrTimeout(TRUST_PROMPT_MARKER, 5_000);
        if (promptStillAppeared) {
            console.error(`DRIFT: trust prompt still appeared after marking trusted`);
            drift = true;
        }
        killTmux();
    } finally {
        killTmux();
        if (backup) await fs.writeFile(CLAUDE_JSON, backup);
        else await fs.unlink(CLAUDE_JSON).catch(() => {});
        await fs.rm(tmpDir, { recursive: true, force: true });
    }

    if (drift) {
        console.error("DRIFT DETECTED. Update src/trust-check.ts to match claude's current behavior.");
        process.exit(1);
    }
    console.log("Trust-check matches reality.");
}

void main().catch((e) => {
    killTmux();
    console.error(e);
    process.exit(2);
});
