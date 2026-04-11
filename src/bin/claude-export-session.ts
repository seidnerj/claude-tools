#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// CLI: Export a Claude Code session as a portable .tar.gz archive
//
// Usage:
//   claude-export-session <session-id> [options]
// ---------------------------------------------------------------------------

import * as path from "node:path";
import { exportSession } from "../share-session.js";

function printUsage(): void {
    console.log("Usage: claude-export-session <session-id> [options]");
    console.log("");
    console.log("Options:");
    console.log("  -p, --project <path>    Project path (searches all projects if omitted)");
    console.log("  -o, --output <path>     Output file path (default: ./{sessionId}.tar.gz)");
    console.log("  --include-subagents     Include subagent sessions (default: false)");
    console.log("  -h, --help              Show this help");
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(1)} MB`;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.includes("--help") || args.includes("-h")) {
        printUsage();
        process.exit(0);
    }

    let sessionId = "";
    let projectPath: string | undefined;
    let outputPath: string | undefined;
    let includeSubagents = false;

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
        } else if (arg === "-o" || arg === "--output") {
            i++;
            if (i >= args.length) {
                console.error("--output requires a value");
                process.exit(1);
            }
            outputPath = path.resolve(args[i]);
        } else if (arg === "--include-subagents") {
            includeSubagents = true;
        } else if (!arg.startsWith("-")) {
            if (!sessionId) {
                sessionId = arg;
            }
        }
        i++;
    }

    if (!sessionId) {
        printUsage();
        process.exit(1);
    }

    const result = await exportSession({
        sessionId,
        projectPath,
        outputPath,
        includeSubagents,
    });

    const info = result.sessionInfo;
    console.log(`Session:      ${info.sessionId}`);
    console.log(`Description:  ${info.names.description || "(untitled)"}`);
    console.log(`Project:      ${info.projectPath}`);
    console.log(`Messages:     ${info.msgCount}`);
    console.log(`Cost:         $${info.totalCost.toFixed(4)}`);
    console.log(`Created:      ${info.created}`);
    console.log(`Modified:     ${info.modified}`);
    if (result.includesSubagents) {
        console.log(`Subagents:    included`);
    }
    console.log("");
    console.log(`Archive:      ${result.archivePath}`);
    console.log(`Size:         ${formatBytes(result.archiveSize)}`);

    if (result.secretsWarnings.length > 0) {
        console.log("");
        console.log("Secrets warnings:");
        for (const w of result.secretsWarnings) {
            console.log(`  - ${w}`);
        }
    }
}

main().catch((err) => {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
});
