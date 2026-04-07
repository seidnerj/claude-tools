import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TEST_DIR = path.join(os.tmpdir(), "claude-tools-test-history-" + process.pid);
const TEST_PROJECTS_DIR = path.join(TEST_DIR, "projects");
const TEST_HISTORY_FILE = path.join(TEST_DIR, "history.jsonl");

vi.mock("../utils.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        get PROJECTS_DIR() {
            return TEST_PROJECTS_DIR;
        },
        get HISTORY_FILE() {
            return TEST_HISTORY_FILE;
        },
        requireProjectsDir: () => {
            if (!fs.existsSync(TEST_PROJECTS_DIR)) {
                throw new Error("Projects dir not found");
            }
        },
    };
});

import { copyHistory, deleteHistory, moveHistory, cleanBrokenResumeArtifacts } from "../set-history.js";

function makeSessionLine(cwd: string, type = "user", content = "hello"): string {
    return JSON.stringify({
        type,
        timestamp: "2026-01-15T10:00:00Z",
        cwd,
        message: { content },
    });
}

function makeSummaryLine(summary: string): string {
    return JSON.stringify({ type: "summary", summary });
}

function createProjectDir(projectPath: string, sessions?: Record<string, string>): string {
    const dirName = projectPath.replace(/\//g, "-").replace(/\./g, "-");
    const fullPath = path.join(TEST_PROJECTS_DIR, dirName);
    fs.mkdirSync(fullPath, { recursive: true });
    if (sessions) {
        for (const [name, content] of Object.entries(sessions)) {
            fs.writeFileSync(path.join(fullPath, name), content);
        }
    }
    return fullPath;
}

function createHistoryFile(content: string): void {
    fs.writeFileSync(TEST_HISTORY_FILE, content);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
    fs.mkdirSync(TEST_PROJECTS_DIR, { recursive: true });
});

afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// cleanBrokenResumeArtifacts
// ---------------------------------------------------------------------------

