import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pruneOrphanedKeyNames, captureDefaultKey, getCapturedKey, listCapturedKeys } from "../set-key.js";

const tmpDir = path.join(process.cwd(), ".test-tmp-set-key");
const configFile = path.join(tmpDir, ".claude", "key-config.json");

vi.mock("node:os", async (importOriginal) => {
    const actual = await (importOriginal as () => Promise<Record<string, unknown>>)();
    return { ...actual, homedir: () => tmpDir };
});

vi.mock("node:child_process", () => ({
    execFileSync: vi.fn(),
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
