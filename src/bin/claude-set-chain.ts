#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// CLI: Manage per-directory inference chain assignments.
//
// Chains are JSON files at ~/.claude-tools/chains/<id>.json (one per chain).
// Per-directory assignments live in ~/.claude-tools/directories.json
// (maps base64(directory) -> chain-id).
//
// When direnv enters a directory with an assignment, the central envrc
// (~/.claude-tools/envrc.sh) exports _CLAUDE_INFERENCE_CONFIG to the chain's
// JSON path so a compatible Claude Code build picks it up.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { listChains, listChainIds, readChain, writeChain, deleteChain, chainExists, chainPath, type ChainConfig } from "../auth/chains.js";
import { getDirectoryChain, setDirectoryChain, unsetDirectoryChain, listDirectoryAssignments, directoriesUsingChain } from "../auth/directories.js";
import { ensureEnvrc } from "../auth/envrc.js";

function printUsage(): void {
    console.log("Usage:");
    console.log("  claude-set-chain list                   # list all chains");
    console.log("  claude-set-chain show <id>              # print chain JSON");
    console.log("  claude-set-chain create <id> [name]     # create skeleton chain, open in $EDITOR");
    console.log("  claude-set-chain edit <id>              # open chain in $EDITOR");
    console.log("  claude-set-chain delete <id>            # delete chain (must be unassigned)");
    console.log("  claude-set-chain assign <id> [dir]      # assign chain to directory (defaults to cwd)");
    console.log("  claude-set-chain unassign [dir]         # remove directory assignment");
    console.log("  claude-set-chain which [dir]            # show active chain for directory");
    console.log("  claude-set-chain ls-dirs                # list all directory assignments");
    console.log();
    console.log("Chain JSON shape:");
    console.log('  { "id", "name", "accounts": { ... }, "chain": [ { provider, account, model, ... } ] }');
}

function dieIf(cond: boolean, msg: string): void {
    if (cond) {
        console.error(msg);
        process.exit(1);
    }
}

function openEditor(filePath: string): void {
    const editor = process.env.EDITOR ?? "vi";
    const result = spawnSync(editor, [filePath], { stdio: "inherit" });
    if (result.status !== 0) {
        console.error(`Editor exited with status ${result.status}`);
        process.exit(1);
    }
}

function cmdList(): void {
    const chains = listChains();
    if (chains.length === 0) {
        console.log("No chains. Create one with: claude-set-chain create <id>");
        return;
    }
    const inUse = new Map<string, number>();
    for (const a of listDirectoryAssignments()) {
        inUse.set(a.chainId, (inUse.get(a.chainId) ?? 0) + 1);
    }
    for (const c of chains) {
        const tiers = c.chain.length;
        const tierLabels = c.chain.map((t) => t.provider).join(" -> ");
        const usage = inUse.get(c.id) ?? 0;
        console.log(`${c.id}${c.name ? ` (${c.name})` : ""}`);
        console.log(`  tiers: ${tiers} [${tierLabels}]`);
        console.log(`  used by: ${usage} director${usage === 1 ? "y" : "ies"}`);
    }
}

function cmdShow(id: string): void {
    const c = readChain(id);
    dieIf(!c, `No chain "${id}". List with: claude-set-chain list`);
    console.log(fs.readFileSync(chainPath(id), "utf-8"));
}

function cmdCreate(id: string, name?: string): void {
    dieIf(chainExists(id), `Chain "${id}" already exists. Use 'edit' or 'delete'.`);
    const skeleton: ChainConfig = {
        id,
        name: name ?? id,
        accounts: {
            "<account-name>": {
                adminSessionKeys: {
                    api: "<sk-ant-sid... api admin session key>",
                    subscription: "<sk-ant-sid... subscription admin session key>",
                },
            },
        },
        chain: [
            {
                provider: "anthropic-api-key",
                account: "<account-name>",
                model: "claude-sonnet-4-6",
                retry: { waitForReset: false },
                keys: [{ name: "primary", key: "<sk-ant-api03-...>" }],
            },
        ],
    };
    writeChain(skeleton);
    console.log(`Created ${chainPath(id)} - opening in editor.`);
    openEditor(chainPath(id));
    const c = readChain(id);
    dieIf(!c, "Chain JSON is invalid after edit - file kept for repair.");
    console.log(`Saved chain "${id}".`);
}

