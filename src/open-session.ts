import * as fs from "node:fs";
import * as path from "node:path";
import type { OpenSessionResult } from "./types.js";
import { willHitTrustDialog, WorkspaceNotTrustedError } from "./trust-check.js";
import { launchInDefaultTerminal } from "./terminal-launcher.js";

export type { OpenSessionResult };
export { WorkspaceNotTrustedError } from "./trust-check.js";
export { NoGUITerminalError, TerminalLaunchError } from "./terminal-launcher.js";

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

/**
 * Launch claude --rc in the user's default OS terminal app.
 *
 * Behaves like a user typing `claude --rc` in a fresh shell: validates the
 * workspace is trusted (via `~/.claude.json`), opens a new terminal window
 * (macOS .command + open; Linux xdg-terminal-exec / x-terminal-emulator),
 * and returns once the launcher has been dispatched. The session URL is
 * not returned - claude displays it in the new terminal's TUI and the
 * remote-control session shows up in the iOS app and at claude.ai/code.
 *
 * Throws WorkspaceNotTrustedError if the workspace is not trusted (run
 * `claude` once in that directory to accept the trust dialog), or
 * NoGUITerminalError on hosts without a GUI terminal launcher (use
 * `claude --rc` directly in a shell instead).
 */
export async function openSession(opts: OpenSessionOptions): Promise<OpenSessionResult> {
    validateInputs(opts);

    if (await willHitTrustDialog(opts.workspace)) {
        throw new WorkspaceNotTrustedError(opts.workspace);
    }

    const cmd = ["claude", ...buildClaudeArgs(opts)];
    const { handlerId } = await launchInDefaultTerminal({ cwd: opts.workspace, cmd });

    return {
        ...(opts.sessionName !== undefined && { sessionName: opts.sessionName }),
        ...(opts.resume !== undefined && { resumedSessionId: opts.resume }),
        workspace: opts.workspace,
        handlerId,
    };
}
