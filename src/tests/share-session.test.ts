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

import { exportSession } from "../share-session.js";

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
