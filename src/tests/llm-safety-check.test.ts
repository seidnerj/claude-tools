import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { approvalCache } from "../safety-cache.js";

// Mock getApiKey and configGet before importing the module under test
vi.mock("../utils.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        getApiKey: vi.fn(() => null),
        configGet: vi.fn((key: string) => {
            if (key === "safety.billing_cch") return "64d93";
            if (key === "safety.billing_cc_version") return "2.1.83.c50";
            return null;
        }),
    };
});

// Mock fs/promises for resolveRequestedFiles tests
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        stat: vi.fn(actual.stat as (...args: unknown[]) => unknown),
        readFile: vi.fn(actual.readFile as (...args: unknown[]) => unknown),
    };
});

import { stat, readFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    checkCommandSafety,
    checkToolSafety,
    processHookInput,
    resolveRequestedFiles,
    isFastApprove,
    extractTaskContext,
    getBlockState,
    incrementBlockCount,
    resetConsecutiveBlocks,
    shouldDegradeToPrompt,
} from "../llm-safety-check.js";
import { getApiKey, configGetObject, configSetObject } from "../utils.js";

const mockStat = vi.mocked(stat);
const mockReadFile = vi.mocked(readFile);

const mockGetApiKey = vi.mocked(getApiKey);

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockGetApiKey.mockReturnValue(null);
    approvalCache.clear();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    approvalCache.clear();
});

// ---------------------------------------------------------------------------
// Helper to create a mock Claude API response
// ---------------------------------------------------------------------------

function mockApiResponse(decision: string, reason: string, files?: string[]) {
    const payload: Record<string, unknown> = { decision, reason };
    if (files) payload.files = files;
    return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
            content: [
                { type: "thinking", thinking: "..." },
                { type: "text", text: JSON.stringify(payload) },
            ],
        }),
    };
}

/**
 * Create a mock response for the S1 stage (XML format).
 * "no" -> S1 approves (no escalation); "yes" -> S1 escalates to S2.
 */
function mockS1Response(block: "yes" | "no") {
    return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
            content: [{ type: "text", text: `<block>${block}</block>` }],
        }),
    };
}

// ---------------------------------------------------------------------------
// resolveRequestedFiles
// ---------------------------------------------------------------------------

