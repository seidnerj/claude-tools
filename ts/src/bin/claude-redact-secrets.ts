#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// CLI: Scan Claude Code conversation history for secrets and optionally redact
//
// Usage:
//   claude-redact-secrets                  # interactive (pick a project)
//   claude-redact-secrets <project-path>   # scan specific project
//   claude-redact-secrets --all            # scan all projects
//   claude-redact-secrets --dry-run        # report only, don't redact
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { scanProject, scanAllProjects, scanProjectByPath } from "../redact-secrets.js";
import { requireProjectsDir, listProjectDirs, pathToDirname, PROJECTS_DIR } from "../utils.js";
import type { ScanResult } from "../types.js";

function printUsage(): void {
    console.log("Usage:");
    console.log("  claude-redact-secrets                  # interactive (pick a project)");
    console.log("  claude-redact-secrets <project-path>   # scan specific project");
    console.log("  claude-redact-secrets --all            # scan all projects");
    console.log("  claude-redact-secrets --dry-run        # report only, don't redact");
}

function printResults(results: ScanResult[]): void {
    let totalFindings = 0;
    for (const r of results) {
        if (r.findings.length === 0) continue;
        console.log(`\nProject: ${r.projectName}`);
        for (const f of r.findings) {
            totalFindings++;
            console.log(`  [${f.secretType}] line ${f.lineNumber}: ${f.redactedValue}`);
        }
        if (r.backupDir) {
            console.log(`  Backup: ${r.backupDir}`);
        }
        if (r.redactedCount !== undefined && r.redactedCount > 0) {
            console.log(`  Redacted ${r.redactedCount} secret(s).`);
        }
    }
    if (totalFindings === 0) {
        console.log("No secrets found.");
    } else {
        console.log(`\nTotal: ${totalFindings} finding(s).`);
    }
}

async function main(): Promise<void> {
    requireProjectsDir();

    let dryRun = false;
    let scanAll = false;
    let targetPath = "";

    for (const arg of process.argv.slice(2)) {
        if (arg === "--dry-run") {
            dryRun = true;
        } else if (arg === "--all") {
            scanAll = true;
        } else if (arg === "--help" || arg === "-h") {
            printUsage();
            process.exit(0);
        } else {
            targetPath = arg;
        }
    }

    // Interactive mode
    if (!scanAll && !targetPath) {
        const dirs = listProjectDirs();
        console.log("Projects:");
        console.log("  0) All projects");
        for (let j = 0; j < dirs.length; j++) {
            console.log(`  ${j + 1}) ${dirs[j].decodedPath}`);
        }

        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

        const choice = await ask("\nScan which project? (#): ");
        const idx = parseInt(choice, 10);
        if (idx === 0 || isNaN(idx)) {
            scanAll = true;
        } else if (idx >= 1 && idx <= dirs.length) {
            targetPath = dirs[idx - 1].decodedPath;
        } else {
            console.log("Invalid choice.");
            rl.close();
            process.exit(1);
        }
        rl.close();
    }

    if (dryRun) {
        console.log("(dry-run mode - secrets will be reported but not redacted)\n");
    }

    let results: ScanResult[];
    if (scanAll) {
        console.log("Scanning all projects for secrets...\n");
        results = scanAllProjects(dryRun);
    } else if (targetPath) {
        results = [scanProjectByPath(targetPath, dryRun)];
    } else {
        results = [scanProjectByPath(process.cwd(), dryRun)];
    }

    printResults(results);
}

main().catch((err) => {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
});
