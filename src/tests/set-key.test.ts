import * as crypto from "node:crypto";
import * as events from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as https from "node:https";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    pruneOrphanedKeyNames,
    captureDefaultKey,
    getCapturedKey,
    listCapturedKeys,
    validateKey,
    ensureEnvrc,
    removeEnvrcSnippet,
    getKeyMeta,
    storeKeyMeta,
    deleteKeyMeta,
} from "../set-key.js";

const tmpDir = vi.hoisted(() => process.cwd() + "/.test-tmp-set-key");
const configFile = path.join(tmpDir, ".claude", "key-config.json");

vi.mock("node:os", async (importOriginal) => {
    const actual = await (importOriginal as () => Promise<Record<string, unknown>>)();
    return { ...actual, homedir: () => tmpDir };
});

vi.mock("node:child_process", () => ({
    execFileSync: vi.fn(),
}));

vi.mock("node:https", () => ({
    request: vi.fn(),
}));

const mockExec = execFileSync as ReturnType<typeof vi.fn>;

function writeConfig(data: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(data, null, 2));
}

function readConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configFile, "utf-8"));
}

function sha256Hex(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    mockExec.mockReset();
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
});

describe("pruneOrphanedKeyNames", () => {
    it("returns 0 and does nothing when key_names is absent", () => {
        writeConfig({});
        mockExec.mockImplementation(() => {
            throw new Error("no keychain");
        });

        const pruned = pruneOrphanedKeyNames();
        expect(pruned).toBe(0);
        expect(readConfig()).toEqual({});
    });

    it("returns 0 when all named keys are still in the keychain", () => {
        const activeKey = "sk-ant-active-key";
        const hash = sha256Hex(activeKey);
        writeConfig({ key_names: { [hash]: "My Active Key" } });

        mockExec.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "dump-keychain") return "";
            if (args[0] === "find-generic-password") {
                if (args.includes("Claude Code")) return `${activeKey}\n`;
            }
            throw new Error("unexpected");
        });

        const pruned = pruneOrphanedKeyNames();
        expect(pruned).toBe(0);
        expect((readConfig() as Record<string, Record<string, string>>).key_names[hash]).toBe("My Active Key");
    });

    it("prunes a single orphaned key name", () => {
        const orphanHash = sha256Hex("sk-ant-deleted-key");
        writeConfig({ key_names: { [orphanHash]: "Deleted Key" } });

        mockExec.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "dump-keychain") return "";
            if (args[0] === "find-generic-password") return "";
            throw new Error("unexpected");
        });

        const pruned = pruneOrphanedKeyNames();
        expect(pruned).toBe(1);
        expect((readConfig() as Record<string, Record<string, string>>).key_names).toEqual({});
    });

    it("prunes orphans while keeping active entries", () => {
        const activeKey = "sk-ant-active";
        const activeHash = sha256Hex(activeKey);
        const orphanHash = sha256Hex("sk-ant-gone");
        writeConfig({
            key_names: {
                [activeHash]: "Active",
                [orphanHash]: "Gone",
            },
        });

        const encodedDir = Buffer.from("/some/project").toString("base64");

        mockExec.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "dump-keychain") {
                return `"svce"<blob>="Claude Code ${encodedDir}"\n`;
            }
            if (args[0] === "find-generic-password") {
                if (args.includes(`Claude Code ${encodedDir}`)) return `${activeKey}\n`;
                return "";
            }
            throw new Error("unexpected");
        });

        const pruned = pruneOrphanedKeyNames();
        expect(pruned).toBe(1);
        const names = (readConfig() as Record<string, Record<string, string>>).key_names;
        expect(names[activeHash]).toBe("Active");
        expect(names[orphanHash]).toBeUndefined();
    });

    it("recognises the default key as active", () => {
        const defaultKey = "sk-ant-default";
        const hash = sha256Hex(defaultKey);
        writeConfig({ key_names: { [hash]: "Default" } });

        mockExec.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "dump-keychain") return "";
            if (args[0] === "find-generic-password") {
                return args.includes("-s") && args[args.indexOf("-s") + 1] === "Claude Code" ? `${defaultKey}\n` : "";
            }
            throw new Error("unexpected");
        });

        const pruned = pruneOrphanedKeyNames();
        expect(pruned).toBe(0);
        expect((readConfig() as Record<string, Record<string, string>>).key_names[hash]).toBe("Default");
    });

    it("prunes all entries when the keychain is empty", () => {
        writeConfig({
            key_names: {
                [sha256Hex("sk-ant-a")]: "A",
                [sha256Hex("sk-ant-b")]: "B",
            },
        });

        mockExec.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "dump-keychain") return "";
            if (args[0] === "find-generic-password") return "";
            throw new Error("unexpected");
        });

        const pruned = pruneOrphanedKeyNames();
        expect(pruned).toBe(2);
        expect((readConfig() as Record<string, Record<string, string>>).key_names).toEqual({});
    });

    it("does not write the file when nothing is pruned", () => {
        writeConfig({});
        mockExec.mockImplementation(() => {
            throw new Error("no keychain");
        });

        const mtime0 = fs.statSync(configFile).mtimeMs;
        pruneOrphanedKeyNames();
        const mtime1 = fs.statSync(configFile).mtimeMs;
        expect(mtime1).toBe(mtime0);
    });
});

