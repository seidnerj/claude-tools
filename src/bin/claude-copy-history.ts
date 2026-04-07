#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// CLI: Copy Claude Code project history to another path (keeping original)
//
// Usage:
//   claude-copy-history                                          # interactive
//   claude-copy-history <source-path> <dest-path>                # copy all sessions
//   claude-copy-history -s <uuid> [-s <uuid>] <source> <dest>   # copy specific sessions
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { copyHistory } from "../set-history.js";
import { requireProjectsDir, listProjectDirs, listSessions, sessionDescription, pathToDirname, dirnameToPath, PROJECTS_DIR } from "../utils.js";

function printUsage(): void {
    console.log("Usage:");
    console.log("  claude-copy-history                                          # interactive");
    console.log("  claude-copy-history <source-path> <dest-path>                # copy all sessions");
    console.log("  claude-copy-history -s <uuid> [-s <uuid>] <source> <dest>   # copy specific sessions");
}

function printSessions(projectDir: string): void {
    const sessions = listSessions(projectDir);
    if (sessions.length === 0) {
        console.log("    (no sessions)");
        return;
    }
    for (const s of sessions) {
        const desc = sessionDescription(s) || "(untitled)";
        console.log(`    ${s.sessionId.slice(0, 8)}  ${desc} (${s.msgCount} msgs, ${s.created.slice(0, 10)} -> ${s.modified.slice(0, 10)})`);
    }
}

function parseArgs(argv: string[]): { sessionIds: string[]; positional: string[] } {
    const sessionIds: string[] = [];
    const positional: string[] = [];
    let i = 0;
    while (i < argv.length) {
        if (argv[i] === "-s" || argv[i] === "--session") {
            i++;
            if (i < argv.length) {
                sessionIds.push(argv[i]);
            }
        } else if (!argv[i].startsWith("-")) {
            positional.push(argv[i]);
        }
        i++;
    }
    return { sessionIds, positional };
}

async function pickSessions(projectDir: string, ask: (q: string) => Promise<string>): Promise<string[] | undefined> {
    const sessions = listSessions(projectDir);
    if (sessions.length === 0) return undefined;

    console.log();
    console.log("Sessions in this project:");
    for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const desc = sessionDescription(s) || "(untitled)";
        console.log(`  ${i + 1}) ${s.sessionId.slice(0, 8)}  ${desc} (${s.msgCount} msgs)`);
    }
    console.log();

    const answer = await ask("Copy which sessions? (comma-separated #s, or 'a' for all): ");
    if (answer.toLowerCase() === "a" || answer.trim() === "") return undefined;

    const indices = answer.split(",").map((s) => parseInt(s.trim(), 10));
    const picked: string[] = [];
    for (const idx of indices) {
        if (isNaN(idx) || idx < 1 || idx > sessions.length) {
            console.log(`Invalid choice: ${idx}`);
            process.exit(1);
        }
        picked.push(sessions[idx - 1].sessionId);
    }
    return picked.length > 0 ? picked : undefined;
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
    let sessionIds: string[] | undefined;

    const parsed = parseArgs(args);

    if (parsed.positional.length === 0 && parsed.sessionIds.length === 0) {
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

        if (choice.toLowerCase() === "q") {
            rl.close();
            console.log("Cancelled.");
            process.exit(0);
        }

        const choiceIdx = parseInt(choice, 10);
        if (isNaN(choiceIdx) || choiceIdx < 1 || choiceIdx > candidates.length) {
            rl.close();
            console.log("Invalid choice.");
            process.exit(1);
        }

        const selectedDirName = candidates[choiceIdx - 1];
        sourcePath = dirnameToPath(selectedDirName);
        destPath = targetPath;

        const selectedProjectDir = path.join(PROJECTS_DIR, selectedDirName);
        sessionIds = await pickSessions(selectedProjectDir, ask);
        rl.close();
    } else if (parsed.positional.length === 2) {
        sourcePath = path.resolve(parsed.positional[0]);
        destPath = path.resolve(parsed.positional[1]);
        sessionIds = parsed.sessionIds.length > 0 ? parsed.sessionIds : undefined;
    } else {
        printUsage();
        process.exit(1);
        return; // unreachable, for type narrowing
    }

    console.log();
    if (sessionIds) {
        console.log(`Copying ${sessionIds.length} session(s): ${sourcePath} -> ${destPath}`);
    } else {
        console.log(`Copying all sessions: ${sourcePath} -> ${destPath}`);
    }

    const result = await copyHistory(sourcePath, destPath, sessionIds);

    console.log();
    console.log(`Session files updated: ${result.sessionFilesUpdated}`);
    if (result.sessionIds) {
        console.log(`Sessions copied: ${result.sessionIds.length}`);
    }
    if (result.sessionsNotFound && result.sessionsNotFound.length > 0) {
        console.log(`Sessions not found: ${result.sessionsNotFound.join(", ")}`);
    }
    if (!sessionIds) {
        console.log(`Sessions index updated: ${result.sessionsIndexUpdated}`);
        console.log(`History file updated: ${result.historyFileUpdated}`);
    }
    if (result.brokenArtifactsCleaned > 0) {
        console.log(`Broken resume artifacts cleaned: ${result.brokenArtifactsCleaned}`);
    }
    console.log("Done.");
}

main().catch((err) => {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
});
