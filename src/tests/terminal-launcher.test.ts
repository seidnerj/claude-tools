import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
    existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("node:child_process", () => ({
    spawnSync: vi.fn().mockReturnValue({ status: 0 }),
}));

import * as fsSync from "node:fs";
import * as childProcess from "node:child_process";
import { detectTerminalHandler, launchInDefaultTerminal, NoGUITerminalError, TerminalLaunchError } from "../terminal-launcher.js";

const spawnSyncMock = vi.mocked(childProcess.spawnSync);
const existsSyncMock = vi.mocked(fsSync.existsSync);

describe("detectTerminalHandler", () => {
    let originalPlatform: NodeJS.Platform;

    beforeEach(() => {
        originalPlatform = process.platform;
        spawnSyncMock.mockReturnValue({ status: 0 } as ReturnType<typeof childProcess.spawnSync>);
        existsSyncMock.mockReturnValue(false);
    });

    afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
        vi.clearAllMocks();
    });

    function setPlatform(p: NodeJS.Platform) {
        Object.defineProperty(process, "platform", { value: p });
    }

    it("selects macos-iterm on darwin when iTerm.app is installed", () => {
        setPlatform("darwin");
        existsSyncMock.mockImplementation((p: fsSync.PathLike) => String(p).endsWith("/iTerm.app"));
        expect(detectTerminalHandler()?.id).toBe("macos-iterm");
    });

    it("falls back to macos-default on darwin when iTerm.app is not installed", () => {
        setPlatform("darwin");
        existsSyncMock.mockReturnValue(false);
        expect(detectTerminalHandler()?.id).toBe("macos-default");
    });

    it("returns null on linux (not supported)", () => {
        setPlatform("linux");
        expect(detectTerminalHandler()).toBeNull();
    });

    it("returns null on win32 (not supported)", () => {
        setPlatform("win32");
        expect(detectTerminalHandler()).toBeNull();
    });
});