describe("resolveRequestedFiles", () => {
    it("reads files that exist", async () => {
        mockStat.mockResolvedValueOnce({ isFile: () => true, size: 100 } as Awaited<ReturnType<typeof stat>>);
        mockReadFile.mockResolvedValueOnce("print('hello')" as never);

        const result = await resolveRequestedFiles(["/tmp/test_script.py"]);
        expect(result.get("/tmp/test_script.py")).toBe("print('hello')");
    });

    it("skips files that do not exist", async () => {
        mockStat.mockRejectedValueOnce(new Error("ENOENT"));

        const result = await resolveRequestedFiles(["/tmp/nonexistent.py"]);
        expect(result.size).toBe(0);
    });

    it("skips files larger than the size limit", async () => {
        mockStat.mockResolvedValueOnce({ isFile: () => true, size: 100_000 } as Awaited<ReturnType<typeof stat>>);

        const result = await resolveRequestedFiles(["/tmp/huge_file.py"]);
        expect(result.size).toBe(0);
    });

    it("skips directories", async () => {
        mockStat.mockResolvedValueOnce({ isFile: () => false, size: 100 } as Awaited<ReturnType<typeof stat>>);

        const result = await resolveRequestedFiles(["/tmp/some_dir"]);
        expect(result.size).toBe(0);
    });

    it("reads multiple files", async () => {
        mockStat
            .mockResolvedValueOnce({ isFile: () => true, size: 50 } as Awaited<ReturnType<typeof stat>>)
            .mockResolvedValueOnce({ isFile: () => true, size: 50 } as Awaited<ReturnType<typeof stat>>);
        mockReadFile.mockResolvedValueOnce("script1" as never).mockResolvedValueOnce("script2" as never);

        const result = await resolveRequestedFiles(["/tmp/a.py", "/home/user/b.sh"]);
        expect(result.size).toBe(2);
        expect(result.get("/tmp/a.py")).toBe("script1");
        expect(result.get("/home/user/b.sh")).toBe("script2");
    });

    it("returns empty map for empty input", async () => {
        const result = await resolveRequestedFiles([]);
        expect(result.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// checkCommandSafety
// ---------------------------------------------------------------------------

describe("checkCommandSafety", () => {
    it("returns null when no API key is available", async () => {
        mockGetApiKey.mockReturnValue(null);

        const result = await checkCommandSafety("Bash", { command: "ls" });
        expect(result).toBeNull();
    });

    it("returns approve decision from API (S1 clears in two-stage default)", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        // Default mode is two-stage: S1 responds with XML approve
        mockFetch.mockResolvedValueOnce(mockS1Response("no"));

        const result = await checkCommandSafety("Bash", { command: "ls -la", description: "List files" });
        expect(result?.decision).toBe("approve");

        // S1 should be the only call
        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
        expect(opts.headers["x-api-key"]).toBe("test-key");

        // S1 body: 64-token budget, stop_sequences, no thinking
        const body = JSON.parse(opts.body);
        expect(body.model).toBe("claude-opus-4-6");
        expect(body.max_tokens).toBe(64);
        expect(body.stop_sequences).toEqual(["</block>"]);
        expect(body.thinking).toBeUndefined();
        const contentBlocks = body.messages[0].content;
        const contentText = contentBlocks[contentBlocks.length - 1].text;
        expect(contentText).toContain("<untrusted-command>");
        expect(contentText).toContain("ls -la");
        expect(contentText).toContain("</untrusted-command>");
        expect(contentText).toContain("<untrusted-description>");
        expect(contentText).toContain("List files");
        expect(contentText).toContain("</untrusted-description>");
    });

    it("returns deny decision from API (S1 escalates, S2 denies)", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        // S1 escalates (yes = needs S2 review)
        mockFetch.mockResolvedValueOnce(mockS1Response("yes"));
        // S2 denies
        mockFetch.mockResolvedValueOnce(mockApiResponse("deny", "Dangerous command"));

        const result = await checkCommandSafety("Bash", { command: "rm -rf /" });
        expect(result).toEqual({ decision: "deny", reason: "Dangerous command" });
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("returns null on API error", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Internal Server Error" });

        const result = await checkCommandSafety("Bash", { command: "ls" });
        expect(result).toBeNull();
    });

    it("returns null on network failure", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockRejectedValueOnce(new Error("Network unreachable"));

        const result = await checkCommandSafety("Bash", { command: "ls" });
        expect(result).toBeNull();
    });

    it("handles markdown-wrapped JSON response (S1 escalates, S2 returns markdown JSON)", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        // S1 escalates to S2
        mockFetch.mockResolvedValueOnce(mockS1Response("yes"));
        // S2 returns markdown-wrapped JSON
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                content: [{ type: "text", text: '```json\n{"decision": "prompt", "reason": "Ambiguous"}\n```' }],
            }),
        });

        const result = await checkCommandSafety("Bash", { command: "curl example.com" });
        expect(result).toEqual({ decision: "prompt", reason: "Ambiguous" });
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("performs two-pass when first call returns needs_context (S1 escalates, S2 needs_context, S2 second pass)", async () => {
        mockGetApiKey.mockReturnValue("test-key");

        // S1: escalate to S2
        mockFetch.mockResolvedValueOnce(mockS1Response("yes"));

        // S2 first pass: model asks for file contents
        mockFetch.mockResolvedValueOnce(mockApiResponse("needs_context", "Need to inspect the script", ["/tmp/test.py"]));

        // File resolution
        mockStat.mockResolvedValueOnce({ isFile: () => true, size: 50 } as Awaited<ReturnType<typeof stat>>);
        mockReadFile.mockResolvedValueOnce("print('safe')" as never);

        // S2 second pass: model makes final decision with file contents
        mockFetch.mockResolvedValueOnce(mockApiResponse("approve", "Script is safe"));

        const result = await checkCommandSafety("Bash", { command: "python3 /tmp/test.py" });

        expect(result).toEqual({ decision: "approve", reason: "Script is safe" });
        expect(mockFetch).toHaveBeenCalledTimes(3);

        // Verify third call includes file contents
        const thirdBody = JSON.parse(mockFetch.mock.calls[2][1].body);
        const thirdContentBlocks = thirdBody.messages[0].content;
        const thirdContentText = thirdContentBlocks[thirdContentBlocks.length - 1].text;
        expect(thirdContentText).toContain("Referenced file contents (UNTRUSTED");
        expect(thirdContentText).toContain('<untrusted-file path="/tmp/test.py">');
        expect(thirdContentText).toContain("print('safe')");
    });

    it("handles needs_context with no files listed (S1 escalates, S2 needs_context with no files)", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        // S1 escalates to S2
        mockFetch.mockResolvedValueOnce(mockS1Response("yes"));
        // S2 returns needs_context with no file list
        mockFetch.mockResolvedValueOnce(mockApiResponse("needs_context", "Ambiguous but no files to check"));

        const result = await checkCommandSafety("Bash", { command: "some-command" });

        // Should return the needs_context result as-is without a third call
        expect(result).toEqual({ decision: "needs_context", reason: "Ambiguous but no files to check" });
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("handles needs_context when requested files don't exist (S1 escalates, S2 needs_context, S2 second pass)", async () => {
        mockGetApiKey.mockReturnValue("test-key");

        // S1: escalate to S2
        mockFetch.mockResolvedValueOnce(mockS1Response("yes"));

        // S2 first pass: model asks for file
        mockFetch.mockResolvedValueOnce(mockApiResponse("needs_context", "Need the script", ["/tmp/missing.py"]));

        // File doesn't exist
        mockStat.mockRejectedValueOnce(new Error("ENOENT"));

        // S2 second pass: model decides without file contents
        mockFetch.mockResolvedValueOnce(mockApiResponse("prompt", "Script not found on disk"));

        const result = await checkCommandSafety("Bash", { command: "python3 /tmp/missing.py" });

        expect(result).toEqual({ decision: "prompt", reason: "Script not found on disk" });
        expect(mockFetch).toHaveBeenCalledTimes(3);

        // Third call should not include file contents section
        const thirdBody = JSON.parse(mockFetch.mock.calls[2][1].body);
        const noCtxBlocks = thirdBody.messages[0].content;
        const noCtxText = noCtxBlocks[noCtxBlocks.length - 1].text;
        expect(noCtxText).not.toContain("Referenced file contents");
    });

    it("returns null when second pass API call fails (S1 escalates, S2 needs_context, S2 second pass fails)", async () => {
        mockGetApiKey.mockReturnValue("test-key");

        // S1: escalate to S2
        mockFetch.mockResolvedValueOnce(mockS1Response("yes"));

        // S2 first pass: needs file
        mockFetch.mockResolvedValueOnce(mockApiResponse("needs_context", "Need the script", ["/tmp/test.py"]));

        mockStat.mockResolvedValueOnce({ isFile: () => true, size: 50 } as Awaited<ReturnType<typeof stat>>);
        mockReadFile.mockResolvedValueOnce("content" as never);

        // S2 second pass fails
        mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Server Error" });

        const result = await checkCommandSafety("Bash", { command: "python3 /tmp/test.py" });
        expect(result).toBeNull();
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });
});

// ---------------------------------------------------------------------------
// processHookInput
// ---------------------------------------------------------------------------

describe("processHookInput", () => {
    beforeEach(() => {
        mockGetApiKey.mockReturnValue("test-key");
    });

    it("returns allow output for approve decision (S1 clears)", async () => {
        // S1 approves directly with XML response
        mockFetch.mockResolvedValueOnce(mockS1Response("no"));

        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "python3 script.py" },
        });
        expect(result?.decision).toBe("allow");
    });

    it("returns deny output for deny decision (S1 escalates, S2 denies)", async () => {
        // S1 escalates
        mockFetch.mockResolvedValueOnce(mockS1Response("yes"));
        // S2 denies
        mockFetch.mockResolvedValueOnce(mockApiResponse("deny", "Dangerous"));

        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "rm -rf /" },
        });
        expect(result).toEqual({ decision: "deny", reason: "Dangerous" });
    });

    it("returns null for prompt decision (fall through, S1 escalates, S2 prompts)", async () => {
        // S1 escalates
        mockFetch.mockResolvedValueOnce(mockS1Response("yes"));
        // S2 returns prompt
        mockFetch.mockResolvedValueOnce(mockApiResponse("prompt", "Ambiguous"));

        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "curl example.com" },
        });
        expect(result).toBeNull();
    });

    it("logs reason to stderr for prompt decision (S1 escalates, S2 prompts)", async () => {
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        // S1 escalates
        mockFetch.mockResolvedValueOnce(mockS1Response("yes"));
        // S2 returns prompt with reason
        mockFetch.mockResolvedValueOnce(mockApiResponse("prompt", "Contains hardcoded credentials"));

        await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "curl -u user:pass example.com" },
        });

        expect(stderrSpy).toHaveBeenCalledWith("LLM safety check [prompt]: Contains hardcoded credentials\n");
        stderrSpy.mockRestore();
    });

    it("does not log to stderr for prompt decision with empty reason (S1 escalates, S2 prompt empty)", async () => {
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        // S1 escalates
        mockFetch.mockResolvedValueOnce(mockS1Response("yes"));
        // S2 returns prompt with empty reason
        mockFetch.mockResolvedValueOnce(mockApiResponse("prompt", ""));

        await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "curl example.com" },
        });

        expect(stderrSpy).not.toHaveBeenCalled();
        stderrSpy.mockRestore();
    });

    it("returns null on API failure (fall through)", async () => {
        mockFetch.mockRejectedValueOnce(new Error("timeout"));

        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "python3 script.py" },
        });
        expect(result).toBeNull();
    });

    it("fast-approves known-safe Bash commands without calling the API", async () => {
        mockGetApiKey.mockReturnValue("sk-ant-test");
        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "git status" },
        });
        expect(result?.decision).toBe("allow");
        expect(result?.reason).toContain("Known-safe");
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fast-approves Edit within cwd without calling the API", async () => {
        mockGetApiKey.mockReturnValue("sk-ant-test");
        const result = await processHookInput({
            tool_name: "Edit",
            tool_input: { file_path: "/project/src/foo.ts", old_string: "a", new_string: "b" },
            cwd: "/project",
        });
        expect(result?.decision).toBe("allow");
        expect(result?.reason).toContain("Local edit");
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// isFastApprove
// ---------------------------------------------------------------------------

