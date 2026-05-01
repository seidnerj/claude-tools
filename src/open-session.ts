import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { OpenSessionResult } from "./types.js";

export type { OpenSessionResult };

const SESSION_URL_RE = /https:\/\/claude\.ai\/code\/session_\w+/;
const TRUST_PROMPT_MARKER = "code.claude.com/docs/en/security";
const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

export interface OpenSessionOptions {
    workspace: string;
    sessionName?: string;
}

export async function openSession(opts: OpenSessionOptions): Promise<OpenSessionResult> {
    const { workspace, sessionName } = opts;

    if (!path.isAbsolute(workspace)) {
        throw new Error("workspace must be an absolute path");
    }
    if (!fs.existsSync(workspace)) {
        throw new Error("workspace does not exist");
    }
    if (!fs.statSync(workspace).isDirectory()) {
        throw new Error("workspace is not a directory");
    }

    if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) {
        throw new Error("tmux is required to open a Claude Code session but was not found on PATH. Install it (e.g. `brew install tmux`).");
    }

    const tmuxSession = resolveTmuxName(sessionName);
    return spawnSession(workspace, tmuxSession, sessionName);
}

function buildTmuxName(sessionName?: string): string {
    if (!sessionName) {
        return `claude-rc-${Date.now()}`;
    }
    const sanitized = sessionName.replace(/[^A-Za-z0-9_-]/g, "_");
    return `claude-rc-${sanitized}`;
}

function tmuxSessionExists(name: string): boolean {
    return spawnSync("tmux", ["has-session", "-t", `=${name}`], { stdio: "ignore" }).status === 0;
}

function resolveTmuxName(sessionName?: string): string {
    const candidate = buildTmuxName(sessionName);
    if (!tmuxSessionExists(candidate)) {
        return candidate;
    }
    throw new Error(`tmux session '${candidate}' already exists. Kill it (\`tmux kill-session -t '${candidate}'\`) or pass a different sessionName.`);
}

function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

function capturePane(tmuxSession: string): string {
    const r = spawnSync("tmux", ["capture-pane", "-p", "-t", `=${tmuxSession}`], { encoding: "utf8" });
    return r.stdout ?? "";
}

function spawnSession(workspace: string, tmuxSession: string, sessionName?: string): Promise<OpenSessionResult> {
    return new Promise((resolve, reject) => {
        const cmd = sessionName ? `claude --rc ${shellQuote(sessionName)}` : "claude --rc";

        const create = spawnSync("tmux", ["new-session", "-d", "-s", tmuxSession, "-c", workspace, "-x", "120", "-y", "40", cmd], {
            encoding: "utf8",
        });

        if (create.status !== 0) {
            const err = (create.stderr || "").trim() || "unknown error";
            reject(new Error(`tmux new-session failed: ${err}`));
            return;
        }

        let settled = false;
        let trustAccepted = false;

        const killSession = () => {
            spawnSync("tmux", ["kill-session", "-t", `=${tmuxSession}`], { stdio: "ignore" });
        };

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            clearInterval(interval);
            const tail = capturePane(tmuxSession).slice(-500);
            killSession();
            reject(new Error(`Remote control did not become active within ${STARTUP_TIMEOUT_MS}ms. Last output:\n${tail}`));
        }, STARTUP_TIMEOUT_MS);

        const interval = setInterval(() => {
            if (settled) return;

            if (!tmuxSessionExists(tmuxSession)) {
                settled = true;
                clearInterval(interval);
                clearTimeout(timer);
                reject(new Error("Claude process exited before remote control became active"));
                return;
            }

            const output = capturePane(tmuxSession);

            if (!trustAccepted && output.includes(TRUST_PROMPT_MARKER)) {
                trustAccepted = true;
                spawnSync("tmux", ["send-keys", "-t", `=${tmuxSession}`, "Enter"], { stdio: "ignore" });
            }

            const match = SESSION_URL_RE.exec(output);
            if (match) {
                settled = true;
                clearInterval(interval);
                clearTimeout(timer);
                resolve({
                    ...(sessionName !== undefined && { sessionName }),
                    sessionUrl: match[0],
                    workspace,
                    tmuxSession,
                });
            }
        }, POLL_INTERVAL_MS);
    });
}