describe("launchInDefaultTerminal - macOS", () => {
    let originalPlatform: NodeJS.Platform;

    beforeEach(() => {
        originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "darwin" });
        spawnSyncMock.mockReturnValue({ status: 0 } as ReturnType<typeof childProcess.spawnSync>);
        existsSyncMock.mockReturnValue(false);
    });

    afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
        vi.clearAllMocks();
    });

    it("dispatches via osascript to Terminal.app `do script` with cd && cmd line when iTerm is absent", async () => {
        // ps output: login(500, ppid 100) -> -zsh(502, ppid 500) -> claude(503, ppid 502)
        // The "root" on this tty is 500 (its ppid 100 is not on the tty).
        spawnSyncMock.mockImplementation(((cmd: string, args?: readonly string[]) => {
            if (cmd === "osascript") return { status: 0, stdout: "/dev/ttys013\n", stderr: "" } as ReturnType<typeof childProcess.spawnSync>;
            if (cmd === "ps")
                return { status: 0, stdout: "  500   100\n  502   500\n  503   502\n", stderr: "" } as ReturnType<typeof childProcess.spawnSync>;
            return { status: 0 } as ReturnType<typeof childProcess.spawnSync>;
        }) as typeof childProcess.spawnSync);

        const result = await launchInDefaultTerminal({
            cwd: "/path/to/workspace",
            cmd: ["claude", "--rc"],
        });

        expect(result.handlerId).toBe("macos-default");
        expect(result.tty).toBe("/dev/ttys013");
        expect(result.pid).toBe(500);

        const osaCall = spawnSyncMock.mock.calls.find((c) => c[0] === "osascript");
        expect(osaCall).toBeDefined();
        const osaArgs = osaCall![1] as string[];
        // multiple -e clauses, joined by alternating positions
        expect(osaArgs.filter((a) => a === "-e").length).toBeGreaterThanOrEqual(3);
        expect(osaArgs.join("\n")).toContain(`tell application "Terminal"`);
        expect(osaArgs.join("\n")).toContain(`do script "cd '/path/to/workspace' && 'claude' '--rc'"`);
        expect(osaArgs.join("\n")).toContain(`return tty of t`);
        expect(spawnSyncMock.mock.calls.find((c) => c[0] === "open")).toBeUndefined();

        const psCall = spawnSyncMock.mock.calls.find((c) => c[0] === "ps");
        expect(psCall![1]).toEqual(["-t", "ttys013", "-o", "pid=,ppid="]);
    });

    it("dispatches via osascript to iTerm `write text` into a default-profile window when iTerm is installed", async () => {
        existsSyncMock.mockImplementation((p: fsSync.PathLike) => String(p).endsWith("/iTerm.app"));
        spawnSyncMock.mockImplementation(((cmd: string) => {
            if (cmd === "osascript") return { status: 0, stdout: "/dev/ttys042\n", stderr: "" } as ReturnType<typeof childProcess.spawnSync>;
            if (cmd === "ps")
                return { status: 0, stdout: " 1234   99\n 1235 1234\n 1236 1235\n", stderr: "" } as ReturnType<typeof childProcess.spawnSync>;
            return { status: 0 } as ReturnType<typeof childProcess.spawnSync>;
        }) as typeof childProcess.spawnSync);

        const result = await launchInDefaultTerminal({
            cwd: "/path/to/workspace",
            cmd: ["claude", "--rc"],
        });

        expect(result.handlerId).toBe("macos-iterm");
        expect(result.tty).toBe("/dev/ttys042");
        expect(result.pid).toBe(1234);

        const osaCall = spawnSyncMock.mock.calls.find((c) => c[0] === "osascript");
        expect(osaCall).toBeDefined();
        const osaArgs = osaCall![1] as string[];
        expect(osaArgs.join("\n")).toContain(`tell application "iTerm"`);
        expect(osaArgs.join("\n")).toContain(`current session of (create window with default profile)`);
        expect(osaArgs.join("\n")).toContain(`write text "cd '/path/to/workspace' && 'claude' '--rc'"`);
        expect(osaArgs.join("\n")).toContain(`return tty of s`);
        expect(spawnSyncMock.mock.calls.find((c) => c[0] === "open")).toBeUndefined();
    });

    it("returns tty/pid as undefined when ps fails to find a session leader", async () => {
        spawnSyncMock.mockImplementation(((cmd: string) => {
            if (cmd === "osascript") return { status: 0, stdout: "/dev/ttys099\n", stderr: "" } as ReturnType<typeof childProcess.spawnSync>;
            if (cmd === "ps") return { status: 1, stdout: "", stderr: "ps: no such tty" } as ReturnType<typeof childProcess.spawnSync>;
            return { status: 0 } as ReturnType<typeof childProcess.spawnSync>;
        }) as typeof childProcess.spawnSync);

        const result = await launchInDefaultTerminal({ cwd: "/x", cmd: ["claude"] });
        expect(result.tty).toBe("/dev/ttys099");
        expect(result.pid).toBeUndefined();
    });

    it("throws TerminalLaunchError when osascript exits non-zero (iTerm absent)", async () => {
        existsSyncMock.mockReturnValue(false);
        spawnSyncMock.mockImplementation(((cmd: string) => {
            if (cmd === "osascript") return { status: 1, stderr: Buffer.from("execution error") } as ReturnType<typeof childProcess.spawnSync>;
            return { status: 0 } as ReturnType<typeof childProcess.spawnSync>;
        }) as typeof childProcess.spawnSync);

        await expect(launchInDefaultTerminal({ cwd: "/x", cmd: ["claude", "--rc"] })).rejects.toMatchObject({
            name: "TerminalLaunchError",
            handlerId: "macos-default",
        });
    });

    it("throws TerminalLaunchError with macos-iterm handlerId when iTerm osascript fails", async () => {
        existsSyncMock.mockImplementation((p: fsSync.PathLike) => String(p).endsWith("/iTerm.app"));
        spawnSyncMock.mockImplementation(((cmd: string) => {
            if (cmd === "osascript") return { status: 1, stderr: Buffer.from("not allowed") } as ReturnType<typeof childProcess.spawnSync>;
            return { status: 0 } as ReturnType<typeof childProcess.spawnSync>;
        }) as typeof childProcess.spawnSync);

        await expect(launchInDefaultTerminal({ cwd: "/x", cmd: ["claude", "--rc"] })).rejects.toMatchObject({
            name: "TerminalLaunchError",
            handlerId: "macos-iterm",
        });
    });
});

describe("launchInDefaultTerminal - non-macOS", () => {
    let originalPlatform: NodeJS.Platform;

    beforeEach(() => {
        originalPlatform = process.platform;
    });

    afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
        vi.clearAllMocks();
    });

    it("throws NoGUITerminalError on linux", async () => {
        Object.defineProperty(process, "platform", { value: "linux" });
        await expect(launchInDefaultTerminal({ cwd: "/x", cmd: ["claude"] })).rejects.toMatchObject({
            name: "NoGUITerminalError",
        });
    });

    it("throws NoGUITerminalError on win32", async () => {
        Object.defineProperty(process, "platform", { value: "win32" });
        await expect(launchInDefaultTerminal({ cwd: "/x", cmd: ["claude"] })).rejects.toMatchObject({
            name: "NoGUITerminalError",
        });
    });
});

describe("error classes", () => {
    it("NoGUITerminalError has stable name", () => {
        const e = new NoGUITerminalError();
        expect(e.name).toBe("NoGUITerminalError");
        expect(e.message).toContain("macOS-only");
    });

    it("TerminalLaunchError exposes handlerId and detail", () => {
        const e = new TerminalLaunchError("macos-default", "boom");
        expect(e.name).toBe("TerminalLaunchError");
        expect(e.handlerId).toBe("macos-default");
        expect(e.message).toContain("macos-default");
        expect(e.message).toContain("boom");
    });
});