describe("isFastApprove", () => {
    describe("Bash commands", () => {
        it.each([
            "ls",
            "ls -la",
            "cat file.txt",
            "head -20 foo.ts",
            "tail -f log.txt",
            "wc -l src/main.ts",
            "git status",
            "git log --oneline -5",
            "git diff HEAD",
            "git show HEAD:file.ts",
            "git branch -a",
            "git describe --tags",
            "npm test",
            "npm run test",
            "npm run lint",
            "npm run build",
            "npm ls",
            "vitest run",
            "jest --watch",
            "pytest -v",
            "cargo test",
            "cargo check",
            "go test ./...",
            "tsc --noEmit",
            "echo hello",
            "pwd",
            "whoami",
            "uname -a",
            "date",
            "env",
            "which node",
            "node --version",
            "python3 --version",
            "npm --help",
        ])("approves safe command: %s", (cmd) => {
            expect(isFastApprove("Bash", { command: cmd })).not.toBeNull();
        });

        it.each([
            "rm -rf /",
            "rm file.txt",
            "curl https://example.com",
            "wget https://example.com",
            "chmod 777 file",
            "sudo anything",
            "docker run something",
            "git push origin main",
            "git push --force",
            "ssh user@host",
            "npm install some-package",
            "pip install requests",
            "kill -9 1234",
            "mv file1 file2",
            "cp -r /etc /tmp",
        ])("does not approve unsafe command: %s", (cmd) => {
            expect(isFastApprove("Bash", { command: cmd })).toBeNull();
        });

        it.each(["ls | grep foo", "cat file.txt | wc -l", "echo hello > file.txt", "git status | head", "echo $(whoami)", "ls `pwd`"])(
            "does not approve command with pipes/redirects/substitution: %s",
            (cmd) => {
                expect(isFastApprove("Bash", { command: cmd })).toBeNull();
            }
        );

        it("does not approve empty command", () => {
            expect(isFastApprove("Bash", { command: "" })).toBeNull();
            expect(isFastApprove("Bash", {})).toBeNull();
        });
    });

    describe("Edit/Write in cwd", () => {
        it("approves Edit within cwd", () => {
            expect(isFastApprove("Edit", { file_path: "/project/src/foo.ts" }, "/project")).not.toBeNull();
        });

        it("approves Write within cwd", () => {
            expect(isFastApprove("Write", { file_path: "/project/new-file.ts" }, "/project")).not.toBeNull();
        });

        it("does not approve Edit outside cwd", () => {
            expect(isFastApprove("Edit", { file_path: "/etc/passwd" }, "/project")).toBeNull();
        });

        it("does not approve Write outside cwd", () => {
            expect(isFastApprove("Write", { file_path: "/home/user/.bashrc" }, "/project")).toBeNull();
        });

        it("does not approve Edit/Write when cwd is not provided", () => {
            expect(isFastApprove("Edit", { file_path: "/project/foo.ts" })).toBeNull();
            expect(isFastApprove("Write", { file_path: "/project/foo.ts" })).toBeNull();
        });

        it("does not approve when file_path is missing", () => {
            expect(isFastApprove("Edit", {}, "/project")).toBeNull();
            expect(isFastApprove("Write", {}, "/project")).toBeNull();
        });

        it("rejects path traversal outside cwd", () => {
            expect(isFastApprove("Edit", { file_path: "/project/../etc/passwd" }, "/project")).toBeNull();
        });
    });

    describe("other tools", () => {
        it("returns null for tools not covered by fast-path", () => {
            expect(isFastApprove("WebFetch", { url: "https://example.com" })).toBeNull();
            expect(isFastApprove("Agent", { prompt: "do something" })).toBeNull();
            expect(isFastApprove("mcp__server__tool", { input: "data" })).toBeNull();
        });
    });
});

