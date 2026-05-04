import * as fs from "node:fs";
import * as path from "node:path";
import type { OpenSessionResult } from "./types.js";
import { willHitTrustDialog, WorkspaceNotTrustedError } from "./trust-check.js";
import { launchInDefaultTerminal } from "./terminal-launcher.js";
import { watchForSessionUrl } from "./session-watcher.js";

export type { OpenSessionResult };
export { WorkspaceNotTrustedError } from "./trust-check.js";
export { NoGUITerminalError, TerminalLaunchError } from "./terminal-launcher.js";
export { SessionWatchTimeoutError } from "./session-watcher.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OpenSessionOptions {
    workspace: string;
    /** Display name for a NEW session. Mutually exclusive with `resume` and `continueLast`. */
    sessionName?: string;
    /**
     * Resume an existing session. Accepts a session UUID OR a session name (set via /rename
     * inside Claude Code). Passed through to `claude --resume <value>` verbatim - claude
     * itself resolves names to IDs. Mutually exclusive with `sessionName` and `continueLast`.
     */
    resume?: string;
    /**
     * Continue the most recent conversation in the workspace (`claude --continue`).
     * Mutually exclusive with `sessionName` and `resume`.
     */
    continueLast?: boolean;
    /**
     * Escape hatch for arbitrary additional claude CLI flags. Appended after the
     * resume/continue/sessionName flags. Caller owns any security implications.
     */
    extraArgs?: string[];
    /** URL-discovery timeout. Default 60_000 (60s). */
    startupTimeoutMs?: number;
}

/**
 * Build the args passed to `claude` (everything after the binary name).
 * Pure function - exported for testing.
 */
export function buildClaudeArgs(opts: OpenSessionOptions): string[] {
    const args = ["--rc"];
    if (opts.continueLast) args.push("--continue");
    else if (opts.resume) args.push("--resume", opts.resume);
    else if (opts.sessionName) args.push(opts.sessionName);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);
    return args;
}

function looksLikeUuid(s: string | undefined): s is string {
    return typeof s === "string" && UUID_RE.test(s);
}

function validateInputs(opts: OpenSessionOptions): void {
    const { workspace } = opts;
    if (!path.isAbsolute(workspace)) {
        throw new Error("workspace must be an absolute path");
    }
    if (!fs.existsSync(workspace)) {
        throw new Error("workspace does not exist");
    }
    if (!fs.statSync(workspace).isDirectory()) {
        throw new Error("workspace is not a directory");
    }
    const exclusiveCount = [opts.sessionName, opts.resume, opts.continueLast].filter(Boolean).length;
    if (exclusiveCount > 1) {
        throw new Error("openSession: sessionName, resume, and continueLast are mutually exclusive");
    }
}

export async function openSession(opts: OpenSessionOptions): Promise<OpenSessionResult> {
    validateInputs(opts);

    if (await willHitTrustDialog(opts.workspace)) {
        throw new WorkspaceNotTrustedError(opts.workspace);
    }

    const cmd = ["claude", ...buildClaudeArgs(opts)];
    const { handlerId } = await launchInDefaultTerminal({ cwd: opts.workspace, cmd });

    const expectedSessionId = looksLikeUuid(opts.resume) ? opts.resume : undefined;
    const { sessionUrl, sessionId } = await watchForSessionUrl({
        workspace: opts.workspace,
        timeoutMs: opts.startupTimeoutMs,
        expectedSessionId,
    });

    return {
        ...(opts.sessionName !== undefined && { sessionName: opts.sessionName }),
        ...(opts.resume !== undefined && { resumedSessionId: opts.resume }),
        sessionUrl,
        workspace: opts.workspace,
        handlerId,
        sessionId,
    };
}
