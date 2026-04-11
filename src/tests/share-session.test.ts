import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SessionInfo } from "../types.js";

const TEST_DIR = path.join(os.tmpdir(), "claude-tools-test-share-" + process.pid);
const TEST_PROJECTS_DIR = path.join(TEST_DIR, "projects");
const TEST_OUTPUT_DIR = path.join(TEST_DIR, "output");

vi.mock("../utils.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        get PROJECTS_DIR() {
            return TEST_PROJECTS_DIR;
        },
        requireProjectsDir: () => {
            if (!fs.existsSync(TEST_PROJECTS_DIR)) {
                throw new Error("Projects dir not found");
            }
        },
    };
});

vi.mock("../session-cost.js", () => ({
    getSessionInfo: vi.fn(
        (_sessionId: string, _projectPath?: string): SessionInfo => ({
            sessionId: _sessionId,
            projectPath: _projectPath || "/test/project",
            names: {
                slug: "test-slug",
                agentName: "",
                customTitle: "Test Session",
                aiTitle: "",
                summary: "",
                description: "Test Session",
            },
            msgCount: 2,
            firstPrompt: "hello",
            created: "2026-01-15T10:00:00Z",
            modified: "2026-01-15T10:05:00Z",
            totalCost: 0.01,
            durations: { apiDurationMs: 1000, wallDurationMs: 5000 },
            codeChanges: null,
            models: [],
        })
    ),
}));

import { exportSession, importSession } from "../share-session.js";
import { readSession } from "../find-session.js";

function makeSessionLine(cwd: string, type = "user", content = "hello"): string {
    return JSON.stringify({
        type,
        timestamp: "2026-01-15T10:00:00Z",
        cwd,
        message: { content },
    });
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

function extractArchive(archivePath: string): string {
    const extractDir = path.join(TEST_DIR, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync("tar", ["xzf", archivePath, "-C", extractDir], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    });
    return extractDir;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
    fs.mkdirSync(TEST_PROJECTS_DIR, { recursive: true });
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
});

afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// exportSession
// ---------------------------------------------------------------------------

