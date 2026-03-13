// ---------------------------------------------------------------------------
// Scan Claude Code conversation history for secrets and optionally redact
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { SecretFinding, ScanResult } from "./types.js";
import { PROJECTS_DIR, extractStrings, listProjectDirs, pathToDirname, requireProjectsDir } from "./utils.js";

const REDACT_MARKER = "***REDACTED***";

// Pre-filter regex: only scan lines that might contain secrets.
const HINT_RE =
    /(?:password|passwd|pwd|secret|token|api.?key|apikey|auth.?token|bearer|basic\s|private.key|BEGIN\s.*KEY|credential|access.key|session.id|connection.string|sk-ant-|sk-proj-|sk-[a-z]|ghp_|gho_|github_pat_|glpat-|xox[bporas]-|hooks\.slack\.com|AKIA[A-Z0-9]|AIza[A-Za-z0-9]|[rs]k_(?:live|test)_|SG\.[A-Za-z]|npm_[A-Za-z0-9]|pypi-[A-Za-z0-9]|dckr_pat_|lin_api_|eyJ[A-Za-z0-9].*\.eyJ[A-Za-z0-9]|_KEY\s*=|_SECRET\s*=|_TOKEN\s*=|_PASSWORD\s*=)/i;

function redact(value: string): string {
    if (value.length <= 12) return value.slice(0, 3) + REDACT_MARKER;
    const prefixLen = Math.min(8, Math.floor(value.length / 4));
    const suffixLen = Math.min(4, Math.floor(value.length / 6));
    return value.slice(0, prefixLen) + REDACT_MARKER + value.slice(-suffixLen);
}

