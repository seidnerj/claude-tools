import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";

vi.mock("node:fs/promises", () => ({
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:child_process", () => ({
    spawnSync: vi.fn().mockReturnValue({ status: 0 }),
}));

import * as fsPromises from "node:fs/promises";
import * as childProcess from "node:child_process";
import {
    detectTerminalHandler,
    launchInDefaultTerminal,
    NoGUITerminalError,
    TerminalLaunchError,
} from "../terminal-launcher.js";

const spawnSyncMock = vi.mocked(childProcess.spawnSync);
const writeFileMock = vi.mocked(fsPromises.writeFile);

describe("detectTerminalHandler", () => {
    let originalPlatform: NodeJS.Platform;

    beforeEach(() => {
        originalPlatform = process.platform;
        spawnSyncMock.mockReturnValue({ status: 0 } as ReturnType<typeof childProcess.spawnSync>);
    });

    afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
        vi.clearAllMocks();
    });

    function setPlatform(p: NodeJS.Platform) {
        Object.defineProperty(process, "platform", { value: p });
    }

    it("selects macos-default on darwin", () => {
        setPlatform("darwin");
        expect(detectTerminalHandler()?.id).toBe("macos-default");
    });

    it("selects linux-xdg on linux when xdg-terminal-exec is on PATH", () => {
        setPlatform("linux");
        spawnSyncMock.mockImplementation(((_cmd: string, args?: readonly string[]) => {
            const arg = args?.[1] ?? "";
            return { status: arg === "xdg-terminal-exec" ? 0 : 1 } as ReturnType<typeof childProcess.spawnSync>;
        }) as typeof childProcess.spawnSync);
        expect(detectTerminalHandler()?.id).toBe("linux-xdg");
    });

    it("falls back to linux-alt when only x-terminal-emulator is on PATH", () => {
        setPlatform("linux");
        spawnSyncMock.mockImplementation(((_cmd: string, args?: readonly string[]) => {
            const arg = args?.[1] ?? "";
            return { status: arg === "x-terminal-emulator" ? 0 : 1 } as ReturnType<typeof childProcess.spawnSync>;
        }) as typeof childProcess.spawnSync);
        expect(detectTerminalHandler()?.id).toBe("linux-alt");
    });

    it("returns null on linux with neither binary", () => {
        setPlatform("linux");
        spawnSyncMock.mockReturnValue({ status: 1 } as ReturnType<typeof childProcess.spawnSync>);
        expect(detectTerminalHandler()).toBeNull();
    });

    it("returns null on win32 (Windows not supported in v1)", () => {
        setPlatform("win32");
        expect(detectTerminalHandler()).toBeNull();
    });

    it("prefers linux-xdg over linux-alt when both are available", () => {
        setPlatform("linux");
        spawnSyncMock.mockReturnValue({ status: 0 } as ReturnType<typeof childProcess.spawnSync>);
        expect(detectTerminalHandler()?.id).toBe("linux-xdg");
    });
});

describe("launchInDefaultTerminal - macOS", () => {
    let originalPlatform: NodeJS.Platform;

    beforeEach(() => {
        originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "darwin" });
        spawnSyncMock.mockReturnValue({ status: 0 } as ReturnType<typeof childProcess.spawnSync>);
        writeFileMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
        vi.clearAllMocks();
    });

    it("writes a .command launcher script and calls open", async () => {
        const result = await launchInDefaultTerminal({
            cwd: "/path/to/workspace",
            cmd: ["claude", "--rc"],
        });

        expect(result.handlerId).toBe("macos-default");

        const writeCall = writeFileMock.mock.calls[0];
        const launcherPath = writeCall[0] as string;
        const scriptContent = writeCall[1] as string;

        expect(launcherPath).toMatch(/claude-tools-launcher-[\w-]+\.command$/);
        expect(launcherPath.startsWith(os.tmpdir())).toBe(true);
        expect(scriptContent).toContain("#!/bin/bash");
        expect(scriptContent).toContain("cd '/path/to/workspace'");
        expect(scriptContent).toContain("'claude' '--rc'");

        const openCall = spawnSyncMock.mock.calls.find((c) => c[0] === "open");
        expect(openCall).toBeDefined();
        expect(openCall![1]).toEqual([launcherPath]);
    });

    it("throws TerminalLaunchError when open exits non-zero", async () => {
        spawnSyncMock.mockImplementation(((cmd: string) => {
            if (cmd === "open") return { status: 1, stderr: Buffer.from("LSOpenURLs failed") } as ReturnType<typeof childProcess.spawnSync>;
            return { status: 0 } as ReturnType<typeof childProcess.spawnSync>;
        }) as typeof childProcess.spawnSync);

        await expect(launchInDefaultTerminal({ cwd: "/x", cmd: ["claude", "--rc"] })).rejects.toMatchObject({
            name: "TerminalLaunchError",
            handlerId: "macos-default",
        });
    });
});

describe("launchInDefaultTerminal - Linux", () => {
    let originalPlatform: NodeJS.Platform;

    beforeEach(() => {
        originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "linux" });
        spawnSyncMock.mockReturnValue({ status: 0 } as ReturnType<typeof childProcess.spawnSync>);
    });

    afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
        vi.clearAllMocks();
    });

    it("invokes xdg-terminal-exec with the right command string", async () => {
        await launchInDefaultTerminal({ cwd: "/x", cmd: ["claude", "--rc"] });
        const launchCall = spawnSyncMock.mock.calls.find((c) => c[0] === "xdg-terminal-exec");
        expect(launchCall).toBeDefined();
        expect(launchCall![1]).toEqual(["bash", "-c", "cd '/x' && 'claude' '--rc'"]);
    });

    it("throws NoGUITerminalError when no Linux launcher binary is on PATH", async () => {
        spawnSyncMock.mockReturnValue({ status: 1 } as ReturnType<typeof childProcess.spawnSync>);
        await expect(launchInDefaultTerminal({ cwd: "/x", cmd: ["claude"] })).rejects.toMatchObject({
            name: "NoGUITerminalError",
        });
    });
});

describe("error classes", () => {
    it("NoGUITerminalError has stable name", () => {
        const e = new NoGUITerminalError();
        expect(e.name).toBe("NoGUITerminalError");
        expect(e.message).toContain("openSession requires a GUI terminal");
    });

    it("TerminalLaunchError exposes handlerId and detail", () => {
        const e = new TerminalLaunchError("macos-default", "boom");
        expect(e.name).toBe("TerminalLaunchError");
        expect(e.handlerId).toBe("macos-default");
        expect(e.message).toContain("macos-default");
        expect(e.message).toContain("boom");
    });
});
