#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// CLI: Copy Claude Code project history to another path (keeping original)
//
// Usage:
//   claude-copy-history                            # interactive (run from destination directory)
//   claude-copy-history <source-path> <dest-path>  # direct
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { copyHistory } from "../set-history.js";
import { requireProjectsDir, listProjectDirs, listSessions, sessionDescription, pathToDirname, dirnameToPath, PROJECTS_DIR } from "../utils.js";

function printUsage(): void {
    console.log("Usage:");
    console.log("  claude-copy-history                            # interactive (run from destination directory)");
    console.log("  claude-copy-history <source-path> <dest-path>  # direct");
}

function printSessions(projectDir: string): void {
    const sessions = listSessions(projectDir);
    if (sessions.length === 0) {
        console.log("    (no sessions)");
        return;
    }
    for (const s of sessions) {
        const desc = sessionDescription(s) || "(untitled)";
        console.log(`    ${desc} (${s.msgCount} msgs, ${s.created.slice(0, 10)} -> ${s.modified.slice(0, 10)})`);
    }
}

async function main(): Promise<void> {
    requireProjectsDir();

    const args = process.argv.slice(2);

    if (args.includes("--help") || args.includes("-h")) {
        printUsage();
        process.exit(0);
    }

    let sourcePath: string;
    let destPath: string;

    if (args.length === 0) {
        // Interactive mode
        const targetPath = process.cwd();
        const targetDirName = pathToDirname(targetPath);
        const targetProjectDir = path.join(PROJECTS_DIR, targetDirName);

        console.log("claude-copy-history - Copy Claude conversation history to this directory");
        console.log();
        console.log(`Current directory: ${targetPath}`);
        console.log();

        if (fs.existsSync(targetProjectDir) && fs.statSync(targetProjectDir).isDirectory()) {
            console.log("This directory already has Claude history:");
            printSessions(targetProjectDir);
            console.log();
        } else {
            console.log("This directory has no Claude history yet.");
            console.log();
        }

        console.log("All project histories:");
        console.log();

        const candidates: string[] = [];
        let idx = 0;

        for (const pd of listProjectDirs()) {
            if (pd.dirName === targetDirName) continue;

            idx++;
            candidates.push(pd.dirName);

            const exists = fs.existsSync(pd.decodedPath) && fs.statSync(pd.decodedPath).isDirectory();
            if (exists) {
                console.log(`     ${idx}) ${pd.decodedPath}`);
            } else {
                console.log(`  *  ${idx}) ${pd.decodedPath}`);
            }
            printSessions(pd.fullPath);
            console.log();
        }

        if (idx === 0) {
            console.log("  (no other project histories found)");
            process.exit(0);
        }

        console.log("---");
        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

        const choice = await ask("Copy which project's history to this directory? (#, or 'q' to quit): ");
        rl.close();

        if (choice.toLowerCase() === "q") {
            console.log("Cancelled.");
            process.exit(0);
        }

        const choiceIdx = parseInt(choice, 10);
        if (isNaN(choiceIdx) || choiceIdx < 1 || choiceIdx > candidates.length) {
            console.log("Invalid choice.");
            process.exit(1);
        }

        const selectedDirName = candidates[choiceIdx - 1];
        sourcePath = dirnameToPath(selectedDirName);
        destPath = targetPath;
    } else if (args.length === 2) {
        sourcePath = path.resolve(args[0]);
        destPath = path.resolve(args[1]);
    } else {
        printUsage();
        process.exit(1);
        return; // unreachable, for type narrowing
    }

    console.log();
    console.log(`Copying history: ${sourcePath} -> ${destPath}`);

    const result = await copyHistory(sourcePath, destPath);

    console.log();
    console.log(`Session files updated: ${result.sessionFilesUpdated}`);
    console.log(`Sessions index updated: ${result.sessionsIndexUpdated}`);
    console.log(`History file updated: ${result.historyFileUpdated}`);
    if (result.brokenArtifactsCleaned > 0) {
        console.log(`Broken resume artifacts cleaned: ${result.brokenArtifactsCleaned}`);
    }
    console.log("Done.");
}

main().catch((err) => {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
});
