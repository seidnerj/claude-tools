import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        configGet: (k: string, d?: string) => {
            if (k === "safety.billing_cch") return "test-cch";
            if (k === "safety.billing_cc_version") return "test.0";
            if (k === "safety.model") return "claude-opus-4-6";
            return d;
        },
        configGetObject: () => undefined,
    };
});

import { runStage, runTwoStage } from "../safety-stages.js";

function mockFetchOnce(text: string, status = 200) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status }));
}

describe("runStage", () => {
    afterEach(() => vi.restoreAllMocks());

    it("S1 returns approve on <block>no</block>", async () => {
        mockFetchOnce("<block>no</block>");
        const r = await runStage("k", "s1", "Bash: ls");
        expect(r?.decision).toBe("approve");
    });

    it("S1 returns escalate sentinel on <block>yes</block>", async () => {
        mockFetchOnce("<block>yes</block>");
        const r = await runStage("k", "s1", "Bash: rm -rf /");
        expect(r?.decision).toBe("needs_context");
        expect(r?.reason).toBe("__S1_ESCALATE__");
    });

    it("S1 sets max_tokens=64 and stop_sequences=[</block>]", async () => {
        const spy = mockFetchOnce("<block>no</block>");
        await runStage("k", "s1", "x");
        const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
        expect(body.max_tokens).toBe(64);
        expect(body.stop_sequences).toEqual(["</block>"]);
        expect(body.thinking).toBeUndefined();
    });

    it("S2 sets max_tokens=4096, no stop_sequences, has thinking", async () => {
        const spy = mockFetchOnce('{"decision":"approve","reason":"ok"}');
        await runStage("k", "s2", "x");
        const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
        expect(body.max_tokens).toBe(4096);
        expect(body.stop_sequences).toBeUndefined();
        expect(body.thinking).toEqual({ type: "adaptive" });
    });

    it("single_fast returns deny on <block>yes</block> with reason", async () => {
        mockFetchOnce("<block>yes</block><reason>too risky</reason>");
        const r = await runStage("k", "single_fast", "Bash: rm -rf /");
        expect(r?.decision).toBe("deny");
        expect(r?.reason).toContain("too risky");
    });

    it("single_fast returns approve on <block>no</block>", async () => {
        mockFetchOnce("<block>no</block>");
        const r = await runStage("k", "single_fast", "Bash: ls");
        expect(r?.decision).toBe("approve");
    });

    it("single_fast budget=256, has stop_sequences, no thinking", async () => {
        const spy = mockFetchOnce("<block>no</block>");
        await runStage("k", "single_fast", "x");
        const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
        expect(body.max_tokens).toBe(256);
        expect(body.stop_sequences).toEqual(["</block>"]);
        expect(body.thinking).toBeUndefined();
    });

    it("single_thinking returns parsed JSON verdict", async () => {
        mockFetchOnce('{"decision":"approve","reason":"safe"}');
        const r = await runStage("k", "single_thinking", "Bash: ls");
        expect(r?.decision).toBe("approve");
        expect(r?.reason).toBe("safe");
    });

    it("single_thinking budget=4096, has thinking, no stop_sequences", async () => {
        const spy = mockFetchOnce('{"decision":"approve","reason":""}');
        await runStage("k", "single_thinking", "x");
        const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
        expect(body.max_tokens).toBe(4096);
        expect(body.stop_sequences).toBeUndefined();
        expect(body.thinking).toEqual({ type: "adaptive" });
    });

    it("returns null on API 500 error", async () => {
        mockFetchOnce("server error", 500);
        const r = await runStage("k", "single_thinking", "x");
        expect(r).toBeNull();
    });

    it("returns null on unparseable JSON for single_thinking", async () => {
        mockFetchOnce("not json");
        const r = await runStage("k", "single_thinking", "x");
        expect(r).toBeNull();
    });

    it("returns null on unparseable XML for single_fast", async () => {
        mockFetchOnce("not xml");
        const r = await runStage("k", "single_fast", "x");
        expect(r).toBeNull();
    });
});

describe("runTwoStage", () => {
    afterEach(() => vi.restoreAllMocks());

    it("returns S1 approve directly without calling S2", async () => {
        const fetchSpy = mockFetchOnce("<block>no</block>");
        const r = await runTwoStage("k", "Bash: ls");
        expect(r?.decision).toBe("approve");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("escalates to S2 when S1 says yes", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: "<block>yes</block>" }] })))
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: [{ type: "text", text: '{"decision":"deny","reason":"S2 confirmed"}' }] }))
            );
        const r = await runTwoStage("k", "Bash: rm -rf /");
        expect(r?.decision).toBe("deny");
        expect(r?.reason).toBe("S2 confirmed");
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("propagates S2 needs_context up to caller", async () => {
        vi.spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: "<block>yes</block>" }] })))
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ content: [{ type: "text", text: '{"decision":"needs_context","reason":"want files","files":["/foo"]}' }] })
                )
            );
        const r = await runTwoStage("k", "Bash: ./script.sh");
        expect(r?.decision).toBe("needs_context");
        expect(r?.files).toEqual(["/foo"]);
    });

    it("returns null when S1 fails", async () => {
        mockFetchOnce("server error", 500);
        const r = await runTwoStage("k", "x");
        expect(r).toBeNull();
    });
});
