import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = vi.hoisted(() => process.cwd() + "/.test-tmp-dirs");

vi.mock("node:os", async (importOriginal) => {
    const actual = await (importOriginal as () => Promise<Record<string, unknown>>)();
    return { ...actual, homedir: () => tmp };
});

import {
    DIRECTORIES_FILE,
    directoriesUsingChain,
    getDirectoryChain,
    listDirectoryAssignments,
    setDirectoryChain,
    unsetDirectoryChain,
} from "../auth/directories.js";

describe("directories", () => {
    beforeEach(() => {
        fs.mkdirSync(tmp, { recursive: true });
    });
    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("returns null for unassigned directory", () => {
        expect(getDirectoryChain("/Users/x/proj")).toBeNull();
    });

    it("set + get roundtrips", () => {
        setDirectoryChain("/Users/x/proj", "work");
        expect(getDirectoryChain("/Users/x/proj")).toBe("work");
    });

    it("set persists to JSON file", () => {
        setDirectoryChain("/Users/x/proj", "work");
        expect(fs.existsSync(DIRECTORIES_FILE)).toBe(true);
        const data = JSON.parse(fs.readFileSync(DIRECTORIES_FILE, "utf-8")) as Record<string, string>;
        expect(Object.values(data)).toContain("work");
    });

    it("unset removes the entry", () => {
        setDirectoryChain("/Users/x/proj", "work");
        expect(unsetDirectoryChain("/Users/x/proj")).toBe(true);
        expect(getDirectoryChain("/Users/x/proj")).toBeNull();
        expect(unsetDirectoryChain("/Users/x/proj")).toBe(false);
    });

    it("listDirectoryAssignments returns decoded paths sorted", () => {
        setDirectoryChain("/b/path", "x");
        setDirectoryChain("/a/path", "y");
        const list = listDirectoryAssignments();
        expect(list.map((l) => l.directory)).toEqual(["/a/path", "/b/path"]);
        expect(list[0].chainId).toBe("y");
    });

    it("directoriesUsingChain filters by chain-id", () => {
        setDirectoryChain("/a", "work");
        setDirectoryChain("/b", "personal");
        setDirectoryChain("/c", "work");
        expect(directoriesUsingChain("work").sort()).toEqual(["/a", "/c"]);
        expect(directoriesUsingChain("personal")).toEqual(["/b"]);
    });

    it("handles malformed JSON gracefully", () => {
        fs.mkdirSync(tmp + "/.claude-tools", { recursive: true });
        fs.writeFileSync(DIRECTORIES_FILE, "not json");
        expect(getDirectoryChain("/x")).toBeNull();
    });
});
