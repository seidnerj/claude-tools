import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it, expect } from "vitest";
import { openSession, buildClaudeArgs } from "../open-session.js";

describe("openSession - input validation", () => {
    it("throws when workspace is not an absolute path", async () => {
        await expect(openSession({ workspace: "relative/path" })).rejects.toThrow("workspace must be an absolute path");
    });

    it("throws when workspace does not exist", async () => {
        await expect(openSession({ workspace: "/nonexistent/path" })).rejects.toThrow("workspace does not exist");
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

    it("appends extraArgs after the primary mode flag", () => {
        expect(
            buildClaudeArgs({
                workspace: "/tmp",
                resume: "abc",
                extraArgs: ["--model", "claude-opus-4-6", "--add-dir", "/extra"],
            })
        ).toEqual(["--rc", "--resume", "abc", "--model", "claude-opus-4-6", "--add-dir", "/extra"]);
    });

    it("appends extraArgs even with no primary mode flag", () => {
        expect(buildClaudeArgs({ workspace: "/tmp", extraArgs: ["--debug"] })).toEqual(["--rc", "--debug"]);
    });

    it("continueLast wins if (defensively) combined with sessionName or resume", () => {
        expect(buildClaudeArgs({ workspace: "/tmp", continueLast: true, sessionName: "x", resume: "y" })).toEqual(["--rc", "--continue"]);
    });
});

const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";

describe.skipIf(!RUN_INTEGRATION)("openSession - integration (RUN_INTEGRATION_TESTS=1)", () => {
    it("dispatches a launcher in the default terminal and returns workspace + handlerId", async () => {
        const result = await openSession({
            workspace: process.cwd(),
            sessionName: `integ-${Date.now()}`,
        });
        expect(result.workspace).toBe(process.cwd());
        expect(result.handlerId).toMatch(/^(macos-default|linux-xdg|linux-alt)$/);
    });
});
