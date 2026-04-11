#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// CLI: Import a Claude Code session from a portable .tar.gz archive
//
// Usage:
//   claude-import-session <archive-path> [options]
// ---------------------------------------------------------------------------

import * as path from "node:path";
import { importSession } from "../share-session.js";

function printUsage(): void {
    console.log("Usage: claude-import-session <archive-path> [options]");
    console.log("");
    console.log("Options:");
    console.log("  -p, --project <path>    Target project path (overrides original from manifest)");
    console.log("  -h, --help              Show this help");
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.includes("--help") || args.includes("-h")) {
        printUsage();
        process.exit(0);
    }

    let archivePath = "";
    let projectPath: string | undefined;

    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "-p" || arg === "--project") {
            i++;
            if (i >= args.length) {
                console.error("--project requires a value");
                process.exit(1);
            }
            projectPath = path.resolve(args[i]);
        } else if (!arg.startsWith("-")) {
            if (!archivePath) {
                archivePath = path.resolve(arg);
            }
        }
        i++;
    }

    if (!archivePath) {
        printUsage();
        process.exit(1);
    }

    const result = await importSession({
        archivePath,
        projectPath,
    });

    const info = result.sessionInfo;
    console.log(`Session:      ${result.sessionId}`);
    console.log(`Description:  ${info.names.description || "(untitled)"}`);
    console.log(`Project:      ${result.projectPath}`);
    console.log(`Messages:     ${info.msgCount}`);
    console.log(`Cost:         $${info.totalCost.toFixed(4)}`);
    console.log(`Created:      ${info.created}`);
    console.log(`Modified:     ${info.modified}`);
    if (result.includesSubagents) {
        console.log(`Subagents:    included`);
    }
    if (result.pathsRewritten) {
        console.log(`Paths:        rewritten to match target project`);
    }
    console.log("");
    console.log(`Resume it with: cd ${result.projectPath} && claude --resume ${result.sessionId}`);
}

main().catch((err) => {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
});
