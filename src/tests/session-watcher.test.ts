import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { watchForSessionUrl, SessionWatchTimeoutError } from "../session-watcher.js";

describe("watchForSessionUrl", () => {
    let tmpHome: string;
    let originalHome: string | undefined;
    let workspace: string;
    let projectDir: string;

    beforeEach(async () => {
        tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-watcher-test-"));
        originalHome = process.env.HOME;
        process.env.HOME = tmpHome;
        workspace = await fs.mkdtemp(path.join(tmpHome, "ws-"));
        const encoded = path.resolve(workspace).replace(/\//g, "-");
        projectDir = path.join(tmpHome, ".claude", "projects", encoded);
    });

    afterEach(async () => {
        if (originalHome !== undefined) process.env.HOME = originalHome;
        else delete process.env.HOME;
        await fs.rm(tmpHome, { recursive: true, force: true });
    });

    it("resolves when a new .jsonl with a session URL appears", async () => {
        const watchPromise = watchForSessionUrl({ workspace, timeoutMs: 5_000 });
        await new Promise((r) => setTimeout(r, 50));
        const sessionId = "abc-123";
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(
            path.join(projectDir, `${sessionId}.jsonl`),
            `{"sessionUrl":"https://claude.ai/code/session_xyz789"}\n`,
        );
        const result = await watchPromise;
        expect(result.sessionUrl).toBe("https://claude.ai/code/session_xyz789");
        expect(result.sessionId).toBe(sessionId);
    });

    it("ignores non-.jsonl files in the project dir", async () => {
        const watchPromise = watchForSessionUrl({ workspace, timeoutMs: 1_000 });
        await new Promise((r) => setTimeout(r, 50));
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(path.join(projectDir, "notes.txt"), "https://claude.ai/code/session_xyz789");
        await expect(watchPromise).rejects.toBeInstanceOf(SessionWatchTimeoutError);
    });

    it("filters by expectedSessionId when provided", async () => {
        const watchPromise = watchForSessionUrl({
            workspace,
            timeoutMs: 5_000,
            expectedSessionId: "target",
        });
        await new Promise((r) => setTimeout(r, 50));
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(
            path.join(projectDir, "other.jsonl"),
            `{"sessionUrl":"https://claude.ai/code/session_decoy"}\n`,
        );
        await new Promise((r) => setTimeout(r, 600));
        await fs.writeFile(
            path.join(projectDir, "target.jsonl"),
            `{"sessionUrl":"https://claude.ai/code/session_real"}\n`,
        );
        const result = await watchPromise;
        expect(result.sessionId).toBe("target");
        expect(result.sessionUrl).toBe("https://claude.ai/code/session_real");
    });

    it("rejects with SessionWatchTimeoutError when no URL appears", async () => {
        await expect(watchForSessionUrl({ workspace, timeoutMs: 500 })).rejects.toMatchObject({
            name: "SessionWatchTimeoutError",
            workspace,
            timeoutMs: 500,
        });
    });

    it("creates the project dir if it does not exist", async () => {
        const watchPromise = watchForSessionUrl({ workspace, timeoutMs: 1_000 });
        await new Promise((r) => setTimeout(r, 50));
        const stat = await fs.stat(projectDir);
        expect(stat.isDirectory()).toBe(true);
        await expect(watchPromise).rejects.toBeInstanceOf(SessionWatchTimeoutError);
    });

    it("matches both quoted and bare URL forms", async () => {
        const watchPromise = watchForSessionUrl({ workspace, timeoutMs: 5_000 });
        await new Promise((r) => setTimeout(r, 50));
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(
            path.join(projectDir, "bare.jsonl"),
            `Plain text: https://claude.ai/code/session_bare and more text\n`,
        );
        const result = await watchPromise;
        expect(result.sessionUrl).toBe("https://claude.ai/code/session_bare");
    });

    it("detects URL appended to an existing file (resume case)", async () => {
        await fs.mkdir(projectDir, { recursive: true });
        const file = path.join(projectDir, "existing.jsonl");
        await fs.writeFile(file, `{"role":"user","content":"hello"}\n`);

        const watchPromise = watchForSessionUrl({
            workspace,
            timeoutMs: 5_000,
            expectedSessionId: "existing",
        });
        await new Promise((r) => setTimeout(r, 600));
        await fs.appendFile(file, `{"sessionUrl":"https://claude.ai/code/session_resumed"}\n`);

        const result = await watchPromise;
        expect(result.sessionId).toBe("existing");
        expect(result.sessionUrl).toBe("https://claude.ai/code/session_resumed");
    });

    it("does not pick up URLs from pre-existing content (snapshots size at start)", async () => {
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(
            path.join(projectDir, "old.jsonl"),
            `{"sessionUrl":"https://claude.ai/code/session_old"}\n`,
        );
        await expect(watchForSessionUrl({ workspace, timeoutMs: 1_000 })).rejects.toBeInstanceOf(
            SessionWatchTimeoutError,
        );
    });
});

describe("SessionWatchTimeoutError", () => {
    it("has stable name and exposes fields", () => {
        const e = new SessionWatchTimeoutError("/ws", 60_000);
        expect(e.name).toBe("SessionWatchTimeoutError");
        expect(e.workspace).toBe("/ws");
        expect(e.timeoutMs).toBe(60_000);
        expect(e.expectedSessionId).toBeUndefined();
        expect(e.message).toContain("New session");
    });

    it("includes session id in message when expectedSessionId is set", () => {
        const e = new SessionWatchTimeoutError("/ws", 60_000, "target");
        expect(e.expectedSessionId).toBe("target");
        expect(e.message).toContain("target");
        expect(e.message).toContain("Resumed");
    });
});
