#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// CLI: Search Claude Code conversation history by text or LLM
//
// Usage:
//   claude-find-session "text" --all                 # search all projects
//   claude-find-session "text" <project-path>        # search specific project
//   claude-find-session "text" --all -cs             # case-sensitive
//   claude-find-session "query" --llm --all          # LLM semantic search
//   claude-find-session                              # interactive
// ---------------------------------------------------------------------------

import { searchAllProjects, searchProjectByPath, llmSearchAll, llmSearchByPath } from "../find-session.js";
import { requireProjectsDir, listProjectDirs } from "../utils.js";
import type { ProjectSearchResult } from "../types.js";

function printUsage(): void {
    console.log("Usage:");
    console.log("");
    console.log("  Text search (default):");
    console.log('    claude-find-session "text" --all                 # search all projects');
    console.log('    claude-find-session "text" <project-path>        # search specific project');
    console.log('    claude-find-session "text" --all -cs             # case-sensitive');
    console.log("");
    console.log("  LLM search (natural language queries):");
    console.log('    claude-find-session "which session fixed login?" --llm --all');
    console.log('    claude-find-session "where did we set up CI?" --llm <project-path>');
    console.log("");
    console.log("  Interactive (prompts for everything):");
    console.log("    claude-find-session");
    console.log("    claude-find-session --llm");
    console.log("");
    console.log("Flags:");
    console.log("  --llm                     Use LLM to match sessions by meaning");
    console.log("  --model <id>              Model for LLM mode (default: haiku)");
    console.log("  --case-sensitive, -cs     Case-sensitive text matching");
    console.log("  --case-insensitive, -ci   Case-insensitive text matching (default)");
    console.log("  --all                     Search all projects");
}

function printResults(results: ProjectSearchResult[]): void {
    let totalMatches = 0;
    for (const r of results) {
        if (r.matches.length === 0) continue;
        console.log(`\nProject: ${r.projectName}`);
        for (const m of r.matches) {
            totalMatches++;
            console.log(`  ${m.description || "(untitled)"} (${m.matchCount} matches, ${m.created} -> ${m.modified}, ${m.msgCount} msgs)`);
            for (const s of m.snippets) {
                console.log(`    > ${s}`);
            }
        }
    }
    if (totalMatches === 0) {
        console.log("No matches found.");
    }
}

async function main(): Promise<void> {
    requireProjectsDir();

    let caseSensitive = false;
    let scanAll = false;
    let useLlm = false;
    let targetPath = "";
    let searchText = "";
    let model: string | undefined;

    const args = process.argv.slice(2);
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "--case-sensitive" || arg === "-cs") {
            caseSensitive = true;
        } else if (arg === "--case-insensitive" || arg === "-ci") {
            caseSensitive = false;
        } else if (arg === "--all") {
            scanAll = true;
        } else if (arg === "--llm") {
            useLlm = true;
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
        } else if (!searchText) {
            searchText = arg;
        } else if (!targetPath) {
            targetPath = arg;
        }
        i++;
    }

    // Interactive mode if no search text given
    if (!searchText) {
        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

        searchText = await ask(useLlm ? "LLM query: " : "Search text: ");
        if (!searchText.trim()) {
            console.log("No search text provided.");
            rl.close();
            process.exit(1);
        }

        if (!scanAll && !targetPath) {
            const dirs = listProjectDirs();
            console.log("\nProjects:");
            console.log("  0) All projects");
            for (let j = 0; j < dirs.length; j++) {
                console.log(`  ${j + 1}) ${dirs[j].decodedPath}`);
            }
            const choice = await ask("\nSearch which project? (#): ");
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
        }

        rl.close();
    }

    searchText = searchText.trim();

    if (useLlm) {
        let result;
        if (scanAll) {
            result = await llmSearchAll(searchText, undefined, model);
        } else if (targetPath) {
            result = await llmSearchByPath(targetPath, searchText, undefined, model);
        } else {
            result = await llmSearchByPath(process.cwd(), searchText, undefined, model);
        }
        console.log(result.analysis);
        if (result.hitCount > 0) {
            console.log(`\n(${result.hitCount} session(s) had keyword matches)`);
        }
    } else {
        let results: ProjectSearchResult[];
        if (scanAll) {
            results = searchAllProjects(searchText, caseSensitive);
        } else if (targetPath) {
            results = [searchProjectByPath(targetPath, searchText, caseSensitive)];
        } else {
            results = [searchProjectByPath(process.cwd(), searchText, caseSensitive)];
        }
        printResults(results);
    }
}

main().catch((err) => {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
});
