import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { describe, it, expect, afterEach } from "vitest";
import { openSession, buildClaudeArgs } from "../open-session.js";

describe("openSession - input validation", () => {
    it("throws when workspace is not an absolute path", async () => {
        await expect(openSession({ workspace: "relative/path" })).rejects.toThrow("workspace must be an absolute path");
    });

    it("throws when workspace does not exist", async () => {
        await expect(openSession({ workspace: "/nonexistent/path/that/does/not/exist" })).rejects.toThrow("workspace does not exist");
    });

    it("throws when workspace is a file, not a directory", async () => {
        const tmpFile = path.join(os.tmpdir(), `open-session-test-${Date.now()}.txt`);
        fs.writeFileSync(tmpFile, "hello");
        try {
            await expect(openSession({ workspace: tmpFile })).rejects.toThrow("workspace is not a directory");
        } finally {
            fs.rmSync(tmpFile, { force: true });
        }
    });

    it("throws when sessionName and resume are both provided", async () => {
        await expect(openSession({ workspace: os.tmpdir(), sessionName: "a", resume: "b" })).rejects.toThrow(/mutually exclusive/);
    });

    it("throws when resume and continueLast are both provided", async () => {
        await expect(openSession({ workspace: os.tmpdir(), resume: "x", continueLast: true })).rejects.toThrow(/mutually exclusive/);
    });

    it("throws when sessionName and continueLast are both provided", async () => {
        await expect(openSession({ workspace: os.tmpdir(), sessionName: "a", continueLast: true })).rejects.toThrow(/mutually exclusive/);
    });
});

describe("buildClaudeArgs", () => {
    it("returns just --rc for a bare new session", () => {
        expect(buildClaudeArgs({ workspace: "/tmp" })).toEqual(["--rc"]);
    });

    it("appends sessionName as a positional after --rc", () => {
        expect(buildClaudeArgs({ workspace: "/tmp", sessionName: "feat-x" })).toEqual(["--rc", "feat-x"]);
    });

    it("emits --resume <value> for resume by UUID", () => {
        expect(buildClaudeArgs({ workspace: "/tmp", resume: "0aa1af9c-54a7-4398-9f97-b706bbe1f600" })).toEqual([
            "--rc",
            "--resume",
            "0aa1af9c-54a7-4398-9f97-b706bbe1f600",
        ]);
    });

    it("emits --resume <value> for resume by session name (passed through to claude)", () => {
        expect(buildClaudeArgs({ workspace: "/tmp", resume: "my-named-session" })).toEqual(["--rc", "--resume", "my-named-session"]);
    });

    it("emits --continue when continueLast is true", () => {
        expect(buildClaudeArgs({ workspace: "/tmp", continueLast: true })).toEqual(["--rc", "--continue"]);
    });

    it("continueLast wins if (defensively) combined with sessionName or resume", () => {
        expect(buildClaudeArgs({ workspace: "/tmp", continueLast: true, sessionName: "x", resume: "y" })).toEqual(["--rc", "--continue"]);
    });
});

const HAS_TMUX = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!HAS_TMUX)("openSession - tmux session collisions", () => {
    const collisionName = `collision-test-${Date.now()}`;
    const tmuxName = `claude-rc-${collisionName}`;

    afterEach(() => {
        spawnSync("tmux", ["kill-session", "-t", `=${tmuxName}`], { stdio: "ignore" });
    });

    it("throws when a tmux session with the derived name already exists", async () => {
        spawnSync("tmux", ["new-session", "-d", "-s", tmuxName, "sleep", "60"], { stdio: "ignore" });
        await expect(openSession({ workspace: os.tmpdir(), sessionName: collisionName })).rejects.toThrow(/tmux session .* already exists/);
    });
});

const SKIP_INTEGRATION = process.env.CI === "true";

describe.skipIf(SKIP_INTEGRATION)("openSession - integration", () => {
    const sessionName = `test-session-${Date.now()}`;
    let tmuxSession: string | undefined;

    afterEach(() => {
        if (tmuxSession) {
            spawnSync("tmux", ["kill-session", "-t", `=${tmuxSession}`], { stdio: "ignore" });
            tmuxSession = undefined;
        }
    });

    it("spawns a session inside tmux and returns the session URL plus tmux name", async () => {
        const result = await openSession({
            workspace: os.tmpdir(),
            sessionName,
        });
        tmuxSession = result.tmuxSession;

        expect(result.sessionName).toBe(sessionName);
        expect(result.workspace).toBe(os.tmpdir());
        expect(result.sessionUrl).toMatch(/^https:\/\/claude\.ai\/code\/session_\w+$/);
        expect(result.tmuxSession).toMatch(/^claude-rc-/);
        expect(result.resumedSessionId).toBeUndefined();

        const has = spawnSync("tmux", ["has-session", "-t", `=${result.tmuxSession}`], { stdio: "ignore" });
        expect(has.status).toBe(0);
    }, 35_000);
});