describe("exportSession", () => {
    it("creates a tar.gz with manifest and session.jsonl", async () => {
        const projectPath = "/test/project";
        const sessionId = "sess-export-1";
        createProjectDir(projectPath, {
            [`${sessionId}.jsonl`]: [makeSessionLine(projectPath), makeSessionLine(projectPath, "assistant", "world")].join("\n"),
        });

        const outputPath = path.join(TEST_OUTPUT_DIR, `${sessionId}.tar.gz`);
        const result = await exportSession({ sessionId, projectPath, outputPath });

        expect(result.archivePath).toBe(outputPath);
        expect(fs.existsSync(outputPath)).toBe(true);

        const extractDir = extractArchive(outputPath);
        const sessionDir = path.join(extractDir, sessionId);

        expect(fs.existsSync(path.join(sessionDir, "manifest.json"))).toBe(true);
        expect(fs.existsSync(path.join(sessionDir, "session.jsonl"))).toBe(true);

        const jsonlContent = fs.readFileSync(path.join(sessionDir, "session.jsonl"), "utf-8");
        expect(jsonlContent).toContain('"user"');
        expect(jsonlContent).toContain('"assistant"');
    });

    it("includes subagent sessions when includeSubagents is true", async () => {
        const projectPath = "/test/project";
        const sessionId = "sess-with-subs";
        const projectDir = createProjectDir(projectPath, {
            [`${sessionId}.jsonl`]: makeSessionLine(projectPath),
        });

        const companionDir = path.join(projectDir, sessionId);
        fs.mkdirSync(companionDir, { recursive: true });
        fs.writeFileSync(path.join(companionDir, "subagent-1.jsonl"), makeSessionLine(projectPath));
        fs.writeFileSync(path.join(companionDir, "subagent-2.jsonl"), makeSessionLine(projectPath));

        const outputPath = path.join(TEST_OUTPUT_DIR, `${sessionId}.tar.gz`);
        const result = await exportSession({
            sessionId,
            projectPath,
            outputPath,
            includeSubagents: true,
        });

        expect(result.includesSubagents).toBe(true);

        const extractDir = extractArchive(outputPath);
        const subagentsDir = path.join(extractDir, sessionId, "subagents");
        expect(fs.existsSync(path.join(subagentsDir, "subagent-1.jsonl"))).toBe(true);
        expect(fs.existsSync(path.join(subagentsDir, "subagent-2.jsonl"))).toBe(true);
    });

    it("excludes subagent sessions by default", async () => {
        const projectPath = "/test/project";
        const sessionId = "sess-no-subs";
        const projectDir = createProjectDir(projectPath, {
            [`${sessionId}.jsonl`]: makeSessionLine(projectPath),
        });

        const companionDir = path.join(projectDir, sessionId);
        fs.mkdirSync(companionDir, { recursive: true });
        fs.writeFileSync(path.join(companionDir, "subagent-1.jsonl"), makeSessionLine(projectPath));

        const outputPath = path.join(TEST_OUTPUT_DIR, `${sessionId}.tar.gz`);
        const result = await exportSession({ sessionId, projectPath, outputPath });

        expect(result.includesSubagents).toBe(false);

        const extractDir = extractArchive(outputPath);
        const subagentsDir = path.join(extractDir, sessionId, "subagents");
        expect(fs.existsSync(subagentsDir)).toBe(false);
    });

    it("writes manifest with correct metadata", async () => {
        const projectPath = "/test/project";
        const sessionId = "sess-manifest";
        createProjectDir(projectPath, {
            [`${sessionId}.jsonl`]: makeSessionLine(projectPath),
        });

        const outputPath = path.join(TEST_OUTPUT_DIR, `${sessionId}.tar.gz`);
        const result = await exportSession({ sessionId, projectPath, outputPath });

        expect(result.sessionInfo).toBeDefined();
        expect(result.sessionInfo.sessionId).toBe(sessionId);
        expect(result.secretsWarnings).toBeInstanceOf(Array);
        expect(result.includesSubagents).toBe(false);
        expect(result.archiveSize).toBeGreaterThan(0);

        const extractDir = extractArchive(outputPath);
        const manifestOnDisk = JSON.parse(fs.readFileSync(path.join(extractDir, sessionId, "manifest.json"), "utf-8"));
        expect(manifestOnDisk.version).toBe(1);
        expect(manifestOnDisk.sessionId).toBe(sessionId);
        expect(manifestOnDisk.originalProjectPath).toBe(projectPath);
        expect(manifestOnDisk.exportedAt).toBeTruthy();
        expect(manifestOnDisk.claudeToolsVersion).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// importSession
// ---------------------------------------------------------------------------

describe("importSession", () => {
    it("imports a session to a different project path with path rewriting", async () => {
        const originalPath = "/test/original";
        const targetPath = "/test/imported";
        const sessionId = "sess-import-rewrite";
        createProjectDir(originalPath, {
            [`${sessionId}.jsonl`]: [makeSessionLine(originalPath), makeSessionLine(originalPath, "assistant", "world")].join("\n"),
        });

        const outputPath = path.join(TEST_OUTPUT_DIR, `${sessionId}.tar.gz`);
        await exportSession({ sessionId, projectPath: originalPath, outputPath });

        const result = await importSession({ archivePath: outputPath, projectPath: targetPath });

        expect(result.sessionId).toBe(sessionId);
        expect(result.projectPath).toBe(targetPath);
        expect(result.pathsRewritten).toBe(true);
        expect(result.includesSubagents).toBe(false);

        const targetDirName = targetPath.replace(/\//g, "-").replace(/\./g, "-");
        const importedFile = path.join(TEST_PROJECTS_DIR, targetDirName, `${sessionId}.jsonl`);
        expect(fs.existsSync(importedFile)).toBe(true);

        const content = fs.readFileSync(importedFile, "utf-8");
        expect(content).toContain(targetPath);
        expect(content).not.toContain(originalPath);
    });

    it("imports using the original project path when no override given", async () => {
        const originalPath = "/test/fallback";
        const sessionId = "sess-import-fallback";
        createProjectDir(originalPath, {
            [`${sessionId}.jsonl`]: makeSessionLine(originalPath),
        });

        const outputPath = path.join(TEST_OUTPUT_DIR, `${sessionId}.tar.gz`);
        await exportSession({ sessionId, projectPath: originalPath, outputPath });

        // Remove the original project dir to prove import recreates it
        const originalDirName = originalPath.replace(/\//g, "-").replace(/\./g, "-");
        fs.rmSync(path.join(TEST_PROJECTS_DIR, originalDirName), { recursive: true, force: true });

        const result = await importSession({ archivePath: outputPath });

        expect(result.projectPath).toBe(originalPath);
        expect(result.pathsRewritten).toBe(false);

        const importedFile = path.join(TEST_PROJECTS_DIR, originalDirName, `${sessionId}.jsonl`);
        expect(fs.existsSync(importedFile)).toBe(true);
    });

    it("throws on conflict when session already exists at target", async () => {
        const projectPath = "/test/conflict";
        const sessionId = "sess-import-conflict";
        createProjectDir(projectPath, {
            [`${sessionId}.jsonl`]: makeSessionLine(projectPath),
        });

        const outputPath = path.join(TEST_OUTPUT_DIR, `${sessionId}.tar.gz`);
        await exportSession({ sessionId, projectPath, outputPath });

        await expect(importSession({ archivePath: outputPath, projectPath })).rejects.toThrow(/already exists/);
    });

    it("throws on invalid manifest", async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bad-manifest-"));
        const stageDir = path.join(tmpDir, "bad-session");
        fs.mkdirSync(stageDir, { recursive: true });
        fs.writeFileSync(path.join(stageDir, "manifest.json"), JSON.stringify({ version: 999 }));
        fs.writeFileSync(path.join(stageDir, "session.jsonl"), "");

        const archivePath = path.join(TEST_OUTPUT_DIR, "bad-manifest.tar.gz");
        execFileSync("tar", ["czf", archivePath, "-C", tmpDir, "bad-session"], {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        fs.rmSync(tmpDir, { recursive: true, force: true });

        await expect(importSession({ archivePath })).rejects.toThrow(/unsupported.*version|missing.*sessionId/i);
    });

    it("imports subagent sessions when present in archive", async () => {
        const originalPath = "/test/subagents-import";
        const targetPath = "/test/subagents-target";
        const sessionId = "sess-import-subs";
        const projectDir = createProjectDir(originalPath, {
            [`${sessionId}.jsonl`]: makeSessionLine(originalPath),
        });

        const companionDir = path.join(projectDir, sessionId);
        fs.mkdirSync(companionDir, { recursive: true });
        fs.writeFileSync(path.join(companionDir, "sub-1.jsonl"), makeSessionLine(originalPath));

        const outputPath = path.join(TEST_OUTPUT_DIR, `${sessionId}.tar.gz`);
        await exportSession({ sessionId, projectPath: originalPath, outputPath, includeSubagents: true });

        const result = await importSession({ archivePath: outputPath, projectPath: targetPath });

        expect(result.includesSubagents).toBe(true);

        const targetDirName = targetPath.replace(/\//g, "-").replace(/\./g, "-");
        const importedCompanionDir = path.join(TEST_PROJECTS_DIR, targetDirName, sessionId);
        expect(fs.existsSync(importedCompanionDir)).toBe(true);
        expect(fs.existsSync(path.join(importedCompanionDir, "sub-1.jsonl"))).toBe(true);
    });

    it("round-trips: exported then imported session is readable", async () => {
        const originalPath = "/test/roundtrip";
        const targetPath = "/test/roundtrip-imported";
        const sessionId = "sess-roundtrip";
        createProjectDir(originalPath, {
            [`${sessionId}.jsonl`]: [
                makeSessionLine(originalPath, "user", "hello there"),
                makeSessionLine(originalPath, "assistant", "hi back"),
            ].join("\n"),
        });

        const outputPath = path.join(TEST_OUTPUT_DIR, `${sessionId}.tar.gz`);
        await exportSession({ sessionId, projectPath: originalPath, outputPath });

        await importSession({ archivePath: outputPath, projectPath: targetPath });

        const readResult = readSession(sessionId, { projectPath: targetPath });
        expect(readResult.sessionId).toBe(sessionId);
        expect(readResult.messages.length).toBeGreaterThanOrEqual(2);
    });
});