describe("cleanBrokenResumeArtifacts", () => {
    it("removes junk summaries after a good summary", () => {
        const projectDir = createProjectDir("/test/project", {
            "sess1.jsonl": [
                makeSessionLine("/test/project"),
                makeSummaryLine("Good summary of work done"),
                makeSummaryLine("I don't have enough context"),
            ].join("\n"),
        });

        const cleaned = cleanBrokenResumeArtifacts(projectDir);
        expect(cleaned).toBe(1);

        const content = fs.readFileSync(path.join(projectDir, "sess1.jsonl"), "utf-8");
        expect(content).not.toContain("I don");
        expect(content).toContain("Good summary of work done");
    });

    it("leaves files without junk summaries untouched", () => {
        const projectDir = createProjectDir("/test/project", {
            "sess1.jsonl": [makeSessionLine("/test/project"), makeSummaryLine("Good summary")].join("\n"),
        });

        const cleaned = cleanBrokenResumeArtifacts(projectDir);
        expect(cleaned).toBe(0);
    });

    it("handles 'Unable to generate' junk summaries", () => {
        const projectDir = createProjectDir("/test/project", {
            "sess1.jsonl": [makeSessionLine("/test/project"), makeSummaryLine("Real summary"), makeSummaryLine("Unable to generate a summary")].join(
                "\n"
            ),
        });

        const cleaned = cleanBrokenResumeArtifacts(projectDir);
        expect(cleaned).toBe(1);
    });

    it("skips files with no good summaries", () => {
        const projectDir = createProjectDir("/test/project", {
            "sess1.jsonl": [makeSessionLine("/test/project"), makeSummaryLine("I don't know")].join("\n"),
        });

        const cleaned = cleanBrokenResumeArtifacts(projectDir);
        expect(cleaned).toBe(0);
    });

    it("skips non-jsonl files", () => {
        const projectDir = createProjectDir("/test/project", {
            "notes.txt": "some text",
            "sessions-index.json": "{}",
        });

        const cleaned = cleanBrokenResumeArtifacts(projectDir);
        expect(cleaned).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// copyHistory
// ---------------------------------------------------------------------------

describe("copyHistory", () => {
    it("copies project directory and updates references", async () => {
        const sourcePath = "/test/old-project";
        const destPath = "/test/new-project";

        createProjectDir(sourcePath, {
            "sess1.jsonl": [makeSessionLine(sourcePath), makeSessionLine(sourcePath, "assistant", "response")].join("\n"),
        });
        createHistoryFile(JSON.stringify({ path: sourcePath, sessionId: "sess1" }) + "\n");

        const result = await copyHistory(sourcePath, destPath);

        expect(result.sourcePath).toBe(sourcePath);
        expect(result.destPath).toBe(destPath);
        expect(result.sessionFilesUpdated).toBe(1);
        expect(result.historyFileUpdated).toBe(true);

        const sourceDirName = sourcePath.replace(/\//g, "-").replace(/\./g, "-");
        const destDirName = destPath.replace(/\//g, "-").replace(/\./g, "-");

        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, sourceDirName))).toBe(true);
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, destDirName))).toBe(true);

        const destContent = fs.readFileSync(path.join(TEST_PROJECTS_DIR, destDirName, "sess1.jsonl"), "utf-8");
        expect(destContent).toContain(`"${destPath}"`);
        expect(destContent).not.toContain(`"${sourcePath}"`);

        const sourceContent = fs.readFileSync(path.join(TEST_PROJECTS_DIR, sourceDirName, "sess1.jsonl"), "utf-8");
        expect(sourceContent).toContain(`"${sourcePath}"`);

        const history = fs.readFileSync(TEST_HISTORY_FILE, "utf-8");
        expect(history).toContain(`"${sourcePath}"`);
        expect(history).toContain(`"${destPath}"`);
    });

    it("updates sessions-index.json in the copy", async () => {
        const sourcePath = "/test/old-project";
        const destPath = "/test/new-project";
        const sourceDirName = sourcePath.replace(/\//g, "-").replace(/\./g, "-");
        const destDirName = destPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(sourcePath, {
            "sess1.jsonl": makeSessionLine(sourcePath),
            "sessions-index.json": JSON.stringify({
                sessions: [{ path: sourceDirName, fullPath: sourcePath }],
            }),
        });

        const result = await copyHistory(sourcePath, destPath);
        expect(result.sessionsIndexUpdated).toBe(true);

        const idx = fs.readFileSync(path.join(TEST_PROJECTS_DIR, destDirName, "sessions-index.json"), "utf-8");
        expect(idx).toContain(destDirName);
        expect(idx).toContain(`"${destPath}"`);
        expect(idx).not.toContain(sourceDirName);
    });

    it("throws if source does not exist", async () => {
        await expect(copyHistory("/no/source", "/no/dest")).rejects.toThrow(/No Claude history found for source/);
    });

    it("throws if destination already exists", async () => {
        createProjectDir("/test/source");
        createProjectDir("/test/dest");

        await expect(copyHistory("/test/source", "/test/dest")).rejects.toThrow(/already exists for destination/);
    });

    it("throws if source and destination are identical", async () => {
        await expect(copyHistory("/test/same", "/test/same")).rejects.toThrow(/identical/);
    });
});

// ---------------------------------------------------------------------------
// deleteHistory
// ---------------------------------------------------------------------------

describe("deleteHistory", () => {
    it("removes project directory and history entries", async () => {
        const targetPath = "/test/delete-me";
        const dirName = targetPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(targetPath, {
            "sess1.jsonl": makeSessionLine(targetPath),
        });
        createHistoryFile(
            [JSON.stringify({ path: targetPath, sessionId: "sess1" }), JSON.stringify({ path: "/test/keep-me", sessionId: "sess2" })].join("\n")
        );

        const result = await deleteHistory(targetPath);

        expect(result.targetPath).toBe(targetPath);
        expect(result.historyFileUpdated).toBe(true);
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, dirName))).toBe(false);

        const history = fs.readFileSync(TEST_HISTORY_FILE, "utf-8");
        expect(history).not.toContain(`"${targetPath}"`);
        expect(history).toContain("/test/keep-me");
    });

    it("throws if project directory does not exist", async () => {
        await expect(deleteHistory("/test/nonexistent")).rejects.toThrow(/No Claude history found/);
    });

    it("handles missing history file gracefully", async () => {
        createProjectDir("/test/no-history-file", {
            "sess1.jsonl": makeSessionLine("/test/no-history-file"),
        });

        const result = await deleteHistory("/test/no-history-file");
        expect(result.historyFileUpdated).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// moveHistory
// ---------------------------------------------------------------------------

describe("moveHistory", () => {
    it("moves history from old to new path", async () => {
        const oldPath = "/test/old";
        const newPath = "/test/new";
        const oldDirName = oldPath.replace(/\//g, "-").replace(/\./g, "-");
        const newDirName = newPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(oldPath, {
            "sess1.jsonl": makeSessionLine(oldPath),
        });
        createHistoryFile(JSON.stringify({ path: oldPath, sessionId: "sess1" }) + "\n");

        const result = await moveHistory(oldPath, newPath);

        expect(result.oldPath).toBe(oldPath);
        expect(result.newPath).toBe(newPath);
        expect(result.sessionFilesUpdated).toBe(1);

        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, oldDirName))).toBe(false);
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, newDirName))).toBe(true);

        const content = fs.readFileSync(path.join(TEST_PROJECTS_DIR, newDirName, "sess1.jsonl"), "utf-8");
        expect(content).toContain(`"${newPath}"`);
        expect(content).not.toContain(`"${oldPath}"`);

        const history = fs.readFileSync(TEST_HISTORY_FILE, "utf-8");
        expect(history).toContain(`"${newPath}"`);
        expect(history).not.toContain(`"${oldPath}"`);
    });

    it("handles already-moved directory (only new exists)", async () => {
        const oldPath = "/test/old";
        const newPath = "/test/new";
        const newDirName = newPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(newPath, {
            "sess1.jsonl": makeSessionLine(oldPath),
        });
        createHistoryFile(JSON.stringify({ path: oldPath, sessionId: "sess1" }) + "\n");

        const result = await moveHistory(oldPath, newPath);

        expect(result.sessionFilesUpdated).toBe(1);
        expect(result.historyFileUpdated).toBe(true);

        const content = fs.readFileSync(path.join(TEST_PROJECTS_DIR, newDirName, "sess1.jsonl"), "utf-8");
        expect(content).toContain(`"${newPath}"`);
    });

    it("throws when both directories exist", async () => {
        createProjectDir("/test/a");
        createProjectDir("/test/b");

        await expect(moveHistory("/test/a", "/test/b")).rejects.toThrow(/Cannot merge/);
    });

    it("throws when neither directory exists", async () => {
        await expect(moveHistory("/test/x", "/test/y")).rejects.toThrow(/No Claude history found for either/);
    });

    it("throws when paths are identical", async () => {
        await expect(moveHistory("/test/same", "/test/same")).rejects.toThrow(/identical/);
    });
});

