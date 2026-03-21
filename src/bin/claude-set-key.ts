#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// CLI: Manage per-directory Anthropic API keys in macOS Keychain
//
// Usage:
//   claude-set-key           # interactive menu
//   claude-set-key --help    # show usage
// ---------------------------------------------------------------------------

import {
    getKey,
    storeKey,
    deleteKey,
    getDefaultKey,
    getKeyName,
    saveKeyName,
    captureDefaultKey,
    pruneOrphanedKeyNames,
    listKeychainEntries,
    listCapturedKeys,
    getCapturedKey,
    ensureEnvrc,
    removeEnvrcSnippet,
} from "../set-key.js";

/** Label for the "Claude Code" default entry, cross-referencing captured slots. */
function getDefaultKeyLabel(): string {
    const key = getDefaultKey();
    if (!key) return "default";
    for (const entry of listCapturedKeys()) {
        if (getCapturedKey(entry.slot) === key) {
            const name = getKeyName(key);
            if (name) return `default (= Key ${entry.slot}: "${name}")`;
            return `default (= Key ${entry.slot})`;
        }
    }
    return "default";
}

type AskFn = (q: string) => Promise<string>;

function printUsage(): void {
    console.log("Usage:");
    console.log("  claude-set-key           # interactive menu");
    console.log("  claude-set-key --help    # show usage");
    console.log();
    console.log("Manages per-directory Anthropic API keys stored in macOS Keychain.");
    console.log("Run from the directory you want to configure.");
}

async function handleSet(ask: AskFn, directory: string, entries: ReturnType<typeof listKeychainEntries>): Promise<void> {
    const sources: Array<{ label: string; action: () => string }> = [];

    sources.push({
        label: "Enter a new API key",
        action: () => "",
    });

    if (entries.hasDefaultKey) {
        sources.push({
            label: `Copy ${getDefaultKeyLabel()}`,
            action: () => getDefaultKey(),
        });
    }

    for (const other of entries.otherKeys) {
        const marker = other.exists ? "" : " *";
        sources.push({
            label: `Copy from ${other.dirPath}${marker} (${other.label})`,
            action: () => {
                const key = getKey(other.dirPath);
                return key;
            },
        });
    }

    let apiKey = "";

    if (sources.length === 1) {
        // Only option is manual entry
        apiKey = await ask("API key: ");
    } else {
        console.log("\nHow would you like to set the key?");
        for (let i = 0; i < sources.length; i++) {
            console.log(`  ${i + 1}) ${sources[i].label}`);
        }
        console.log();

        const choice = await ask("Choice: ");
        const idx = parseInt(choice, 10);
        if (isNaN(idx) || idx < 1 || idx > sources.length) {
            console.log("Invalid choice. Cancelled.");
            return;
        }

        apiKey = sources[idx - 1].action();
        if (!apiKey) {
            apiKey = await ask("API key: ");
        }
    }

    apiKey = apiKey.trim();
    if (!apiKey) {
        console.log("No key provided. Cancelled.");
        return;
    }

    const stored = storeKey(directory, apiKey);
    if (stored) {
        console.log("API key stored successfully.");
    } else {
        console.log("Failed to store API key.");
        process.exit(1);
    }

    // Prompt for optional name
    const existingName = getKeyName(apiKey);
    if (!existingName) {
        const name = await ask("Name this key (optional, Enter to skip): ");
        if (name.trim()) {
            saveKeyName(apiKey, name.trim());
            console.log(`Tagged as "${name.trim()}".`);
        }
    } else {
        console.log(`Key is named "${existingName}".`);
    }
}

async function handleDelete(ask: AskFn, directory: string, entries: ReturnType<typeof listKeychainEntries>): Promise<void> {
    const targets: Array<{ label: string; dir: string }> = [];

    if (entries.currentKey) {
        targets.push({ label: `This directory (${entries.currentKey.label})`, dir: directory });
    }

    for (const other of entries.otherKeys) {
        const marker = other.exists ? "" : " *";
        targets.push({ label: `${other.dirPath}${marker} (${other.label})`, dir: other.dirPath });
    }

    if (targets.length === 0) {
        console.log("No keys to delete.");
        return;
    }

    console.log("\nDelete which key?");
    for (let i = 0; i < targets.length; i++) {
        console.log(`  ${i + 1}) ${targets[i].label}`);
    }
    console.log();

    const choice = await ask("Choice: ");
    const idx = parseInt(choice, 10);
    if (isNaN(idx) || idx < 1 || idx > targets.length) {
        console.log("Invalid choice. Cancelled.");
        return;
    }

    const target = targets[idx - 1];
    const deleted = deleteKey(target.dir);
    if (deleted) {
        console.log("Key deleted.");
        // Remove .envrc snippet if deleting current directory's key
        if (target.dir === directory) {
            const envResult = removeEnvrcSnippet(directory);
            if (envResult.removed) {
                if (envResult.fileDeleted) {
                    console.log("Removed .envrc (was only the keychain lookup).");
                } else {
                    console.log("Removed keychain lookup from .envrc.");
                }
            }
        }
    } else {
        console.log("No key found to delete.");
    }
}

