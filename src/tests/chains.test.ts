import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = vi.hoisted(() => process.cwd() + "/.test-tmp-chains");

vi.mock("node:os", async (importOriginal) => {
    const actual = await (importOriginal as () => Promise<Record<string, unknown>>)();
    return { ...actual, homedir: () => tmp };
});

import { CHAINS_DIR, chainExists, chainPath, deleteChain, listChainIds, listChains, readChain, writeChain } from "../auth/chains.js";

describe("chains", () => {
    beforeEach(() => {
        fs.mkdirSync(tmp, { recursive: true });
    });
    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("writeChain creates the file and validates id", () => {
        const cfg = {
            id: "work",
            name: "Work",
            chain: [{ provider: "anthropic-api-key", keys: [{ key: "k" }] }],
        };
        writeChain(cfg);
        expect(fs.existsSync(chainPath("work"))).toBe(true);
        expect(chainExists("work")).toBe(true);
    });

    it("writeChain rejects invalid id", () => {
        expect(() => writeChain({ id: "bad id!", chain: [{ provider: "anthropic-api-key" }] })).toThrow(/Invalid chain id/);
    });

    it("writeChain rejects empty chain array", () => {
        expect(() => writeChain({ id: "x", chain: [] })).toThrow(/at least one tier/);
    });

    it("readChain returns null for missing", () => {
        expect(readChain("nope")).toBeNull();
    });

    it("listChainIds returns sorted ids", () => {
        writeChain({ id: "b", chain: [{ provider: "x" }] });
        writeChain({ id: "a", chain: [{ provider: "x" }] });
        expect(listChainIds()).toEqual(["a", "b"]);
    });

    it("listChains returns parsed configs", () => {
        writeChain({ id: "a", name: "Alpha", chain: [{ provider: "anthropic-api-key" }] });
        const all = listChains();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe("Alpha");
    });

    it("deleteChain removes the file", () => {
        writeChain({ id: "tmp", chain: [{ provider: "x" }] });
        expect(deleteChain("tmp")).toBe(true);
        expect(chainExists("tmp")).toBe(false);
        expect(deleteChain("tmp")).toBe(false);
    });

    it("CHAINS_DIR points under tmp homedir mock", () => {
        expect(CHAINS_DIR).toBe(path.join(tmp, ".claude-tools", "chains"));
    });
});