// ---------------------------------------------------------------------------
// Per-session: copyHistory with sessionIds
// ---------------------------------------------------------------------------

describe("copyHistory with sessionIds", () => {
    it("copies specific sessions to a new project (dest does not exist)", async () => {
        const sourcePath = "/test/source";
        const destPath = "/test/dest";
        const destDirName = destPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(sourcePath, {
            "sess-a.jsonl": makeSessionLine(sourcePath),
            "sess-b.jsonl": makeSessionLine(sourcePath),
            "sess-c.jsonl": makeSessionLine(sourcePath),
        });

        const result = await copyHistory(sourcePath, destPath, ["sess-a", "sess-c"]);

        expect(result.sessionIds).toEqual(["sess-a", "sess-c"]);
        expect(result.sessionsNotFound).toBeUndefined();

        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, destDirName, "sess-a.jsonl"))).toBe(true);
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, destDirName, "sess-c.jsonl"))).toBe(true);
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, destDirName, "sess-b.jsonl"))).toBe(false);
    });

    it("copies specific sessions to an existing project", async () => {
        const sourcePath = "/test/source";
        const destPath = "/test/dest";
        const destDirName = destPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(sourcePath, {
            "sess-a.jsonl": makeSessionLine(sourcePath),
        });
        createProjectDir(destPath, {
            "existing.jsonl": makeSessionLine(destPath),
        });

        const result = await copyHistory(sourcePath, destPath, ["sess-a"]);

        expect(result.sessionIds).toEqual(["sess-a"]);
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, destDirName, "sess-a.jsonl"))).toBe(true);
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, destDirName, "existing.jsonl"))).toBe(true);
    });

    it("updates path refs in copied sessions", async () => {
        const sourcePath = "/test/source";
        const destPath = "/test/dest";
        const sourceDirName = sourcePath.replace(/\//g, "-").replace(/\./g, "-");
        const destDirName = destPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(sourcePath, {
            "sess-a.jsonl": makeSessionLine(sourcePath),
        });

        await copyHistory(sourcePath, destPath, ["sess-a"]);

        const destContent = fs.readFileSync(path.join(TEST_PROJECTS_DIR, destDirName, "sess-a.jsonl"), "utf-8");
        expect(destContent).toContain(`"${destPath}"`);
        expect(destContent).not.toContain(`"${sourcePath}"`);

        const sourceContent = fs.readFileSync(path.join(TEST_PROJECTS_DIR, sourceDirName, "sess-a.jsonl"), "utf-8");
        expect(sourceContent).toContain(`"${sourcePath}"`);
    });

    it("copies companion directories alongside .jsonl", async () => {
        const sourcePath = "/test/source";
        const destPath = "/test/dest";
        const sourceDirName = sourcePath.replace(/\//g, "-").replace(/\./g, "-");
        const destDirName = destPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(sourcePath, {
            "sess-a.jsonl": makeSessionLine(sourcePath),
        });
        const companionDir = path.join(TEST_PROJECTS_DIR, sourceDirName, "sess-a");
        fs.mkdirSync(companionDir, { recursive: true });
        fs.writeFileSync(path.join(companionDir, "subagent.jsonl"), "test data");

        await copyHistory(sourcePath, destPath, ["sess-a"]);

        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, destDirName, "sess-a", "subagent.jsonl"))).toBe(true);
    });

    it("reports non-existent session IDs in sessionsNotFound", async () => {
        const sourcePath = "/test/source";
        const destPath = "/test/dest";

        createProjectDir(sourcePath, {
            "sess-a.jsonl": makeSessionLine(sourcePath),
        });

        const result = await copyHistory(sourcePath, destPath, ["sess-a", "nonexistent"]);

        expect(result.sessionIds).toEqual(["sess-a"]);
        expect(result.sessionsNotFound).toEqual(["nonexistent"]);
    });

    it("throws on empty sessionIds array", async () => {
        createProjectDir("/test/source");
        await expect(copyHistory("/test/source", "/test/dest", [])).rejects.toThrow(/at least one session ID/);
    });

    it("does not duplicate global history entries for per-session copy", async () => {
        const sourcePath = "/test/source";
        const destPath = "/test/dest";

        createProjectDir(sourcePath, {
            "sess-a.jsonl": makeSessionLine(sourcePath),
        });
        createHistoryFile(JSON.stringify({ path: sourcePath, sessionId: "sess-a" }) + "\n");

        const result = await copyHistory(sourcePath, destPath, ["sess-a"]);
        expect(result.historyFileUpdated).toBe(false);

        const history = fs.readFileSync(TEST_HISTORY_FILE, "utf-8");
        expect(history).not.toContain(`"${destPath}"`);
    });

    it("creates sessions-index.json when dest project is new", async () => {
        const sourcePath = "/test/source";
        const destPath = "/test/new-dest";
        const destDirName = destPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(sourcePath, {
            "sess-a.jsonl": makeSessionLine(sourcePath),
        });

        await copyHistory(sourcePath, destPath, ["sess-a"]);

        const indexPath = path.join(TEST_PROJECTS_DIR, destDirName, "sessions-index.json");
        expect(fs.existsSync(indexPath)).toBe(true);
        const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        expect(index.version).toBe(1);
        expect(index.originalPath).toBe(destPath);
    });
});

