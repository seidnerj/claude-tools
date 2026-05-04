import { describe, it, expect } from "vitest";
import { ApprovalCache } from "../safety-cache.js";

describe("ApprovalCache", () => {
    it("misses on first lookup", () => {
        const c = new ApprovalCache();
        expect(c.get("Bash", { command: "ls" })).toBeNull();
    });

    it("hits after a set", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "ls" }, { decision: "approve", reason: "ok" });
        expect(c.get("Bash", { command: "ls" })?.decision).toBe("approve");
    });

    it("differentiates by tool input", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "ls" }, { decision: "approve", reason: "ok" });
        expect(c.get("Bash", { command: "rm -rf /" })).toBeNull();
    });

    it("differentiates by tool name", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "ls" }, { decision: "approve", reason: "ok" });
        expect(c.get("Edit", { command: "ls" })).toBeNull();
    });

    it("normalizes input order so {a,b} and {b,a} hit the same entry", () => {
        const c = new ApprovalCache();
        c.set("Edit", { file_path: "/a", old_string: "x", new_string: "y" }, { decision: "approve", reason: "ok" });
        const hit = c.get("Edit", { new_string: "y", old_string: "x", file_path: "/a" });
        expect(hit?.decision).toBe("approve");
    });

    it("does not cache deny by default", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "rm -rf /" }, { decision: "deny", reason: "no" });
        expect(c.get("Bash", { command: "rm -rf /" })).toBeNull();
    });

    it("does not cache prompt", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "weird" }, { decision: "prompt", reason: "ambiguous" });
        expect(c.get("Bash", { command: "weird" })).toBeNull();
    });

    it("does not cache needs_context", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "./script.sh" }, { decision: "needs_context", reason: "want files", files: ["/foo"] });
        expect(c.get("Bash", { command: "./script.sh" })).toBeNull();
    });

    it("respects max size by evicting oldest", () => {
        const c = new ApprovalCache(2);
        c.set("Bash", { command: "a" }, { decision: "approve", reason: "" });
        c.set("Bash", { command: "b" }, { decision: "approve", reason: "" });
        c.set("Bash", { command: "c" }, { decision: "approve", reason: "" });
        expect(c.get("Bash", { command: "a" })).toBeNull();
        expect(c.get("Bash", { command: "b" })?.decision).toBe("approve");
        expect(c.get("Bash", { command: "c" })?.decision).toBe("approve");
    });

    it("LRU semantics: get refreshes recency, so least-recently-USED is evicted (not least-recently-set)", () => {
        const c = new ApprovalCache(2);
        c.set("Bash", { command: "a" }, { decision: "approve", reason: "" });
        c.set("Bash", { command: "b" }, { decision: "approve", reason: "" });
        c.get("Bash", { command: "a" }); // touch a, now b is LRU
        c.set("Bash", { command: "c" }, { decision: "approve", reason: "" });
        expect(c.get("Bash", { command: "a" })?.decision).toBe("approve"); // a still present
        expect(c.get("Bash", { command: "b" })).toBeNull(); // b evicted
        expect(c.get("Bash", { command: "c" })?.decision).toBe("approve");
    });

    it("clear() empties the cache", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "ls" }, { decision: "approve", reason: "ok" });
        c.clear();
        expect(c.get("Bash", { command: "ls" })).toBeNull();
    });
});
