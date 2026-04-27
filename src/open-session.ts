import * as fs from "node:fs";
import * as path from "node:path";
import * as pty from "node-pty";
import type { OpenSessionResult } from "./types.js";

export type { OpenSessionResult };

const SESSION_URL_RE = /https:\/\/claude\.ai\/code\/session_\w+/;
const STARTUP_TIMEOUT_MS = 15_000;

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

    return spawnSession(workspace, sessionName);
}

function buildShellCommand(sessionName?: string): { cmd: string; env: NodeJS.ProcessEnv } {
    if (sessionName) {
        return {
            cmd: "trap '' HUP; exec claude --rc \"$SESSION_NAME\"",
            env: { ...process.env, SESSION_NAME: sessionName },
        };
    }
    return {
        cmd: "trap '' HUP; exec claude --rc",
        env: process.env,
    };
}

function spawnSession(workspace: string, sessionName?: string): Promise<OpenSessionResult> {
    return new Promise((resolve, reject) => {
        const { cmd, env } = buildShellCommand(sessionName);

        const ptyProcess = pty.spawn("sh", ["-c", cmd], {
            name: "xterm-256color",
            cols: 120,
            rows: 40,
            cwd: workspace,
            env: env as NodeJS.ProcessEnv,
        });

        let accumulated = "";
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ptyProcess.kill("SIGKILL");
            const preview = accumulated.slice(-500);
            reject(new Error(`Remote control did not become active within ${STARTUP_TIMEOUT_MS}ms. Last output:\n${preview}`));
        }, STARTUP_TIMEOUT_MS);

        ptyProcess.onData((chunk) => {
            accumulated += chunk;
            if (settled) return;

            const match = SESSION_URL_RE.exec(accumulated);
            if (match) {
                settled = true;
                clearTimeout(timer);
                ptyProcess.kill("SIGHUP");
                resolve({
                    ...(sessionName !== undefined && { sessionName }),
                    sessionUrl: match[0],
                    workspace,
                });
            }
        });

        ptyProcess.onExit(({ exitCode }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`Claude process exited with code ${exitCode ?? "unknown"} before remote control became active`));
        });
    });
}