// ---------------------------------------------------------------------------
// Per-session: deleteHistory with sessionIds
// ---------------------------------------------------------------------------

describe("deleteHistory with sessionIds", () => {
    it("deletes specific sessions while preserving project dir", async () => {
        const targetPath = "/test/project";
        const dirName = targetPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(targetPath, {
            "sess-a.jsonl": makeSessionLine(targetPath),
            "sess-b.jsonl": makeSessionLine(targetPath),
        });

        const result = await deleteHistory(targetPath, ["sess-a"]);

        expect(result.sessionIds).toEqual(["sess-a"]);
        expect(result.sessionsNotFound).toBeUndefined();
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, dirName, "sess-a.jsonl"))).toBe(false);
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, dirName, "sess-b.jsonl"))).toBe(true);
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, dirName))).toBe(true);
    });

    it("deletes companion directories", async () => {
        const targetPath = "/test/project";
        const dirName = targetPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(targetPath, {
            "sess-a.jsonl": makeSessionLine(targetPath),
        });
        const companionDir = path.join(TEST_PROJECTS_DIR, dirName, "sess-a");
        fs.mkdirSync(companionDir, { recursive: true });
        fs.writeFileSync(path.join(companionDir, "subagent.jsonl"), "test");

        await deleteHistory(targetPath, ["sess-a"]);

        expect(fs.existsSync(companionDir)).toBe(false);
    });

    it("reports non-existent session IDs gracefully", async () => {
        const targetPath = "/test/project";

        createProjectDir(targetPath, {
            "sess-a.jsonl": makeSessionLine(targetPath),
        });

        const result = await deleteHistory(targetPath, ["sess-a", "nonexistent"]);

        expect(result.sessionIds).toEqual(["sess-a"]);
        expect(result.sessionsNotFound).toEqual(["nonexistent"]);
    });

    it("does not touch global history file", async () => {
        const targetPath = "/test/project";

        createProjectDir(targetPath, {
            "sess-a.jsonl": makeSessionLine(targetPath),
            "sess-b.jsonl": makeSessionLine(targetPath),
        });
        createHistoryFile(JSON.stringify({ path: targetPath, sessionId: "sess-a" }) + "\n");

        const result = await deleteHistory(targetPath, ["sess-a"]);
        expect(result.historyFileUpdated).toBe(false);

        const history = fs.readFileSync(TEST_HISTORY_FILE, "utf-8");
        expect(history).toContain(`"${targetPath}"`);
    });

    it("throws on empty sessionIds array", async () => {
        createProjectDir("/test/project");
        await expect(deleteHistory("/test/project", [])).rejects.toThrow(/at least one session ID/);
    });
});

