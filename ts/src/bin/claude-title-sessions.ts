#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// CLI: Generate AI titles for untitled Claude Code sessions
//
// Usage:
//   claude-title-sessions                  # interactive (pick a project)
//   claude-title-sessions <project-path>   # title specific project
//   claude-title-sessions --all            # title all projects
//   claude-title-sessions --dry-run        # preview only, don't write
//   claude-title-sessions --model <id>     # model (default: haiku)
// ---------------------------------------------------------------------------

import { titleProject, titleAllProjects, titleProjectByPath } from "../title-sessions.js";
import { requireProjectsDir, listProjectDirs } from "../utils.js";
import type { TitleProjectResult } from "../types.js";

function printUsage(): void {
    console.log("Usage:");
    console.log("  claude-title-sessions                  # interactive (pick a project)");
    console.log("  claude-title-sessions <project-path>   # title specific project");
    console.log("  claude-title-sessions --all            # title all projects");
    console.log("  claude-title-sessions --dry-run        # preview only, don't write");
    console.log("  claude-title-sessions --model <id>     # model (default: haiku)");
}

function printResults(results: TitleProjectResult[]): void {
    let totalTitled = 0;
    for (const r of results) {
        if (r.titles.length === 0 && r.skipped === 0) continue;
        console.log(`\nProject: ${r.projectName}`);
        for (const t of r.titles) {
            totalTitled++;
            console.log(`  ${t.sessionId.slice(0, 8)}... -> ${t.title}`);
        }
        if (r.skipped > 0) {
            console.log(`  (${r.skipped} session(s) skipped - no content to title)`);
        }
    }
    if (totalTitled === 0) {
        console.log("No sessions needed titling.");
    } else {
        console.log(`\nTitled ${totalTitled} session(s).`);
    }
}

async function main(): Promise<void> {
    requireProjectsDir();

    let dryRun = false;
    let scanAll = false;
    let targetPath = "";
    let model: string | undefined;

    const args = process.argv.slice(2);
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "--dry-run") {
            dryRun = true;
        } else if (arg === "--all") {
            scanAll = true;
        } else if (arg === "--model") {
            i++;
            if (i >= args.length) {
                console.error("--model requires a value");
                process.exit(1);
            }
            model = args[i];
        } else if (arg === "--help" || arg === "-h") {
            printUsage();
            process.exit(0);
        } else {
            targetPath = arg;
        }
        i++;
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

        const choice = await ask("\nTitle which project's sessions? (#): ");
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
        console.log("(dry-run mode - titles will be shown but not written)\n");
    }

    const options = { model, dryRun };
    let results: TitleProjectResult[];

    if (scanAll) {
        console.log("Titling sessions across all projects...\n");
        results = await titleAllProjects(options);
    } else if (targetPath) {
        results = [await titleProjectByPath(targetPath, options)];
    } else {
        results = [await titleProjectByPath(process.cwd(), options)];
    }

    printResults(results);
}

main().catch((err) => {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
});
