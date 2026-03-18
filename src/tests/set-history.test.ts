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