// ---------------------------------------------------------------------------
// Helpers shared by captured-key tests
// ---------------------------------------------------------------------------

/** Build a mockExec implementation that simulates a keychain with captured slots. */
function makeCapturedKeychain(slots: Record<number, string>, defaultKey = ""): ReturnType<typeof vi.fn> {
    return vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "dump-keychain") return "";
        if (args[0] === "find-generic-password") {
            const sIdx = args.indexOf("-s");
            if (sIdx === -1) throw new Error("unexpected");
            const service: string = args[sIdx + 1];
            if (service === "Claude Code") return defaultKey ? `${defaultKey}\n` : "";
            const slotMatch = /^Claude Code Key (\d+)$/.exec(service);
            if (slotMatch) {
                const n = Number(slotMatch[1]);
                return slots[n]
                    ? `${slots[n]}\n`
                    : (() => {
                          throw new Error("not found");
                      })();
            }
            return "";
        }
        if (args[0] === "add-generic-password") return "";
        throw new Error(`unexpected security call: ${args.join(" ")}`);
    });
}

describe("captureDefaultKey", () => {
    it("stores the default key in slot 1 when no slots exist", () => {
        writeConfig({});
        const key = "sk-ant-new-key";
        const addedSlots: Record<number, string> = {};

        mockExec.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "find-generic-password") {
                const sIdx = args.indexOf("-s");
                const service: string = args[sIdx + 1];
                if (service === "Claude Code") return `${key}\n`;
                const slotMatch = /^Claude Code Key (\d+)$/.exec(service);
                if (slotMatch) {
                    const n = Number(slotMatch[1]);
                    if (addedSlots[n]) return `${addedSlots[n]}\n`;
                    throw new Error("not found");
                }
            }
            if (args[0] === "add-generic-password") {
                const sIdx = args.indexOf("-s");
                const wIdx = args.indexOf("-w");
                const service: string = args[sIdx + 1];
                const slotMatch = /^Claude Code Key (\d+)$/.exec(service);
                if (slotMatch) addedSlots[Number(slotMatch[1])] = args[wIdx + 1];
                return "";
            }
            throw new Error(`unexpected: ${args.join(" ")}`);
        });

        const slot = captureDefaultKey();
        expect(slot).toBe(1);
        expect(addedSlots[1]).toBe(key);
    });

    it("returns null when the default key is already captured", () => {
        writeConfig({});
        const key = "sk-ant-already";
        mockExec.mockImplementation(makeCapturedKeychain({ 1: key }, key));

        const result = captureDefaultKey();
        expect(result).toBeNull();
    });

    it("uses the next available slot when earlier slots are occupied", () => {
        writeConfig({});
        const existingKey = "sk-ant-old";
        const newKey = "sk-ant-new";
        const addedSlots: Record<number, string> = { 1: existingKey };

        mockExec.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "find-generic-password") {
                const sIdx = args.indexOf("-s");
                const service: string = args[sIdx + 1];
                if (service === "Claude Code") return `${newKey}\n`;
                const slotMatch = /^Claude Code Key (\d+)$/.exec(service);
                if (slotMatch) {
                    const n = Number(slotMatch[1]);
                    if (addedSlots[n]) return `${addedSlots[n]}\n`;
                    throw new Error("not found");
                }
            }
            if (args[0] === "add-generic-password") {
                const sIdx = args.indexOf("-s");
                const wIdx = args.indexOf("-w");
                const service: string = args[sIdx + 1];
                const slotMatch = /^Claude Code Key (\d+)$/.exec(service);
                if (slotMatch) addedSlots[Number(slotMatch[1])] = args[wIdx + 1];
                return "";
            }
            throw new Error(`unexpected: ${args.join(" ")}`);
        });

        const slot = captureDefaultKey();
        expect(slot).toBe(2);
        expect(addedSlots[2]).toBe(newKey);
    });

    it("throws when no default key exists", () => {
        writeConfig({});
        mockExec.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "find-generic-password") return "";
            throw new Error(`unexpected: ${args.join(" ")}`);
        });

        expect(() => captureDefaultKey()).toThrow("No default Claude Code key found");
    });
});

