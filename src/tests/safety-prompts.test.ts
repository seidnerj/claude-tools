import { describe, it, expect } from "vitest";
import { buildSystemPrompt, SYSTEM_PROMPT, parseXmlVerdict } from "../safety-prompts.js";

describe("buildSystemPrompt", () => {
    it("returns prompt with no user rules and replaces placeholders cleanly", () => {
        const out = buildSystemPrompt();
        expect(out).not.toContain("<user_block_rules>");
        expect(out).not.toContain("<user_allow_rules>");
        expect(out).not.toContain("<user_environment>");
        expect(out).toContain("(none configured)");
    });

    it("injects user-supplied block rules as bullets", () => {
        const out = buildSystemPrompt({ block_rules: ["No production deploys", "No DROP TABLE"] });
        expect(out).toContain("- No production deploys");
        expect(out).toContain("- No DROP TABLE");
    });

    it("injects user-supplied allow rules", () => {
        const out = buildSystemPrompt({ allow_rules: ["Reading from internal docs"] });
        expect(out).toContain("- Reading from internal docs");
    });

    it("injects environment lines and replaces the (none configured) default", () => {
        const out = buildSystemPrompt({ environment: ["repo: github.com/me/proj", "bucket: s3://my-bucket"] });
        expect(out).toContain("- repo: github.com/me/proj");
        expect(out).toContain("- bucket: s3://my-bucket");
        expect(out).not.toContain("(none configured)");
    });

    it("base SYSTEM_PROMPT still contains placeholders before substitution", () => {
        expect(SYSTEM_PROMPT).toContain("<user_block_rules>");
        expect(SYSTEM_PROMPT).toContain("<user_allow_rules>");
        expect(SYSTEM_PROMPT).toContain("<user_environment>");
    });
});

describe("parseXmlVerdict", () => {
    it("parses <block>yes</block>", () => {
        expect(parseXmlVerdict("<block>yes</block>")).toEqual({ block: "yes" });
    });

    it("parses <block>no</block>", () => {
        expect(parseXmlVerdict("<block>no</block>")).toEqual({ block: "no" });
    });

    it("parses block plus reason", () => {
        const out = parseXmlVerdict("<block>yes</block><reason>Too dangerous</reason>");
        expect(out.block).toBe("yes");
        expect(out.reason).toBe("Too dangerous");
    });

    it("parses thinking before block", () => {
        const out = parseXmlVerdict("<thinking>weighing options</thinking><block>no</block>");
        expect(out.thinking).toBe("weighing options");
        expect(out.block).toBe("no");
    });

    it("tolerates leading/trailing whitespace", () => {
        expect(parseXmlVerdict("  <block>yes</block>  ").block).toBe("yes");
    });

    it("tolerates missing closing tag (when stop_sequence truncated output)", () => {
        expect(parseXmlVerdict("<block>yes").block).toBe("yes");
    });

    it("returns block: null on garbage input", () => {
        expect(parseXmlVerdict("not xml").block).toBeNull();
    });

    it("is case-insensitive on yes/no", () => {
        expect(parseXmlVerdict("<block>YES</block>").block).toBe("yes");
        expect(parseXmlVerdict("<block>No</block>").block).toBe("no");
    });

    it("trims whitespace inside reason and thinking tags", () => {
        const out = parseXmlVerdict("<block>yes</block><reason>\n  spaced\n</reason>");
        expect(out.reason).toBe("spaced");
    });

    it("returns block: null when only thinking is present (no <block>)", () => {
        expect(parseXmlVerdict("<thinking>contemplating</thinking>").block).toBeNull();
    });
});
