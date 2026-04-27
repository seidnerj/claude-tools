import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { describe, it, expect, afterEach } from "vitest";
import { openSession } from "../open-session.js";

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
});

const SKIP_INTEGRATION = process.env.CI === "true";

describe.skipIf(SKIP_INTEGRATION)("openSession - integration", () => {
    const sessionName = `test-session-${Date.now()}`;

    afterEach(() => {
        try {
            execFileSync("pkill", ["-f", `claude --rc ${sessionName}`], { stdio: "ignore" });
        } catch {
            // process already gone - this is fine
        }
    });

    it("spawns a session and returns a sessionUrl and workspace", async () => {
        const result = await openSession({
            workspace: os.tmpdir(),
            sessionName,
        });

        expect(result.sessionName).toBe(sessionName);
        expect(result.workspace).toBe(os.tmpdir());
        expect(result.sessionUrl).toMatch(/^https:\/\/claude\.ai\/code\/session_\w+$/);
    }, 20_000);
});