describe("listCapturedKeys", () => {
    it("returns empty array when no slots exist", () => {
        mockExec.mockImplementation(makeCapturedKeychain({}));
        expect(listCapturedKeys()).toEqual([]);
    });

    it("returns entries for each occupied slot", () => {
        mockExec.mockImplementation(makeCapturedKeychain({ 1: "sk-ant-aaa", 2: "sk-ant-bbb" }));
        const entries = listCapturedKeys();
        expect(entries).toHaveLength(2);
        expect(entries[0].slot).toBe(1);
        expect(entries[1].slot).toBe(2);
    });

    it("shows user-defined name when one is saved", () => {
        const key = "sk-ant-named";
        writeConfig({ key_names: { [sha256Hex(key)]: "Production" } });
        mockExec.mockImplementation(makeCapturedKeychain({ 1: key }));
        const entries = listCapturedKeys();
        expect(entries[0].label).toBe("Production");
    });

    it("falls back to truncated key label when no name is saved", () => {
        writeConfig({});
        const key = "sk-ant-api-012345678901234567890";
        mockExec.mockImplementation(makeCapturedKeychain({ 1: key }));
        const entries = listCapturedKeys();
        expect(entries[0].label).toMatch(/\.\.\./);
    });
});

describe("getCapturedKey", () => {
    it("returns the key for an existing slot", () => {
        const key = "sk-ant-slot1";
        mockExec.mockImplementation(makeCapturedKeychain({ 1: key }));
        expect(getCapturedKey(1)).toBe(key);
    });

    it("returns empty string for a missing slot", () => {
        mockExec.mockImplementation(makeCapturedKeychain({}));
        expect(getCapturedKey(99)).toBe("");
    });
});

// ---------------------------------------------------------------------------
// validateKey
// ---------------------------------------------------------------------------

const mockRequest = https.request as ReturnType<typeof vi.fn>;

