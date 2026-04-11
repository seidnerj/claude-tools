// ---------------------------------------------------------------------------
// Export and import Claude Code sessions as portable archives
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { SessionInfo } from "./types.js";
import { findSessionFile } from "./find-session.js";
import { getSessionInfo } from "./session-cost.js";
import { PROJECTS_DIR, pathToDirname, requireProjectsDir } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Manifest {
    version: number;
    exportedAt: string;
    claudeToolsVersion: string;
    sessionId: string;
    originalProjectPath: string;
    includesSubagents: boolean;
    secretsWarnings: string[];
    sessionInfo: SessionInfo;
}

export interface ExportOptions {
    sessionId: string;
    projectPath?: string;
    outputPath?: string;
    includeSubagents?: boolean;
}

export interface ExportResult {
    archivePath: string;
    sessionInfo: SessionInfo;
    secretsWarnings: string[];
    includesSubagents: boolean;
    archiveSize: number;
}

export interface ImportOptions {
    archivePath: string;
    projectPath?: string;
}

export interface ImportResult {
    sessionId: string;
    projectPath: string;
    sessionInfo: SessionInfo;
    includesSubagents: boolean;
    pathsRewritten: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the package version from package.json */
function getPackageVersion(): string {
    const pkgPath = path.join(import.meta.dirname, "..", "package.json");
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        return pkg.version || "unknown";
    } catch {
        return "unknown";
    }
}

