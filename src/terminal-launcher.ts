// ---------------------------------------------------------------------------
// macOS-only terminal launcher: opens a new terminal window in iTerm2 (when
// installed) or Terminal.app and runs the given command. Linux/Windows
// support is intentionally absent - see the GitHub issue tracking proper
// equivalents (open a default-profile window so user shell init runs and
// chpwd hooks like direnv fire on `cd`, plus return a kill-handle PID).
//
// On macOS we prefer iTerm2 over Terminal.app when available. Reason:
// `claude --rc` has a bug specific to Terminal.app (running it under
// Apple_Terminal causes the spawned RC session to fight for the host
// account's RC slot, producing repeated "Transport closed (code 4090)"
// disconnects). The same command from iTerm2 routes through an iTerm2-
// specific code path in claude that doesn't trigger the collision.
//
// Both handlers dispatch via `osascript`, not `open`. The flow replicates
// the user's GUI action exactly: open a new terminal window with the
// **default profile** (= the user's full login+interactive shell), then
// send the `cd <workspace> && claude ...` command line as if the user
// typed it. This guarantees:
//   - .zshrc / .bash_profile / .zprofile etc. all run (PATH, aliases,
//     functions, prompt customizations);
//   - direnv (and any other chpwd hooks) fires on `cd`, loading any
//     project-local `.envrc`;
//   - claude inherits the same env it would if launched manually.
//
// We deliberately do NOT use iTerm's `command` argument (which exec's
// the command instead of the shell, skipping all init) or write a
// `.command` script (which iTerm runs under launchd's stripped PATH).
// `open -b` is also unusable: it silently no-ops because LaunchServices
// only routes `.command` execution to the app that binds the Shell role
// for `com.apple.terminal.shell-script` (Terminal.app on stock macOS).
// ---------------------------------------------------------------------------

import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

/**
 * Outcome of a successful launch. `pid` is the session leader for the
 * new terminal's tty (the root of `login -fp <user>` -> shell -> claude),
 * so killing it terminates the entire spawned session. `tty` and `pid`
 * are best-effort; on rare races the tty may be present without a
 * resolvable pid.
 */
interface LaunchOutcome {
    tty?: string;
    pid?: number;
}

interface TerminalHandler {
    /** Stable id, used in OpenSessionResult.handlerId. */
    readonly id: string;
    /** True iff this handler can launch on the current host. */
    detect(): boolean;
    /** Launch `cmd` in a new terminal window in `cwd`. */
    launch(opts: { cwd: string; cmd: string[] }): Promise<LaunchOutcome>;
}

/**
 * Open a new window in the named macOS terminal app using its **default
 * profile** (= the user's normal login+interactive shell), then deliver
 * the `cd <cwd> && <cmd...>` command line as if the user typed it. The
 * AppleScript also returns the new session's tty so we can resolve the
 * shell session leader's PID for callers that want a kill handle.
 *
 *   - "iterm":    `create window with default profile`, then `write text` into the new session.
 *   - "terminal": `do script "<line>"` (Terminal opens a new window with the user's default shell and runs the line).
 *
 * Both routes ensure the user's shell init runs and chpwd hooks (direnv,
 * etc.) fire on `cd` before claude is launched.
 */
function launchMacosViaOsascript(handlerId: string, cwd: string, cmd: string[], target: "iterm" | "terminal"): LaunchOutcome {
    // Trailing `; exit` closes the spawned shell when `cmd` returns, which
    // ends the iTerm/Terminal session and (per profile) closes the window.
    // `;` (not `&&`) so we exit unconditionally - even if claude crashes,
    // we don't leave orphan windows behind for unattended/MCP-driven use.
    const commandLine = `cd ${shellQuote(cwd)} && ${cmd.map(shellQuote).join(" ")}; exit`;
    const quoted = applescriptQuote(commandLine);
    const lines =
        target === "iterm"
            ? [
                  `tell application "iTerm"`,
                  `set s to current session of (create window with default profile)`,
                  `tell s to write text ${quoted}`,
                  `return tty of s`,
                  `end tell`,
              ]
            : [`tell application "Terminal"`, `set t to do script ${quoted}`, `return tty of t`, `end tell`];
    const args: string[] = [];
    for (const l of lines) args.push("-e", l);
    const r = spawnSync("osascript", args, { encoding: "utf8" });
    if (r.status !== 0) {
        throw new TerminalLaunchError(handlerId, r.stderr?.toString() ?? "osascript exited non-zero");
    }
    const tty = r.stdout?.toString().trim();
    if (!tty) return {};
    return { tty, pid: findSessionLeaderPid(tty) };
}