// ---------------------------------------------------------------------------
// checkToolSafety - multi-tool formatting
// ---------------------------------------------------------------------------

describe("checkToolSafety multi-tool formatting", () => {
    beforeEach(() => {
        mockGetApiKey.mockReturnValue("test-key");
        // S1 approves via XML so the chain completes with one call
        mockFetch.mockResolvedValue(mockS1Response("no"));
    });

    it("formats Edit tool input with file path and old/new strings", async () => {
        await checkToolSafety("Edit", {
            file_path: "/project/src/foo.ts",
            old_string: "old code",
            new_string: "new code",
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        const contentBlocks = body.messages[0].content;
        const contentText = contentBlocks[contentBlocks.length - 1].text;
        expect(contentText).toContain("Tool: Edit");
        expect(contentText).toContain("File: /project/src/foo.ts");
        expect(contentText).toContain("<old_string>");
        expect(contentText).toContain("old code");
        expect(contentText).toContain("<new_string>");
        expect(contentText).toContain("new code");
    });

    it("formats Write tool input with file path and content", async () => {
        await checkToolSafety("Write", {
            file_path: "/project/new-file.ts",
            content: "file content here",
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        const contentBlocks = body.messages[0].content;
        const contentText = contentBlocks[contentBlocks.length - 1].text;
        expect(contentText).toContain("Tool: Write");
        expect(contentText).toContain("File: /project/new-file.ts");
        expect(contentText).toContain("<content>");
        expect(contentText).toContain("file content here");
    });

    it("formats WebFetch tool input with URL", async () => {
        await checkToolSafety("WebFetch", {
            url: "https://example.com/api",
            prompt: "get the data",
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        const contentBlocks = body.messages[0].content;
        const contentText = contentBlocks[contentBlocks.length - 1].text;
        expect(contentText).toContain("Tool: WebFetch");
        expect(contentText).toContain("URL: https://example.com/api");
    });

    it("formats Agent tool input with prompt and subagent type", async () => {
        await checkToolSafety("Agent", {
            prompt: "search for files",
            subagent_type: "Explore",
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        const contentBlocks = body.messages[0].content;
        const contentText = contentBlocks[contentBlocks.length - 1].text;
        expect(contentText).toContain("Tool: Agent");
        expect(contentText).toContain("Subagent type: Explore");
        expect(contentText).toContain("search for files");
    });

    it("formats MCP tool input as JSON", async () => {
        await checkToolSafety("mcp__server__tool", {
            param1: "value1",
            param2: 42,
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        const contentBlocks = body.messages[0].content;
        const contentText = contentBlocks[contentBlocks.length - 1].text;
        expect(contentText).toContain("Tool: mcp__server__tool");
        expect(contentText).toContain('"param1"');
        expect(contentText).toContain('"value1"');
    });

    it("truncates large Write content", async () => {
        const largeContent = "x".repeat(10000);
        await checkToolSafety("Write", {
            file_path: "/project/big.ts",
            content: largeContent,
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        const contentBlocks = body.messages[0].content;
        const contentText = contentBlocks[contentBlocks.length - 1].text;
        expect(contentText).toContain("... (truncated)");
        expect(contentText.length).toBeLessThan(largeContent.length);
    });
});

// ---------------------------------------------------------------------------
// extractTaskContext
// ---------------------------------------------------------------------------

describe("extractTaskContext", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "safety-ctx-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeTranscript(lines: object[]): string {
        const filePath = path.join(tmpDir, "transcript.jsonl");
        fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
        return filePath;
    }

    it("returns empty string for 'none' context level", () => {
        const p = writeTranscript([{ type: "user", message: { content: "hello" } }]);
        expect(extractTaskContext(p, "none")).toBe("");
    });

    it("returns empty string for missing transcript", () => {
        expect(extractTaskContext("/nonexistent/file.jsonl", "user-only")).toBe("");
    });

    it("returns empty string for empty transcript", () => {
        const p = writeTranscript([]);
        expect(extractTaskContext(p, "user-only")).toBe("");
    });

    it("extracts user messages in user-only mode", () => {
        const p = writeTranscript([
            { type: "user", message: { content: "Fix the auth bug" } },
            { type: "assistant", message: { content: "I will look at the code" } },
            { type: "user", message: { content: "Also check the tests" } },
        ]);
        const ctx = extractTaskContext(p, "user-only");
        expect(ctx).toContain("Fix the auth bug");
        expect(ctx).toContain("Also check the tests");
        expect(ctx).not.toContain("I will look at the code");
        expect(ctx).toContain('<task-context level="user-only">');
    });

    it("includes assistant messages in full mode", () => {
        const p = writeTranscript([
            { type: "user", message: { content: "Fix the auth bug" } },
            { type: "assistant", message: { content: "I will look at the code" } },
        ]);
        const ctx = extractTaskContext(p, "full");
        expect(ctx).toContain("Fix the auth bug");
        expect(ctx).toContain("I will look at the code");
        expect(ctx).toContain("<untrusted-assistant>");
        expect(ctx).toContain('<task-context level="full">');
    });

    it("handles array content blocks", () => {
        const p = writeTranscript([{ type: "user", message: { content: [{ type: "text", text: "array content" }] } }]);
        const ctx = extractTaskContext(p, "user-only");
        expect(ctx).toContain("array content");
    });

    it("includes first user message even if not in recent window", () => {
        const msgs = [
            { type: "user", message: { content: "Initial task" } },
            ...Array.from({ length: 10 }, (_, i) => ({ type: "user", message: { content: `msg ${i}` } })),
        ];
        const p = writeTranscript(msgs);
        const ctx = extractTaskContext(p, "user-only");
        expect(ctx).toContain("[Initial request]");
        expect(ctx).toContain("Initial task");
    });

    it("does not duplicate first message if it is in the recent window", () => {
        const p = writeTranscript([{ type: "user", message: { content: "Only message" } }]);
        const ctx = extractTaskContext(p, "user-only");
        expect(ctx).not.toContain("[Initial request]");
        expect(ctx).toContain("Only message");
    });

    it("skips malformed JSON lines gracefully", () => {
        const filePath = path.join(tmpDir, "bad.jsonl");
        fs.writeFileSync(filePath, 'not json\n{"type":"user","message":{"content":"valid"}}\n');
        const ctx = extractTaskContext(filePath, "user-only");
        expect(ctx).toContain("valid");
    });

    it("returns empty string for empty transcript path", () => {
        expect(extractTaskContext("", "user-only")).toBe("");
    });
});

// ---------------------------------------------------------------------------
// Block count tracking
// ---------------------------------------------------------------------------

describe("block count tracking", () => {
    const testSessionId = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const blockDir = path.join(os.tmpdir(), "claude-safety-hook");

    afterEach(() => {
        try {
            fs.unlinkSync(path.join(blockDir, `${testSessionId}.json`));
        } catch {
            // may not exist
        }
    });

    it("returns zero state for unknown session", () => {
        const state = getBlockState(testSessionId);
        expect(state.consecutiveDenials).toBe(0);
        expect(state.totalDenials).toBe(0);
    });

    it("increments both counters", () => {
        const s1 = incrementBlockCount(testSessionId);
        expect(s1.consecutiveDenials).toBe(1);
        expect(s1.totalDenials).toBe(1);

        const s2 = incrementBlockCount(testSessionId);
        expect(s2.consecutiveDenials).toBe(2);
        expect(s2.totalDenials).toBe(2);
    });

    it("resets consecutive but not total on approve", () => {
        incrementBlockCount(testSessionId);
        incrementBlockCount(testSessionId);
        resetConsecutiveBlocks(testSessionId);

        const state = getBlockState(testSessionId);
        expect(state.consecutiveDenials).toBe(0);
        expect(state.totalDenials).toBe(2);
    });

    it("degrades after 3 consecutive denials", () => {
        expect(shouldDegradeToPrompt({ consecutiveDenials: 2, totalDenials: 2 })).toBe(false);
        expect(shouldDegradeToPrompt({ consecutiveDenials: 3, totalDenials: 3 })).toBe(true);
    });

    it("degrades after 20 total denials", () => {
        expect(shouldDegradeToPrompt({ consecutiveDenials: 0, totalDenials: 19 })).toBe(false);
        expect(shouldDegradeToPrompt({ consecutiveDenials: 0, totalDenials: 20 })).toBe(true);
    });

    it("processHookInput degrades deny to prompt after threshold", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        // Each invocation needs two fetch calls: S1 escalates (XML yes), S2 denies (JSON).
        // Mock alternates: odd calls = S1 XML, even calls = S2 JSON deny.
        let callCount = 0;
        mockFetch.mockImplementation(() => {
            callCount++;
            const isS1 = callCount % 2 === 1;
            const text = isS1 ? "<block>yes</block>" : '{"decision":"deny","reason":"Dangerous"}';
            return Promise.resolve({
                ok: true,
                status: 200,
                text: async () => "",
                json: async () => ({ content: [{ type: "text", text }] }),
            });
        });

        const sessionId = `degrade-test-${Date.now()}`;

        // First 3 denials should be hard deny
        for (let i = 0; i < 3; i++) {
            const result = await processHookInput({
                tool_name: "Bash",
                tool_input: { command: "rm -rf /" },
                session_id: sessionId,
            });
            if (i < 2) {
                expect(result?.decision).toBe("deny");
            }
        }

        // After 3 consecutive, should degrade to null (prompt/fall-through)
        const degraded = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "rm -rf /" },
            session_id: sessionId,
        });
        expect(degraded).toBeNull();

        // Cleanup
        try {
            fs.unlinkSync(path.join(blockDir, `${sessionId}.json`));
        } catch {
            // ignore
        }
    });
});

// ---------------------------------------------------------------------------
// Prompt caching
// ---------------------------------------------------------------------------

describe("prompt caching", () => {
    beforeEach(() => {
        mockGetApiKey.mockReturnValue("test-key");
        // S1 approves via XML so the chain completes with one call
        mockFetch.mockResolvedValue(mockS1Response("no"));
    });

    it("attaches cache_control to all system blocks", async () => {
        await checkToolSafety("Bash", { command: "ls -la" });
        expect(mockFetch).toHaveBeenCalled();
        const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
        expect(body.system).toBeInstanceOf(Array);
        expect(body.system.length).toBeGreaterThanOrEqual(2);
        for (const block of body.system) {
            expect(block.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
        }
    });

    it("attaches cache_control to action message block", async () => {
        await checkToolSafety("Bash", { command: "ls -la" });
        const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].content).toBeInstanceOf(Array);
        const lastBlock = body.messages[0].content[body.messages[0].content.length - 1];
        expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    });
});

// ---------------------------------------------------------------------------
// user rules end-to-end (regression for configGet string coercion bug)
// ---------------------------------------------------------------------------

describe("user rules end-to-end", () => {
    let previousUserRules: unknown;

    beforeEach(() => {
        // Save any pre-existing safety.user_rules so we can restore it after the test
        previousUserRules = configGetObject("safety.user_rules");
        // Write a test user_rules object - this exercises configSetObject
        configSetObject("safety.user_rules", { block_rules: ["TEST_RULE_BLOCK_MARKER"] });
        mockGetApiKey.mockReturnValue("test-key");
        // S1 approves via XML so the chain completes with one call
        mockFetch.mockResolvedValue(mockS1Response("no"));
    });

    afterEach(() => {
        // Restore original value (or delete the key by setting undefined/null)
        if (previousUserRules === undefined) {
            // Remove the key we added - write null to clear it
            configSetObject("safety.user_rules", undefined);
        } else {
            configSetObject("safety.user_rules", previousUserRules);
        }
    });

    it("includes user block_rules bullet in the system prompt sent to the API", async () => {
        await checkToolSafety("Bash", { command: "ls" });

        expect(mockFetch).toHaveBeenCalledOnce();
        const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);

        // system[0] is the billing header block, system[1] is the safety prompt text
        expect(body.system).toBeInstanceOf(Array);
        expect(body.system.length).toBeGreaterThanOrEqual(2);
        const systemPromptText: string = body.system[1].text;
        expect(systemPromptText).toContain("- TEST_RULE_BLOCK_MARKER");
    });
});

// ---------------------------------------------------------------------------
// approval cache integration
// ---------------------------------------------------------------------------

describe("approval cache integration", () => {
    beforeEach(() => {
        approvalCache.clear();
        mockGetApiKey.mockReturnValue("test-key");
    });

    afterEach(() => {
        approvalCache.clear();
    });

    it("repeated identical Bash command skips the API on second call", async () => {
        // S1 approves via XML - one fetch call total for the first invocation
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                JSON.stringify({
                    content: [{ type: "text", text: "<block>no</block>" }],
                })
            )
        );

        const r1 = await checkToolSafety("Bash", { command: "echo hello" });
        const r2 = await checkToolSafety("Bash", { command: "echo hello" });
        expect(r1?.decision).toBe("approve");
        expect(r2?.decision).toBe("approve");
        // Only one API call - the second is served from the approval cache
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("deny is not cached - second identical call hits API again", async () => {
        // Each call: S1 escalates, S2 denies - two fetch calls per invocation
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: "<block>yes</block>" }] })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: '{"decision":"deny","reason":"no"}' }] })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: "<block>yes</block>" }] })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: '{"decision":"deny","reason":"no"}' }] })));

        const r1 = await checkToolSafety("Bash", { command: "rm -rf /" });
        const r2 = await checkToolSafety("Bash", { command: "rm -rf /" });
        expect(r1?.decision).toBe("deny");
        expect(r2?.decision).toBe("deny");
        // 4 calls total: 2 per invocation (S1 + S2), since deny is not cached
        expect(fetchSpy).toHaveBeenCalledTimes(4);
    });
});