async function handleRename(ask: AskFn, directory: string, entries: ReturnType<typeof listKeychainEntries>): Promise<void> {
    const targets: Array<{ label: string; getKey: () => string }> = [];

    if (entries.currentKey) {
        targets.push({
            label: `This directory (${entries.currentKey.label})`,
            getKey: () => getKey(directory),
        });
    }

    for (const other of entries.otherKeys) {
        const marker = other.exists ? "" : " *";
        targets.push({
            label: `${other.dirPath}${marker} (${other.label})`,
            getKey: () => getKey(other.dirPath),
        });
    }

    for (const entry of listCapturedKeys()) {
        const slot = entry.slot;
        targets.push({
            label: `Key ${slot} (${entry.label})`,
            getKey: () => getCapturedKey(slot),
        });
    }

    if (targets.length === 0) {
        console.log("No keys to name.");
        return;
    }

    console.log("\nName which key?");
    for (let i = 0; i < targets.length; i++) {
        console.log(`  ${i + 1}) ${targets[i].label}`);
    }
    console.log();

    const choice = await ask("Choice: ");
    const idx = parseInt(choice, 10);
    if (isNaN(idx) || idx < 1 || idx > targets.length) {
        console.log("Invalid choice. Cancelled.");
        return;
    }

    const apiKey = targets[idx - 1].getKey();
    if (!apiKey) {
        console.log("Could not retrieve key.");
        return;
    }

    const currentName = getKeyName(apiKey);
    if (currentName) {
        console.log(`Current name: "${currentName}"`);
    }

    const name = await ask("New name (or Enter to clear): ");
    saveKeyName(apiKey, name.trim());
    if (name.trim()) {
        console.log(`Tagged as "${name.trim()}".`);
    } else {
        console.log("Name cleared.");
    }
}

async function handlePrune(): Promise<void> {
    const pruned = pruneOrphanedKeyNames();
    if (pruned === 0) {
        console.log("No orphaned key names found.");
    } else {
        console.log(`Removed ${pruned} orphaned key name${pruned === 1 ? "" : "s"}.`);
    }
}

async function main(): Promise<void> {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        printUsage();
        process.exit(0);
    }

    const directory = process.cwd();

    // Snapshot the current default key into a numbered slot if it's new
    try {
        const slot = captureDefaultKey();
        if (slot !== null) {
            console.log(`New key detected - saved as Key ${slot}.`);
        }
    } catch {
        // No default key present, nothing to capture
    }

    // Ensure .envrc has the current keychain lookup snippet
    try {
        const envrc = ensureEnvrc(directory);
        if (envrc.upgraded) {
            console.log(".envrc keychain lookup upgraded to current version.");
        } else if (envrc.created) {
            console.log("Created .envrc with keychain lookup.");
        } else if (envrc.appended) {
            console.log("Appended keychain lookup to existing .envrc.");
        }
    } catch {
        // Non-fatal: .envrc setup failed (e.g. permissions)
    }

    console.log(`Directory: ${directory}`);
    console.log();

    const entries = listKeychainEntries(directory);
    const hasOthers = entries.otherKeys.length > 0;
    const hasCurrentKey = !!entries.currentKey;

    if (hasCurrentKey) {
        console.log(`Current key: ${entries.currentKey!.label}`);
        console.log();
    }

    // Build menu
    const options: Array<{ id: string; label: string }> = [];
    options.push({ id: "set", label: "Set a key" });
    if (hasOthers || hasCurrentKey) {
        options.push({ id: "delete", label: "Delete a key" });
    }
    if (hasOthers || hasCurrentKey || listCapturedKeys().length > 0) {
        options.push({ id: "rename", label: "Name a key" });
    }
    options.push({ id: "prune", label: "Prune orphaned key names" });

    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask: AskFn = (q) => new Promise((resolve) => rl.question(q, resolve));

    let action: string;

    if (options.length === 1 && !hasCurrentKey && !hasOthers && !entries.hasDefaultKey) {
        // Only option is "set" with nothing else - skip menu
        action = "set";
    } else {
        console.log("What would you like to do?");
        for (let i = 0; i < options.length; i++) {
            console.log(`  ${i + 1}) ${options[i].label}`);
        }
        if (hasCurrentKey) {
            console.log("  q) Keep existing key");
        }
        console.log();

        const choice = await ask("Choice: ");

        if (hasCurrentKey && choice.toLowerCase() === "q") {
            console.log("Keeping existing key.");
            rl.close();
            process.exit(0);
        }

        const idx = parseInt(choice, 10);
        if (isNaN(idx) || idx < 1 || idx > options.length) {
            console.log("Invalid choice. Cancelled.");
            rl.close();
            process.exit(1);
        }
        action = options[idx - 1].id;
    }

    if (action === "set") {
        await handleSet(ask, directory, entries);
    } else if (action === "delete") {
        await handleDelete(ask, directory, entries);
    } else if (action === "rename") {
        await handleRename(ask, directory, entries);
    } else if (action === "prune") {
        await handlePrune();
    }

    rl.close();
}

main().catch((err) => {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
});