// ---------------------------------------------------------------------------
// Per-session: moveHistory with sessionIds
// ---------------------------------------------------------------------------

describe("moveHistory with sessionIds", () => {
    it("moves specific sessions between two existing projects", async () => {
        const oldPath = "/test/old";
        const newPath = "/test/new";
        const oldDirName = oldPath.replace(/\//g, "-").replace(/\./g, "-");
        const newDirName = newPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(oldPath, {
            "sess-a.jsonl": makeSessionLine(oldPath),
            "sess-b.jsonl": makeSessionLine(oldPath),
        });
        createProjectDir(newPath, {
            "existing.jsonl": makeSessionLine(newPath),
        });

        const result = await moveHistory(oldPath, newPath, ["sess-a"]);

        expect(result.sessionIds).toEqual(["sess-a"]);

        // Moved to dest
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, newDirName, "sess-a.jsonl"))).toBe(true);
        // Removed from source
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, oldDirName, "sess-a.jsonl"))).toBe(false);
        // Remaining sessions untouched in source
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, oldDirName, "sess-b.jsonl"))).toBe(true);
        // Pre-existing dest sessions preserved
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, newDirName, "existing.jsonl"))).toBe(true);
    });

    it("updates path refs in moved sessions", async () => {
        const oldPath = "/test/old";
        const newPath = "/test/new";
        const newDirName = newPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(oldPath, {
            "sess-a.jsonl": makeSessionLine(oldPath),
        });

        await moveHistory(oldPath, newPath, ["sess-a"]);

        const content = fs.readFileSync(path.join(TEST_PROJECTS_DIR, newDirName, "sess-a.jsonl"), "utf-8");
        expect(content).toContain(`"${newPath}"`);
        expect(content).not.toContain(`"${oldPath}"`);
    });

    it("does NOT error when both projects exist for per-session moves", async () => {
        createProjectDir("/test/a", { "sess-a.jsonl": makeSessionLine("/test/a") });
        createProjectDir("/test/b", { "sess-b.jsonl": makeSessionLine("/test/b") });

        await expect(moveHistory("/test/a", "/test/b", ["sess-a"])).resolves.toBeDefined();
    });

    it("still errors when both projects exist for whole-project moves", async () => {
        createProjectDir("/test/a");
        createProjectDir("/test/b");

        await expect(moveHistory("/test/a", "/test/b")).rejects.toThrow(/Cannot merge/);
    });

    it("moves to a brand-new destination project", async () => {
        const oldPath = "/test/old";
        const newPath = "/test/brand-new";
        const newDirName = newPath.replace(/\//g, "-").replace(/\./g, "-");

        createProjectDir(oldPath, {
            "sess-a.jsonl": makeSessionLine(oldPath),
        });

        await moveHistory(oldPath, newPath, ["sess-a"]);

        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, newDirName, "sess-a.jsonl"))).toBe(true);
        expect(fs.existsSync(path.join(TEST_PROJECTS_DIR, newDirName, "sessions-index.json"))).toBe(true);
    });

    it("reports non-existent session IDs", async () => {
        createProjectDir("/test/old", { "sess-a.jsonl": makeSessionLine("/test/old") });

        const result = await moveHistory("/test/old", "/test/new", ["sess-a", "ghost"]);

        expect(result.sessionIds).toEqual(["sess-a"]);
        expect(result.sessionsNotFound).toEqual(["ghost"]);
    });

    it("throws on empty sessionIds array", async () => {
        createProjectDir("/test/old");
        await expect(moveHistory("/test/old", "/test/new", [])).rejects.toThrow(/at least one session ID/);
    });

    it("warns when moving a live session (currentSessionId matches)", async () => {
        createProjectDir("/test/old", { "live-sess.jsonl": makeSessionLine("/test/old") });

        const result = await moveHistory("/test/old", "/test/new", ["live-sess"], "live-sess");

        expect(result.warnings).toBeDefined();
        expect(result.warnings![0]).toContain("currently running session");
        expect(result.warnings![0]).toContain("copy_history");
    });

    it("no warning when currentSessionId does not match", async () => {
        createProjectDir("/test/old", { "other-sess.jsonl": makeSessionLine("/test/old") });

        const result = await moveHistory("/test/old", "/test/new", ["other-sess"], "different-sess");

        expect(result.warnings).toBeUndefined();
    });

    it("no warning when currentSessionId is not provided", async () => {
        createProjectDir("/test/old", { "sess-a.jsonl": makeSessionLine("/test/old") });

        const result = await moveHistory("/test/old", "/test/new", ["sess-a"]);

        expect(result.warnings).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Per-session: deleteHistory live session warnings
// ---------------------------------------------------------------------------

describe("deleteHistory live session warnings", () => {
    it("warns when deleting a live session", async () => {
        createProjectDir("/test/project", { "live-sess.jsonl": makeSessionLine("/test/project") });

        const result = await deleteHistory("/test/project", ["live-sess"], "live-sess");

        expect(result.warnings).toBeDefined();
        expect(result.warnings![0]).toContain("currently running session");
    });

    it("no warning when currentSessionId does not match", async () => {
        createProjectDir("/test/project", { "other.jsonl": makeSessionLine("/test/project") });

        const result = await deleteHistory("/test/project", ["other"], "different");

        expect(result.warnings).toBeUndefined();
    });
});
