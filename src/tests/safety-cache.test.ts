import { describe, it, expect } from "vitest";
import { ApprovalCache } from "../safety-cache.js";

describe("ApprovalCache", () => {
    it("misses on first lookup", () => {
        const c = new ApprovalCache();
        expect(c.get("Bash", { command: "ls" }, "user-only")).toBeNull();
    });

    it("hits after a set", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "ls" }, "user-only", { decision: "approve", reason: "ok" });
        expect(c.get("Bash", { command: "ls" }, "user-only")?.decision).toBe("approve");
    });

    it("differentiates by tool input", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "ls" }, "user-only", { decision: "approve", reason: "ok" });
        expect(c.get("Bash", { command: "rm -rf /" }, "user-only")).toBeNull();
    });

    it("differentiates by tool name", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "ls" }, "user-only", { decision: "approve", reason: "ok" });
        expect(c.get("Edit", { command: "ls" }, "user-only")).toBeNull();
    });

    it("normalizes input order so {a,b} and {b,a} hit the same entry", () => {
        const c = new ApprovalCache();
        c.set("Edit", { file_path: "/a", old_string: "x", new_string: "y" }, "user-only", { decision: "approve", reason: "ok" });
        const hit = c.get("Edit", { new_string: "y", old_string: "x", file_path: "/a" }, "user-only");
        expect(hit?.decision).toBe("approve");
    });

    it("does not cache deny by default", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "rm -rf /" }, "user-only", { decision: "deny", reason: "no" });
        expect(c.get("Bash", { command: "rm -rf /" }, "user-only")).toBeNull();
    });

    it("does not cache prompt", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "weird" }, "user-only", { decision: "prompt", reason: "ambiguous" });
        expect(c.get("Bash", { command: "weird" }, "user-only")).toBeNull();
    });

    it("does not cache needs_context", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "./script.sh" }, "user-only", { decision: "needs_context", reason: "want files", files: ["/foo"] });
        expect(c.get("Bash", { command: "./script.sh" }, "user-only")).toBeNull();
    });

    it("respects max size by evicting oldest", () => {
        const c = new ApprovalCache(2);
        c.set("Bash", { command: "a" }, "user-only", { decision: "approve", reason: "" });
        c.set("Bash", { command: "b" }, "user-only", { decision: "approve", reason: "" });
        c.set("Bash", { command: "c" }, "user-only", { decision: "approve", reason: "" });
        expect(c.get("Bash", { command: "a" }, "user-only")).toBeNull();
        expect(c.get("Bash", { command: "b" }, "user-only")?.decision).toBe("approve");
        expect(c.get("Bash", { command: "c" }, "user-only")?.decision).toBe("approve");
    });

    it("LRU semantics: get refreshes recency, so least-recently-USED is evicted (not least-recently-set)", () => {
        const c = new ApprovalCache(2);
        c.set("Bash", { command: "a" }, "user-only", { decision: "approve", reason: "" });
        c.set("Bash", { command: "b" }, "user-only", { decision: "approve", reason: "" });
        c.get("Bash", { command: "a" }, "user-only"); // touch a, now b is LRU
        c.set("Bash", { command: "c" }, "user-only", { decision: "approve", reason: "" });
        expect(c.get("Bash", { command: "a" }, "user-only")?.decision).toBe("approve"); // a still present
        expect(c.get("Bash", { command: "b" }, "user-only")).toBeNull(); // b evicted
        expect(c.get("Bash", { command: "c" }, "user-only")?.decision).toBe("approve");
    });

    it("clear() empties the cache", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "ls" }, "user-only", { decision: "approve", reason: "ok" });
        c.clear();
        expect(c.get("Bash", { command: "ls" }, "user-only")).toBeNull();
    });

    it("normalizes nested object key order so {a:{x,y}} and {a:{y,x}} hit the same entry", () => {
        const c = new ApprovalCache();
        c.set("Agent", { prompt: "do X", context: { cwd: "/a", env: "prod" } }, "user-only", { decision: "approve", reason: "ok" });
        const hit = c.get("Agent", { prompt: "do X", context: { env: "prod", cwd: "/a" } }, "user-only");
        expect(hit?.decision).toBe("approve");
    });

    it("normalizes nested array elements positionally (order matters for arrays)", () => {
        const c = new ApprovalCache();
        c.set("Agent", { prompt: "x", tags: ["a", "b"] }, "user-only", { decision: "approve", reason: "ok" });
        expect(c.get("Agent", { prompt: "x", tags: ["a", "b"] }, "user-only")?.decision).toBe("approve");
        expect(c.get("Agent", { prompt: "x", tags: ["b", "a"] }, "user-only")).toBeNull();
    });

    it("differentiates by context level - approval at user-only does not hit on full lookup", () => {
        const c = new ApprovalCache();
        c.set("Bash", { command: "ls" }, "user-only", { decision: "approve", reason: "ok" });
        expect(c.get("Bash", { command: "ls" }, "user-only")?.decision).toBe("approve");
        expect(c.get("Bash", { command: "ls" }, "full")).toBeNull();
        expect(c.get("Bash", { command: "ls" }, "none")).toBeNull();
    });
});