function stubHttpsResponse(responseBody: object): void {
    mockRequest.mockImplementation((_opts: unknown, callback: (res: events.EventEmitter) => void) => {
        const res = new events.EventEmitter();
        const req = new events.EventEmitter() as events.EventEmitter & { write: () => void; end: () => void };
        req.write = () => {};
        req.end = () => {
            setImmediate(() => {
                callback(res);
                res.emit("data", Buffer.from(JSON.stringify(responseBody)));
                res.emit("end");
            });
        };
        return req;
    });
}

describe("validateKey", () => {
    it("returns valid: true when the API returns input_tokens", async () => {
        stubHttpsResponse({ input_tokens: 5 });
        const result = await validateKey("sk-ant-test-key");
        expect(result.valid).toBe(true);
    });

    it("returns invalid_key for authentication_error", async () => {
        stubHttpsResponse({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
        const result = await validateKey("sk-ant-bad-key");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("invalid_key");
        expect(result.message).toBe("Invalid API key");
    });

    it("returns quota_exhausted and extracts reset date", async () => {
        stubHttpsResponse({
            type: "error",
            error: {
                type: "invalid_request_error",
                message: "You have reached your specified workspace API usage limits. You will regain access on 2026-04-01 at 00:00 UTC.",
            },
        });
        const result = await validateKey("sk-ant-quota-key");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("quota_exhausted");
        expect(result.quotaResetsAt).toBe("2026-04-01");
    });

    it("returns unknown for unrecognised error type", async () => {
        stubHttpsResponse({ type: "error", error: { type: "overloaded_error", message: "Server overloaded" } });
        const result = await validateKey("sk-ant-some-key");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("unknown");
    });

    it("returns network_error when the request emits an error", async () => {
        mockRequest.mockImplementation((_opts: unknown, _cb: unknown) => {
            const req = new events.EventEmitter() as events.EventEmitter & { write: () => void; end: () => void };
            req.write = () => {};
            req.end = () => {
                setImmediate(() => req.emit("error", new Error("ECONNREFUSED")));
            };
            return req;
        });
        const result = await validateKey("sk-ant-broken-key");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("network_error");
    });
});

// ---------------------------------------------------------------------------
// ensureEnvrc / removeEnvrcSnippet
// ---------------------------------------------------------------------------

describe("ensureEnvrc", () => {
    const envrcPath = path.join(tmpDir, ".envrc");

    it("creates .envrc when absent", () => {
        const result = ensureEnvrc(tmpDir);
        expect(result.created).toBe(true);
        expect(result.appended).toBe(false);
        expect(result.alreadyPresent).toBe(false);
        expect(fs.readFileSync(envrcPath, "utf-8")).toContain("managed by claude-tools");
    });

    it("reports alreadyPresent when current snippet is found", () => {
        fs.writeFileSync(envrcPath, "# managed by claude-tools\nsome content\n_cc_fmt_limit\nfi\n");
        const result = ensureEnvrc(tmpDir);
        expect(result.alreadyPresent).toBe(true);
    });

    it("upgrades previous format (admin creds, no spend limits) to current version", () => {
        fs.writeFileSync(envrcPath, "# managed by claude-tools\nsome content\n_CC_ADMIN\nfi\n");
        const result = ensureEnvrc(tmpDir);
        expect(result.upgraded).toBe(true);
        const content = fs.readFileSync(envrcPath, "utf-8");
        expect(content).toContain("_cc_fmt_limit");
    });

    it("upgrades previous format (spend display, no per-directory admin creds) to current version", () => {
        fs.writeFileSync(envrcPath, "# managed by claude-tools\nsome content\n_cc_fmt_cents\nfi\n");
        const result = ensureEnvrc(tmpDir);
        expect(result.upgraded).toBe(true);
        const content = fs.readFileSync(envrcPath, "utf-8");
        expect(content).toContain("_cc_fmt_limit");
    });

    it("upgrades previous format (spend display, no parallel) to current version", () => {
        fs.writeFileSync(envrcPath, "# managed by claude-tools\n_CC_SPEND\nfi\n");
        const result = ensureEnvrc(tmpDir);
        expect(result.upgraded).toBe(true);
        const content = fs.readFileSync(envrcPath, "utf-8");
        expect(content).toContain("_cc_fmt_cents");
    });

    it("upgrades previous format (name resolution, no spend) to current version", () => {
        fs.writeFileSync(envrcPath, "# managed by claude-tools\n_cc_resolve_name\nfi\n");
        const result = ensureEnvrc(tmpDir);
        expect(result.upgraded).toBe(true);
        const content = fs.readFileSync(envrcPath, "utf-8");
        expect(content).toContain("_cc_fmt_cents");
    });

    it("upgrades previous format (yellow warnings, no name resolution) to current version", () => {
        fs.writeFileSync(
            envrcPath,
            '# managed by claude-tools\n_CC_KEY=$(security)\nif [ -n "$_CC_KEY" ]; then\n  export ANTHROPIC_API_KEY="$_CC_KEY"\n  printf \'\\033[33mdirenv: warning\\033[0m\\n\' >&2\nfi\n'
        );
        const result = ensureEnvrc(tmpDir);
        expect(result.upgraded).toBe(true);
        expect(result.alreadyPresent).toBe(false);
        const content = fs.readFileSync(envrcPath, "utf-8");
        expect(content).toContain("_cc_fmt_cents");
    });

    it("upgrades intermediate managed format (no yellow warnings) to current version", () => {
        fs.writeFileSync(
            envrcPath,
            '# managed by claude-tools\n_CC_KEY=$(security)\nif [ -n "$_CC_KEY" ]; then\n  echo "direnv: API key invalid" >&2\nfi\n'
        );
        const result = ensureEnvrc(tmpDir);
        expect(result.upgraded).toBe(true);
        expect(result.alreadyPresent).toBe(false);
        const content = fs.readFileSync(envrcPath, "utf-8");
        expect(content).toContain("_cc_fmt_cents");
    });

    it("upgrades old snippet format to current version", () => {
        const oldSnippet =
            'ENCODED_DIR=$(echo -n "$PWD" | base64)\nAPI_KEY=$(security find-generic-password -s "Claude Code $ENCODED_DIR" -w 2>/dev/null)\nif [ -n "$API_KEY" ]; then\n  export ANTHROPIC_API_KEY="$API_KEY"\nfi\n';
        fs.writeFileSync(envrcPath, oldSnippet);
        const result = ensureEnvrc(tmpDir);
        expect(result.upgraded).toBe(true);
        expect(result.alreadyPresent).toBe(false);
        const content = fs.readFileSync(envrcPath, "utf-8");
        expect(content).toContain("# managed by claude-tools");
        expect(content).not.toContain("Claude Code $ENCODED_DIR");
    });

    it("upgrades old snippet when surrounded by other content", () => {
        const oldSnippet =
            'ENCODED_DIR=$(echo -n "$PWD" | base64)\nAPI_KEY=$(security find-generic-password -s "Claude Code $ENCODED_DIR" -w 2>/dev/null)\nif [ -n "$API_KEY" ]; then\n  export ANTHROPIC_API_KEY="$API_KEY"\nfi\n';
        fs.writeFileSync(envrcPath, "export FOO=bar\n" + oldSnippet);
        const result = ensureEnvrc(tmpDir);
        expect(result.upgraded).toBe(true);
        const content = fs.readFileSync(envrcPath, "utf-8");
        expect(content).toContain("export FOO=bar");
        expect(content).toContain("# managed by claude-tools");
        expect(content).not.toContain("Claude Code $ENCODED_DIR");
    });

    it("appends to existing .envrc that lacks the snippet", () => {
        fs.writeFileSync(envrcPath, "export FOO=bar\n");
        const result = ensureEnvrc(tmpDir);
        expect(result.appended).toBe(true);
        const content = fs.readFileSync(envrcPath, "utf-8");
        expect(content).toContain("export FOO=bar");
        expect(content).toContain("managed by claude-tools");
    });
});

describe("removeEnvrcSnippet", () => {
    const envrcPath = path.join(tmpDir, ".envrc");

    it("removes the new snippet and deletes file if it was the only content", () => {
        fs.writeFileSync(envrcPath, '# managed by claude-tools\n_CC_KEY=$(security)\nif [ -n "$_CC_KEY" ]; then\n  unset _CC_RESP _CC_KEY\nfi\n');
        const result = removeEnvrcSnippet(tmpDir);
        expect(result.removed).toBe(true);
        expect(result.fileDeleted).toBe(true);
    });

    it("removes new snippet while preserving surrounding content", () => {
        fs.writeFileSync(
            envrcPath,
            'export FOO=bar\n# managed by claude-tools\n_CC_KEY=$(security)\nif [ -n "$_CC_KEY" ]; then\n  unset _CC_RESP _CC_KEY\nfi\nexport BAZ=qux\n'
        );
        const result = removeEnvrcSnippet(tmpDir);
        expect(result.removed).toBe(true);
        expect(result.fileDeleted).toBe(false);
        const content = fs.readFileSync(envrcPath, "utf-8");
        expect(content).toContain("FOO=bar");
        expect(content).toContain("BAZ=qux");
        expect(content).not.toContain("managed by claude-tools");
    });

    it("removes the old snippet format", () => {
        fs.writeFileSync(
            envrcPath,
            'ENCODED_DIR=$(echo -n "$PWD" | base64)\nAPI_KEY=$(security find-generic-password -s "Claude Code $ENCODED_DIR" -w 2>/dev/null)\nif [ -n "$API_KEY" ]; then\n  export ANTHROPIC_API_KEY="$API_KEY"\nfi\n'
        );
        const result = removeEnvrcSnippet(tmpDir);
        expect(result.removed).toBe(true);
        expect(result.fileDeleted).toBe(true);
    });

    it("returns removed: false when file does not exist", () => {
        const result = removeEnvrcSnippet(tmpDir);
        expect(result.removed).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// getKeyMeta / storeKeyMeta / deleteKeyMeta
// ---------------------------------------------------------------------------

describe("key metadata", () => {
    const testDir = tmpDir + "/meta-test";

    beforeEach(() => {
        fs.mkdirSync(testDir, { recursive: true });
    });

    it("returns null when no metadata is stored", () => {
        mockExec.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "find-generic-password") return "";
            throw new Error("unexpected");
        });
        expect(getKeyMeta(testDir)).toBeNull();
    });

    it("stores and retrieves key metadata", () => {
        const keyId = "apikey_01XXXX";
        const workspaceId = "wrkspc_01YYYY";
        mockExec.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "delete-generic-password") return "";
            if (args[0] === "add-generic-password") return "";
            if (args[0] === "find-generic-password") return `${keyId}:${workspaceId}\n`;
            throw new Error("unexpected");
        });
        expect(storeKeyMeta(testDir, keyId, workspaceId)).toBe(true);
        const meta = getKeyMeta(testDir);
        expect(meta).not.toBeNull();
        expect(meta!.keyId).toBe(keyId);
        expect(meta!.workspaceId).toBe(workspaceId);
    });

    it("returns null when stored value has no colon separator", () => {
        mockExec.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "find-generic-password") return "nocolon\n";
            throw new Error("unexpected");
        });
        expect(getKeyMeta(testDir)).toBeNull();
    });

    it("deleteKeyMeta removes the metadata entry", () => {
        const deleted: string[] = [];
        mockExec.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "delete-generic-password") {
                deleted.push(args[args.indexOf("-s") + 1]);
                return "";
            }
            throw new Error("unexpected");
        });
        deleteKeyMeta(testDir);
        expect(deleted.some((s) => s.includes(":meta"))).toBe(true);
    });
});