/** Check if detect-secrets is available. Throws if not installed. */
export function requireDetectSecrets(): void {
    try {
        execFileSync("detect-secrets", ["--version"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch {
        throw new Error("detect-secrets is not installed. Install it with: pip install detect-secrets");
    }
}

function runDetectSecrets(filepath: string): Array<{ type: string; line_number: number; secret: string }> {
    let output: string;
    try {
        output = execFileSync("detect-secrets", ["scan", "--list-all-plugins", filepath], {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            maxBuffer: 50 * 1024 * 1024,
        });
    } catch {
        // detect-secrets scan returns non-zero if it finds secrets; parse stdout anyway
        return [];
    }

    let result: { results?: Record<string, Array<{ type: string; line_number: number; hashed_secret: string }>> };
    try {
        result = JSON.parse(output);
    } catch {
        return [];
    }

    // detect-secrets returns hashed secrets, not raw values. We need to extract from the file.
    const findings: Array<{ type: string; line_number: number; secret: string }> = [];
    const fileResults = result.results?.[filepath];
    if (!fileResults) return findings;

    const lines = fs.readFileSync(filepath, "utf-8").split("\n");
    for (const finding of fileResults) {
        const line = lines[finding.line_number - 1];
        if (line) {
            findings.push({ type: finding.type, line_number: finding.line_number, secret: line.trim() });
        }
    }
    return findings;
}

function isFalsePositive(secretVal: string): boolean {
    if (!secretVal || secretVal.length < 8) return true;
    if (secretVal.includes(REDACT_MARKER)) return true;

    const svLower = secretVal.toLowerCase();

    const FALSE_POSITIVES = new Set([
        "password",
        "changeme",
        "xxxxxxxx",
        "xxxxxxxxxxxxxxxx",
        "sk-ant-xxx",
        "sk-ant-xxxxxxxxxxxxxxxxxxxx",
        "your-api-key-here",
        "your_api_key_here",
        "placeholder",
        "example",
        "12345678",
    ]);
    if (FALSE_POSITIVES.has(svLower)) return true;

    const stripped = svLower.replace(/[-_]/g, "");
    if (stripped.length > 0 && new Set(stripped).size <= 2) return true;

    if (/^(?:test|mock|fake|dummy|example|sample|demo|foo|bar|baz|my|temp|tmp)[-_.]/.test(svLower)) return true;
    if (/^(?:toolu_|msg_|req_|chatcmpl-|run_)/.test(svLower)) return true;

    return false;
}

/** Scan a single project directory for secrets.
 *
 * @param dryRun If true, reports findings without redacting.
 */
export function scanProject(projectDir: string, projectName: string, dryRun = true): ScanResult {
    requireDetectSecrets();
    requireProjectsDir();

    const findings: SecretFinding[] = [];

    for (const fname of fs.readdirSync(projectDir).sort()) {
        if (!fname.endsWith(".jsonl")) continue;
        const filepath = path.join(projectDir, fname);

        const rawLines = fs.readFileSync(filepath, "utf-8").split("\n");

        // Build combined temp file with hint-filtered lines + mapping
        const tmpLines: string[] = [];
        const lineMap = new Map<number, number>(); // tmpLineNum (1-based) -> jsonlLineNum (1-based)

        for (let jsonlIdx = 0; jsonlIdx < rawLines.length; jsonlIdx++) {
            const raw = rawLines[jsonlIdx].trim();
            if (!raw) continue;

            let entry: unknown;
            try {
                entry = JSON.parse(raw);
            } catch {
                continue;
            }

            for (const text of extractStrings(entry)) {
                for (const subline of text.split("\n")) {
                    const trimmed = subline.trim();
                    if (!trimmed || !HINT_RE.test(trimmed)) continue;
                    const tmpLineNum = tmpLines.length + 1;
                    tmpLines.push(trimmed);
                    lineMap.set(tmpLineNum, jsonlIdx + 1);
                }
            }
        }

        if (tmpLines.length === 0) continue;

        // Write temp file and scan with detect-secrets
        const tmpPath = path.join(os.tmpdir(), `claude-tools-scan-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
        fs.writeFileSync(tmpPath, tmpLines.join("\n") + "\n");

        try {
            const secrets = runDetectSecrets(tmpPath);
            for (const secret of secrets) {
                if (isFalsePositive(secret.secret)) continue;
                const jsonlLn = lineMap.get(secret.line_number);
                if (jsonlLn === undefined) continue;

                const rawLine = rawLines[jsonlLn - 1];
                const secretVal = secret.secret;
                const escaped = secretVal.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                if (!rawLine.includes(secretVal) && !rawLine.includes(escaped)) continue;

                findings.push({
                    filepath,
                    lineNumber: jsonlLn,
                    secretType: secret.type,
                    secretValue: secretVal,
                    redactedValue: redact(secretVal),
                });
            }
        } finally {
            try {
                fs.unlinkSync(tmpPath);
            } catch {
                // ignore cleanup errors
            }
        }
    }

    // Deduplicate
    const seen = new Set<string>();
    const unique = findings.filter((f) => {
        const key = `${f.filepath}:${f.lineNumber}:${f.secretValue}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    if (dryRun || unique.length === 0) {
        return { projectName, findings: unique };
    }

    // Group by file for redaction
    const byFile = new Map<string, Array<{ lineNumber: number; secretValue: string; redactedValue: string }>>();
    for (const f of unique) {
        const items = byFile.get(f.filepath) || [];
        items.push({ lineNumber: f.lineNumber, secretValue: f.secretValue, redactedValue: f.redactedValue });
        byFile.set(f.filepath, items);
    }

    // Backup
    const backupRoot = path.join(os.homedir(), ".claude-history-backups");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    const backupDir = path.join(backupRoot, timestamp);
    fs.mkdirSync(backupDir, { recursive: true });

    for (const filepath of byFile.keys()) {
        const rel = path.relative(path.join(os.homedir(), ".claude", "projects"), filepath);
        const dest = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(filepath, dest);
    }

    // Redact
    let redactedCount = 0;
    for (const [filepath, items] of byFile) {
        const lines = fs.readFileSync(filepath, "utf-8").split("\n");
        let modified = false;

        for (const { lineNumber, secretValue, redactedValue } of items) {
            const idx = lineNumber - 1;
            if (idx >= lines.length) continue;

            if (lines[idx].includes(secretValue)) {
                lines[idx] = lines[idx].replace(secretValue, redactedValue);
                redactedCount++;
                modified = true;
            } else {
                const escaped = secretValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                const escapedRedacted = redactedValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                if (lines[idx].includes(escaped)) {
                    lines[idx] = lines[idx].replace(escaped, escapedRedacted);
                    redactedCount++;
                    modified = true;
                }
            }
        }

        if (modified) {
            const stat = fs.statSync(filepath);
            fs.writeFileSync(filepath, lines.join("\n"));
            fs.utimesSync(filepath, stat.atime, stat.mtime);
        }
    }

    return { projectName, findings: unique, backupDir, redactedCount };
}

/** Scan all projects for secrets. */
export function scanAllProjects(dryRun = true): ScanResult[] {
    requireDetectSecrets();
    requireProjectsDir();
    return listProjectDirs().map((pd) => scanProject(pd.fullPath, pd.decodedPath, dryRun));
}

/** Scan a specific project path for secrets. */
export function scanProjectByPath(projectPath: string, dryRun = true): ScanResult {
    requireDetectSecrets();
    requireProjectsDir();
    const resolved = path.resolve(projectPath).replace(/\/+$/, "");
    const dirName = pathToDirname(resolved);
    const projectDir = path.join(PROJECTS_DIR, dirName);

    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
        throw new Error(`No Claude history found for: ${resolved}`);
    }

    return scanProject(projectDir, resolved, dryRun);
}