// ---------------------------------------------------------------------------
// classifier mode selection
// ---------------------------------------------------------------------------

describe("classifier mode selection", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    afterEach(() => {
        vi.restoreAllMocks();
        approvalCache.clear();
    });
    beforeEach(() => approvalCache.clear());

    it("default mode is two-stage (S1 uses 64-token budget and stop_sequences)", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "<block>no</block>" }] })));
        await checkToolSafety("Bash", { command: "rm something" });
        const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
        expect(body.max_tokens).toBe(64);
        expect(body.stop_sequences).toEqual(["</block>"]);
    });

    it("needs_context two-pass: S1 escalates, S2 returns needs_context, second call resolves", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: "<block>yes</block>" }] })))
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ content: [{ type: "text", text: '{"decision":"needs_context","reason":"check","files":["/tmp/script.sh"]}' }] })
                )
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: [{ type: "text", text: '{"decision":"approve","reason":"ok after inspection"}' }] }))
            );
        const r = await checkToolSafety("Bash", { command: "./script.sh" });
        expect(r?.decision).toBe("approve");
        expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it("single-stage thinking mode uses 4096 budget, no stop_sequences, has thinking", async () => {
        vi.resetModules();
        vi.doMock("../utils.js", async (importOriginal) => {
            const actual = (await importOriginal()) as Record<string, unknown>;
            return {
                ...actual,
                configGet: (k: string, d?: string) => {
                    if (k === "safety.classifier_mode") return "single-stage";
                    if (k === "safety.single_stage_variant") return "thinking";
                    if (k === "safety.billing_cch") return "test";
                    if (k === "safety.billing_cc_version") return "test.0";
                    return d ?? null;
                },
                configGetObject: () => undefined,
            };
        });
        fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: '{"decision":"approve","reason":"ok"}' }] })));
        const mod = await import("../llm-safety-check.js?single-thinking");
        await mod.checkToolSafety("Bash", { command: "rm something" });
        const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
        expect(body.max_tokens).toBe(4096);
        expect(body.stop_sequences).toBeUndefined();
        expect(body.thinking).toEqual({ type: "adaptive" });
        vi.doUnmock("../utils.js");
    });

    it("single-stage fast mode uses 256 budget, has stop_sequences, no thinking", async () => {
        vi.resetModules();
        vi.doMock("../utils.js", async (importOriginal) => {
            const actual = (await importOriginal()) as Record<string, unknown>;
            return {
                ...actual,
                configGet: (k: string, d?: string) => {
                    if (k === "safety.classifier_mode") return "single-stage";
                    if (k === "safety.single_stage_variant") return "fast";
                    if (k === "safety.billing_cch") return "test";
                    if (k === "safety.billing_cc_version") return "test.0";
                    return d ?? null;
                },
                configGetObject: () => undefined,
            };
        });
        fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "<block>no</block>" }] })));
        const mod = await import("../llm-safety-check.js?single-fast");
        await mod.checkToolSafety("Bash", { command: "rm something" });
        const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
        expect(body.max_tokens).toBe(256);
        expect(body.stop_sequences).toEqual(["</block>"]);
        expect(body.thinking).toBeUndefined();
        vi.doUnmock("../utils.js");
    });
});