function cmdEdit(id: string): void {
    dieIf(!chainExists(id), `No chain "${id}". Create with: claude-set-chain create ${id}`);
    openEditor(chainPath(id));
    const c = readChain(id);
    dieIf(!c, "Chain JSON is invalid after edit - file kept for repair.");
    console.log(`Saved chain "${id}".`);
}

function cmdDelete(id: string): void {
    dieIf(!chainExists(id), `No chain "${id}".`);
    const users = directoriesUsingChain(id);
    if (users.length > 0) {
        console.error(`Chain "${id}" is still assigned to ${users.length} director${users.length === 1 ? "y" : "ies"}:`);
        for (const u of users) console.error(`  ${u}`);
        console.error("Unassign first with: claude-set-chain unassign <dir>");
        process.exit(1);
    }
    deleteChain(id);
    console.log(`Deleted chain "${id}".`);
}

function resolveDir(arg: string | undefined): string {
    if (!arg) return process.cwd();
    try {
        return execFileSync("realpath", [arg], { encoding: "utf-8" }).trim();
    } catch {
        return arg;
    }
}

function cmdAssign(id: string, dirArg: string | undefined): void {
    dieIf(!chainExists(id), `No chain "${id}". Create with: claude-set-chain create ${id}`);
    const dir = resolveDir(dirArg);
    setDirectoryChain(dir, id);
    const r = ensureEnvrc(dir);
    const tag = r.created ? "created" : r.appended ? "appended" : "already present";
    console.log(`Assigned chain "${id}" to ${dir}`);
    console.log(`  .envrc: ${tag}`);
    if (r.created || r.appended) {
        console.log(`  Run 'direnv allow ${dir}' to activate.`);
    }
}

function cmdUnassign(dirArg: string | undefined): void {
    const dir = resolveDir(dirArg);
    const removed = unsetDirectoryChain(dir);
    if (removed) console.log(`Unassigned ${dir}`);
    else console.log(`No assignment for ${dir}`);
}

function cmdWhich(dirArg: string | undefined): void {
    const dir = resolveDir(dirArg);
    const id = getDirectoryChain(dir);
    if (!id) {
        console.log(`No chain assigned to ${dir}`);
        return;
    }
    const c = readChain(id);
    if (!c) {
        console.log(`${dir} -> ${id} (MISSING CHAIN FILE)`);
        return;
    }
    console.log(`${dir} -> ${id}${c.name ? ` (${c.name})` : ""}`);
}

function cmdLsDirs(): void {
    const assignments = listDirectoryAssignments();
    if (assignments.length === 0) {
        console.log("No directory assignments.");
        return;
    }
    for (const a of assignments) {
        const missingTag = a.exists ? "" : " *";
        const c = readChain(a.chainId);
        const chainTag = c ? `${a.chainId}${c.name ? ` (${c.name})` : ""}` : `${a.chainId} (MISSING)`;
        console.log(`${a.directory}${missingTag}  ->  ${chainTag}`);
    }
    if (assignments.some((a) => !a.exists)) {
        console.log();
        console.log("* directory no longer exists");
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const cmd = args[0];

    if (!cmd || cmd === "-h" || cmd === "--help") {
        printUsage();
        return;
    }

    switch (cmd) {
        case "list":
            cmdList();
            break;
        case "show":
            dieIf(!args[1], "Usage: claude-set-chain show <id>");
            cmdShow(args[1]);
            break;
        case "create":
            dieIf(!args[1], "Usage: claude-set-chain create <id> [name]");
            cmdCreate(args[1], args[2]);
            break;
        case "edit":
            dieIf(!args[1], "Usage: claude-set-chain edit <id>");
            cmdEdit(args[1]);
            break;
        case "delete":
            dieIf(!args[1], "Usage: claude-set-chain delete <id>");
            cmdDelete(args[1]);
            break;
        case "assign":
            dieIf(!args[1], "Usage: claude-set-chain assign <id> [dir]");
            cmdAssign(args[1], args[2]);
            break;
        case "unassign":
            cmdUnassign(args[1]);
            break;
        case "which":
            cmdWhich(args[1]);
            break;
        case "ls-dirs":
            cmdLsDirs();
            break;
        default:
            console.error(`Unknown command: ${cmd}`);
            printUsage();
            process.exit(1);
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});

const _listIds = listChainIds;
void _listIds;