/** Best-effort scan for secrets using detect-secrets. Returns warning strings. */
function scanForSecrets(filepath: string): string[] {
    const warnings: string[] = [];
    try {
        const output = execFileSync("detect-secrets", ["scan", filepath], {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            maxBuffer: 50 * 1024 * 1024,
        });
        let result: { results?: Record<string, Array<{ type: string; line_number: number }>> };
        try {
            result = JSON.parse(output);
        } catch {
            return warnings;
        }
        const fileResults = result.results?.[filepath];
        if (fileResults && fileResults.length > 0) {
            for (const finding of fileResults) {
                warnings.push(`Potential secret (${finding.type}) at line ${finding.line_number}`);
            }
        }
    } catch {
        // detect-secrets not installed or failed - skip silently
    }
    return warnings;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Export a session as a portable .tar.gz archive. */
export async function exportSession(options: ExportOptions): Promise<ExportResult> {
    const { sessionId, projectPath, includeSubagents = false } = options;

    // Locate the session file
    const { filepath, projectPath: resolvedProjectPath } = findSessionFile(sessionId, projectPath);

    // Get session metadata
    const sessionInfo = getSessionInfo(sessionId, resolvedProjectPath);

    // Scan for secrets (best-effort)
    const secretsWarnings = scanForSecrets(filepath);

    // Stage files in a temp directory
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-export-"));
    const stageDir = path.join(tmpDir, sessionId);
    fs.mkdirSync(stageDir, { recursive: true });

    try {
        // Copy session file
        fs.copyFileSync(filepath, path.join(stageDir, "session.jsonl"));

        // Optionally include subagent sessions
        let hasSubagents = false;
        if (includeSubagents) {
            const sessionDir = path.join(path.dirname(filepath), sessionId);
            if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) {
                hasSubagents = true;
                const subagentsDir = path.join(stageDir, "subagents");
                fs.mkdirSync(subagentsDir, { recursive: true });
                for (const entry of fs.readdirSync(sessionDir)) {
                    const src = path.join(sessionDir, entry);
                    if (fs.statSync(src).isFile()) {
                        fs.copyFileSync(src, path.join(subagentsDir, entry));
                    }
                }
            }
        }

        // Build manifest
        const manifest: Manifest = {
            version: 1,
            exportedAt: new Date().toISOString(),
            claudeToolsVersion: getPackageVersion(),
            sessionId,
            originalProjectPath: resolvedProjectPath,
            includesSubagents: hasSubagents,
            secretsWarnings,
            sessionInfo,
        };

        // Write manifest
        fs.writeFileSync(path.join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2));

        // Determine output path
        const outputPath = options.outputPath || path.join(process.cwd(), `${sessionId}.tar.gz`);

        // Create tar.gz archive
        execFileSync("tar", ["czf", outputPath, "-C", tmpDir, sessionId], {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });

        const archiveSize = fs.statSync(outputPath).size;

        return {
            archivePath: outputPath,
            sessionInfo,
            secretsWarnings,
            includesSubagents: hasSubagents,
            archiveSize,
        };
    } finally {
        // Clean up temp dir
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Import a session from a portable .tar.gz archive. */
export async function importSession(options: ImportOptions): Promise<ImportResult> {
    requireProjectsDir();

    const { archivePath } = options;

    // Extract tar.gz to temp dir
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-import-"));

    try {
        execFileSync("tar", ["xzf", archivePath, "-C", tmpDir], {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });

        // Find the single top-level directory inside the extracted archive
        const entries = fs.readdirSync(tmpDir).filter((e) => {
            return fs.statSync(path.join(tmpDir, e)).isDirectory();
        });
        if (entries.length !== 1) {
            throw new Error("Invalid archive: expected exactly one top-level directory");
        }
        const stageDir = path.join(tmpDir, entries[0]);

        // Read and validate manifest
        const manifestPath = path.join(stageDir, "manifest.json");
        if (!fs.existsSync(manifestPath)) {
            throw new Error("Invalid archive: missing manifest.json");
        }

        let manifest: Manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        } catch {
            throw new Error("Invalid archive: malformed manifest.json");
        }

        if (manifest.version !== 1) {
            throw new Error(`Unsupported manifest version: ${manifest.version}`);
        }
        if (!manifest.sessionId || !manifest.originalProjectPath) {
            throw new Error("Invalid archive: missing sessionId or originalProjectPath in manifest");
        }

        const sessionJsonlPath = path.join(stageDir, "session.jsonl");
        if (!fs.existsSync(sessionJsonlPath)) {
            throw new Error("Invalid archive: missing session.jsonl");
        }

        // Determine target path
        const targetPath = options.projectPath || manifest.originalProjectPath;

        // Compute encoded dir
        const encodedDir = pathToDirname(targetPath);
        const projectDir = path.join(PROJECTS_DIR, encodedDir);

        // Conflict check
        const targetSessionFile = path.join(projectDir, `${manifest.sessionId}.jsonl`);
        if (fs.existsSync(targetSessionFile)) {
            throw new Error(`Session ${manifest.sessionId} already exists at ${targetPath}`);
        }

        // Ensure project dir exists
        if (!fs.existsSync(projectDir)) {
            fs.mkdirSync(projectDir, { recursive: true });
            fs.writeFileSync(path.join(projectDir, "sessions-index.json"), JSON.stringify({}, null, 2));
        }

        // Copy session.jsonl to the target
        fs.copyFileSync(sessionJsonlPath, targetSessionFile);

        // Copy subagents/ to companion dir if present
        const subagentsDir = path.join(stageDir, "subagents");
        const hasSubagents = fs.existsSync(subagentsDir) && fs.statSync(subagentsDir).isDirectory();
        if (hasSubagents) {
            const companionDir = path.join(projectDir, manifest.sessionId);
            fs.mkdirSync(companionDir, { recursive: true });
            for (const entry of fs.readdirSync(subagentsDir)) {
                const src = path.join(subagentsDir, entry);
                if (fs.statSync(src).isFile()) {
                    fs.copyFileSync(src, path.join(companionDir, entry));
                }
            }
        }

        // If target path != original path, rewrite all occurrences of the original path
        let pathsRewritten = false;
        if (targetPath !== manifest.originalProjectPath) {
            const content = fs.readFileSync(targetSessionFile, "utf-8");
            const escaped = manifest.originalProjectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const regex = new RegExp(escaped, "g");
            const rewritten = content.replace(regex, targetPath);
            if (rewritten !== content) {
                fs.writeFileSync(targetSessionFile, rewritten);
                pathsRewritten = true;
            }
        }

        return {
            sessionId: manifest.sessionId,
            projectPath: targetPath,
            sessionInfo: manifest.sessionInfo,
            includesSubagents: hasSubagents,
            pathsRewritten,
        };
    } finally {
        // Clean up temp dir
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}