/**
 * Resolve a tty (e.g. `/dev/ttys013`) to the PID of the "root" process on
 * that tty - the one whose parent is NOT also on this tty. That's the
 * ancestor (e.g. `login -fp <user>` on macOS) whose termination tears down
 * the whole spawned shell + claude tree.
 *
 * We deliberately avoid `ps -o sid=` because BSD `ps` (macOS) lacks the
 * `sid` keyword. Returns undefined if `ps` fails or the tty has no
 * processes (rare race; a brief retry could be added if it ever surfaces).
 */
function findSessionLeaderPid(tty: string): number | undefined {
    const dev = tty.replace(/^\/dev\//, "");
    const r = spawnSync("ps", ["-t", dev, "-o", "pid=,ppid="], { encoding: "utf8" });
    if (r.status !== 0) return undefined;
    const lines = r.stdout?.toString().trim().split("\n") ?? [];
    const onTty = new Set<number>();
    const entries: Array<{ pid: number; ppid: number }> = [];
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const pid = Number(parts[0]);
        const ppid = Number(parts[1]);
        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
        onTty.add(pid);
        entries.push({ pid, ppid });
    }
    const roots = entries.filter((e) => !onTty.has(e.ppid)).map((e) => e.pid);
    if (roots.length === 0) return undefined;
    return Math.min(...roots);
}

function hasITermInstalled(): boolean {
    // App can live under /Applications or ~/Applications
    return fsSync.existsSync("/Applications/iTerm.app") || fsSync.existsSync(path.join(os.homedir(), "Applications/iTerm.app"));
}

const macosITerm: TerminalHandler = {
    id: "macos-iterm",
    detect: () => process.platform === "darwin" && hasITermInstalled(),
    async launch({ cwd, cmd }) {
        return launchMacosViaOsascript(this.id, cwd, cmd, "iterm");
    },
};

const macosDefault: TerminalHandler = {
    id: "macos-default",
    detect: () => process.platform === "darwin",
    async launch({ cwd, cmd }) {
        return launchMacosViaOsascript(this.id, cwd, cmd, "terminal");
    },
};

// Order encodes preference: macos-iterm (when iTerm.app installed) wins
// over macos-default. macOS-only by design; non-macOS platforms throw
// NoGUITerminalError until proper equivalents are implemented.
const HANDLERS: TerminalHandler[] = [macosITerm, macosDefault];

/**
 * Return the first terminal handler that detect()s this host, or null.
 * Currently macOS-only; other platforms always return null.
 */
export function detectTerminalHandler(): TerminalHandler | null {
    return HANDLERS.find((h) => h.detect()) ?? null;
}

/**
 * Launch `cmd` in `cwd` using the host's default terminal handler.
 * Throws NoGUITerminalError on non-macOS hosts; TerminalLaunchError if the
 * matched handler's spawn fails.
 */
export async function launchInDefaultTerminal(opts: { cwd: string; cmd: string[] }): Promise<{ handlerId: string; tty?: string; pid?: number }> {
    const handler = detectTerminalHandler();
    if (!handler) throw new NoGUITerminalError();
    const outcome = await handler.launch(opts);
    return { handlerId: handler.id, tty: outcome.tty, pid: outcome.pid };
}

export class NoGUITerminalError extends Error {
    constructor() {
        super(
            "openSession is currently macOS-only. On other platforms, run " +
                "`claude --rc` directly in your shell. Tracking proper Linux " +
                "and Windows equivalents in the project's GitHub issues."
        );
        this.name = "NoGUITerminalError";
    }
}

export class TerminalLaunchError extends Error {
    readonly handlerId: string;
    constructor(handlerId: string, detail: string) {
        super(`Terminal launcher (${handlerId}) failed: ${detail.trim()}`);
        this.name = "TerminalLaunchError";
        this.handlerId = handlerId;
    }
}

function shellQuote(s: string): string {
    // POSIX-safe single-quote wrapping. Embedded single quotes become '\''.
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

function applescriptQuote(s: string): string {
    // AppleScript double-quoted strings: backslash escapes \ and ".
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
