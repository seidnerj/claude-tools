// ---------------------------------------------------------------------------
// Per-OS terminal launcher: opens a new terminal window in the user's default
// terminal app and runs the given command. Registry pattern - first matching
// handler wins. Adding Windows or other platforms = one new entry.
//
// On macOS we prefer iTerm2 over Terminal.app when available. Reason:
// `claude --rc` has a bug specific to Terminal.app (running it under
// Apple_Terminal causes the spawned RC session to fight for the host
// account's RC slot, producing repeated "Transport closed (code 4090)"
// disconnects). The same command from iTerm2 routes through an iTerm2-
// specific code path in claude that doesn't trigger the collision. See
// session 2026-05-05 for the env-diff investigation that pinpointed this.
// ---------------------------------------------------------------------------

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

interface TerminalHandler {
    /** Stable id, used in OpenSessionResult.handlerId. */
    readonly id: string;
    /** True iff this handler can launch on the current host. */
    detect(): boolean;
    /** Launch `cmd` in a new terminal window in `cwd`. */
    launch(opts: { cwd: string; cmd: string[] }): Promise<void>;
}

/**
 * Write a `.command` shell script for the macOS launcher, then dispatch via
 * `open`. The optional `appBundleId` argument adds `-b <id>` so a specific
 * app handles the launch even when the user's default `.command` handler is
 * different.
 */
async function writeMacosCommandLauncher(handlerId: string, cwd: string, cmd: string[], appBundleId?: string): Promise<void> {
    const launcher = path.join(os.tmpdir(), `claude-tools-launcher-${randomUUID()}.command`);
    const script = `#!/bin/bash\n` + `cd ${shellQuote(cwd)} || exit 1\n` + `${cmd.map(shellQuote).join(" ")}\n`;
    await fs.writeFile(launcher, script, { mode: 0o755 });
    const args = appBundleId ? ["-b", appBundleId, launcher] : [launcher];
    const r = spawnSync("open", args);
    if (r.status !== 0) {
        throw new TerminalLaunchError(handlerId, r.stderr?.toString() ?? "open exited non-zero");
    }
    // Best-effort cleanup of the temp launcher
    setTimeout(() => {
        void fs.unlink(launcher).catch(() => {});
    }, 30_000).unref();
}

const ITERM_BUNDLE_ID = "com.googlecode.iterm2";

function hasITermInstalled(): boolean {
    // App can live under /Applications or ~/Applications
    return fsSync.existsSync("/Applications/iTerm.app") || fsSync.existsSync(path.join(os.homedir(), "Applications/iTerm.app"));
}

const macosITerm: TerminalHandler = {
    id: "macos-iterm",
    detect: () => process.platform === "darwin" && hasITermInstalled(),
    async launch({ cwd, cmd }) {
        await writeMacosCommandLauncher(this.id, cwd, cmd, ITERM_BUNDLE_ID);
    },
};

const macosDefault: TerminalHandler = {
    id: "macos-default",
    detect: () => process.platform === "darwin",
    async launch({ cwd, cmd }) {
        await writeMacosCommandLauncher(this.id, cwd, cmd);
    },
};

const linuxXdg: TerminalHandler = {
    id: "linux-xdg",
    detect: () => process.platform === "linux" && hasOnPath("xdg-terminal-exec"),
    async launch({ cwd, cmd }) {
        const inner = `cd ${shellQuote(cwd)} && ${cmd.map(shellQuote).join(" ")}`;
        const r = spawnSync("xdg-terminal-exec", ["bash", "-c", inner]);
        if (r.status !== 0) {
            throw new TerminalLaunchError(this.id, r.stderr?.toString() ?? "xdg-terminal-exec failed");
        }
    },
};

const linuxAlternatives: TerminalHandler = {
    id: "linux-alt",
    detect: () => process.platform === "linux" && hasOnPath("x-terminal-emulator"),
    async launch({ cwd, cmd }) {
        const inner = `cd ${shellQuote(cwd)} && ${cmd.map(shellQuote).join(" ")}`;
        const r = spawnSync("x-terminal-emulator", ["-e", "bash", "-c", inner]);
        if (r.status !== 0) {
            throw new TerminalLaunchError(this.id, r.stderr?.toString() ?? "x-terminal-emulator failed");
        }
    },
};

// Order encodes preference: macos-iterm (when iTerm.app installed) wins
// over macos-default; linux-xdg wins over linux-alt.
const HANDLERS: TerminalHandler[] = [macosITerm, macosDefault, linuxXdg, linuxAlternatives];

/**
 * Return the first terminal handler that detect()s this host, or null.
 * Order in HANDLERS encodes preference (xdg-terminal-exec before x-terminal-emulator).
 */
export function detectTerminalHandler(): TerminalHandler | null {
    return HANDLERS.find((h) => h.detect()) ?? null;
}

/**
 * Launch `cmd` in `cwd` using the host's default terminal handler.
 * Throws NoGUITerminalError if no handler matches; TerminalLaunchError if the
 * matched handler's spawn fails.
 */
export async function launchInDefaultTerminal(opts: { cwd: string; cmd: string[] }): Promise<{ handlerId: string }> {
    const handler = detectTerminalHandler();
    if (!handler) throw new NoGUITerminalError();
    await handler.launch(opts);
    return { handlerId: handler.id };
}

export class NoGUITerminalError extends Error {
    constructor() {
        super(
            "openSession requires a GUI terminal. None could be located on this host " +
                "(macOS `open`, Linux `xdg-terminal-exec`/`x-terminal-emulator`). " +
                "To run a remote-controlled session in this environment, run `claude --rc` directly in your shell."
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

function hasOnPath(bin: string): boolean {
    return spawnSync("command", ["-v", bin], { stdio: "ignore", shell: true }).status === 0;
}
