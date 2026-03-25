import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseStatusRss, parseStatusSummary, getClaudeStatus } from "../claude-status.js";

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Claude Status - Incident History</title>
    <link>https://status.claude.com</link>
    <description>Statuspage</description>
    <pubDate>Tue, 25 Mar 2026 13:10:09 +0000</pubDate>
    <item>
      <title>Elevated errors on Claude Opus 4</title>
      <description>&lt;p&gt;&lt;small&gt;Mar 25, 13:10 UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Resolved&lt;/strong&gt; - This incident has been resolved.&lt;/p&gt;&lt;p&gt;&lt;small&gt;Mar 25, 09:35 UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Investigating&lt;/strong&gt; - We are investigating this issue.&lt;/p&gt;</description>
      <pubDate>Tue, 25 Mar 2026 13:10:09 +0000</pubDate>
      <link>https://status.claude.com/incidents/abc123</link>
      <guid>https://status.claude.com/incidents/abc123</guid>
    </item>
    <item>
      <title>API latency increase</title>
      <description>&lt;p&gt;&lt;small&gt;Mar 24, 18:00 UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Investigating&lt;/strong&gt; - We are looking into elevated API latency.&lt;/p&gt;</description>
      <pubDate>Mon, 24 Mar 2026 18:00:00 +0000</pubDate>
      <link>https://status.claude.com/incidents/def456</link>
      <guid>https://status.claude.com/incidents/def456</guid>
    </item>
    <item>
      <title>Old resolved incident</title>
      <description>&lt;p&gt;&lt;small&gt;Mar 20, 12:00 UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Resolved&lt;/strong&gt; - All clear.&lt;/p&gt;</description>
      <pubDate>Thu, 20 Mar 2026 12:00:00 +0000</pubDate>
      <link>https://status.claude.com/incidents/ghi789</link>
      <guid>https://status.claude.com/incidents/ghi789</guid>
    </item>
  </channel>
</rss>`;

const SAMPLE_SUMMARY = {
    page: { id: "abc", name: "Claude", url: "https://status.claude.com", updated_at: "2026-03-25T13:10:09.725Z" },
    status: { indicator: "none", description: "All Systems Operational" },
    components: [
        { name: "claude.ai", status: "operational", showcase: true },
        { name: "Claude API (api.anthropic.com)", status: "operational", showcase: true },
        { name: "Claude Code", status: "operational", showcase: true },
    ],
    incidents: [],
    scheduled_maintenances: [],
};

const DEGRADED_SUMMARY = {
    ...SAMPLE_SUMMARY,
    status: { indicator: "major", description: "Major System Outage" },
    components: [
        { name: "claude.ai", status: "major_outage", showcase: true },
        { name: "Claude API (api.anthropic.com)", status: "operational", showcase: true },
    ],
    incidents: [{ name: "Claude.ai is down" }],
};

// ---------------------------------------------------------------------------
// parseStatusSummary
// ---------------------------------------------------------------------------

describe("parseStatusSummary", () => {
    it("parses a healthy summary", () => {
        const result = parseStatusSummary(SAMPLE_SUMMARY);
        expect(result.indicator).toBe("none");
        expect(result.description).toBe("All Systems Operational");
        expect(result.components).toHaveLength(3);
        expect(result.components[0]).toEqual({ name: "claude.ai", status: "operational" });
        expect(result.activeIncidents).toHaveLength(0);
        expect(result.scheduledMaintenances).toHaveLength(0);
        expect(result.updatedAt).toBe("2026-03-25T13:10:09.725Z");
    });

    it("parses a degraded summary with active incidents", () => {
        const result = parseStatusSummary(DEGRADED_SUMMARY);
        expect(result.indicator).toBe("major");
        expect(result.description).toBe("Major System Outage");
        expect(result.activeIncidents).toEqual(["Claude.ai is down"]);
        expect(result.components[0].status).toBe("major_outage");
    });

    it("handles missing fields gracefully", () => {
        const result = parseStatusSummary({});
        expect(result.indicator).toBe("unknown");
        expect(result.description).toBe("Unknown");
        expect(result.components).toHaveLength(0);
        expect(result.activeIncidents).toHaveLength(0);
    });

    it("filters out non-showcase components", () => {
        const withHidden = {
            ...SAMPLE_SUMMARY,
            components: [
                { name: "Visible", status: "operational", showcase: true },
                { name: "Hidden", status: "operational", showcase: false },
            ],
        };
        const result = parseStatusSummary(withHidden);
        expect(result.components).toHaveLength(1);
        expect(result.components[0].name).toBe("Visible");
    });

    it("includes scheduled maintenances", () => {
        const withMaint = {
            ...SAMPLE_SUMMARY,
            scheduled_maintenances: [{ name: "Database upgrade" }, { name: "Network maintenance" }],
        };
        const result = parseStatusSummary(withMaint);
        expect(result.scheduledMaintenances).toEqual(["Database upgrade", "Network maintenance"]);
    });
});

// ---------------------------------------------------------------------------
// parseStatusRss
// ---------------------------------------------------------------------------

describe("parseStatusRss", () => {
    it("parses incidents from RSS XML", () => {
        const result = parseStatusRss(SAMPLE_RSS);
        expect(result.incidents).toHaveLength(3);
        expect(result.feedDate).toBe("2026-03-25T13:10:09.000Z");
    });

    it("extracts incident fields correctly", () => {
        const result = parseStatusRss(SAMPLE_RSS);
        const first = result.incidents[0];
        expect(first.title).toBe("Elevated errors on Claude Opus 4");
        expect(first.link).toBe("https://status.claude.com/incidents/abc123");
        expect(first.pubDate).toBe("2026-03-25T13:10:09.000Z");
        expect(first.currentStatus).toBe("Resolved");
    });

    it("parses status updates within an incident", () => {
        const result = parseStatusRss(SAMPLE_RSS);
        const first = result.incidents[0];
        expect(first.updates).toHaveLength(2);
        expect(first.updates[0].status).toBe("Resolved");
        expect(first.updates[0].message).toBe("This incident has been resolved.");
        expect(first.updates[1].status).toBe("Investigating");
        expect(first.updates[1].message).toBe("We are investigating this issue.");
    });

    it("handles empty feed", () => {
        const empty = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Claude Status</title>
    <pubDate>Tue, 25 Mar 2026 00:00:00 +0000</pubDate>
  </channel>
</rss>`;
        const result = parseStatusRss(empty);
        expect(result.incidents).toHaveLength(0);
    });

    it("handles HTML entities in title", () => {
        const withEntities = SAMPLE_RSS.replace("Elevated errors on Claude Opus 4", "Errors on Claude &amp; API &lt;v2&gt;");
        const result = parseStatusRss(withEntities);
        expect(result.incidents[0].title).toBe("Errors on Claude & API <v2>");
    });

    it("sets currentStatus to Unknown when description has no updates", () => {
        const noUpdates = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Claude Status</title>
    <pubDate>Tue, 25 Mar 2026 00:00:00 +0000</pubDate>
    <item>
      <title>Mystery incident</title>
      <description>No structured updates here</description>
      <pubDate>Tue, 25 Mar 2026 00:00:00 +0000</pubDate>
      <link>https://status.claude.com/incidents/zzz</link>
      <guid>https://status.claude.com/incidents/zzz</guid>
    </item>
  </channel>
</rss>`;
        const result = parseStatusRss(noUpdates);
        expect(result.incidents[0].currentStatus).toBe("Unknown");
        expect(result.incidents[0].updates).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// getClaudeStatus
// ---------------------------------------------------------------------------

function mockFetch(summaryJson: unknown, rssXml: string) {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
            if (url.includes("summary.json")) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve(summaryJson) });
            }
            return Promise.resolve({ ok: true, text: () => Promise.resolve(rssXml) });
        })
    );
}

function mockFetchSummaryFail(rssXml: string) {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
            if (url.includes("summary.json")) {
                return Promise.resolve({ ok: false, status: 503 });
            }
            return Promise.resolve({ ok: true, text: () => Promise.resolve(rssXml) });
        })
    );
}

describe("getClaudeStatus", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("fetches both summary and RSS", async () => {
        mockFetch(SAMPLE_SUMMARY, SAMPLE_RSS);
        const result = await getClaudeStatus();
        expect(result.summary).not.toBeNull();
        expect(result.summary!.indicator).toBe("none");
        expect(result.incidentCount).toBe(3);
        expect(result.operational).toBe(true);
    });

    it("uses summary indicator for operational status", async () => {
        mockFetch(DEGRADED_SUMMARY, SAMPLE_RSS);
        const result = await getClaudeStatus();
        expect(result.operational).toBe(false);
        expect(result.summary!.indicator).toBe("major");
    });

    it("falls back to RSS-based operational check when summary fails", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-03-25T14:00:00Z"));
        try {
            mockFetchSummaryFail(SAMPLE_RSS);
            const result = await getClaudeStatus();
            expect(result.summary).toBeNull();
            expect(result.operational).toBe(false);
            expect(result.incidentCount).toBe(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it("throws when both fetches fail", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
        await expect(getClaudeStatus()).rejects.toThrow("Failed to fetch Claude status");
    });

    it("filters by maxIncidents", async () => {
        mockFetch(SAMPLE_SUMMARY, SAMPLE_RSS);
        const result = await getClaudeStatus({ maxIncidents: 1 });
        expect(result.incidentCount).toBe(1);
        expect(result.incidents[0].title).toBe("Elevated errors on Claude Opus 4");
    });

    it("filters by statusFilter", async () => {
        mockFetch(SAMPLE_SUMMARY, SAMPLE_RSS);
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-03-25T14:00:00Z"));
        try {
            const result = await getClaudeStatus({ statusFilter: "investigating" });
            expect(result.incidentCount).toBe(1);
            expect(result.incidents[0].title).toBe("API latency increase");
        } finally {
            vi.useRealTimers();
        }
    });

    it("filters by daysBack", async () => {
        mockFetch(SAMPLE_SUMMARY, SAMPLE_RSS);
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-03-25T14:00:00Z"));
        try {
            const result = await getClaudeStatus({ daysBack: 2 });
            expect(result.incidentCount).toBe(2);
            expect(result.incidents.every((i) => i.title !== "Old resolved incident")).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("combines multiple filters", async () => {
        mockFetch(SAMPLE_SUMMARY, SAMPLE_RSS);
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-03-25T14:00:00Z"));
        try {
            const result = await getClaudeStatus({ statusFilter: "resolved", maxIncidents: 1 });
            expect(result.incidentCount).toBe(1);
            expect(result.incidents[0].currentStatus).toBe("Resolved");
        } finally {
            vi.useRealTimers();
        }
    });

    it("includes active incidents from summary", async () => {
        mockFetch(DEGRADED_SUMMARY, SAMPLE_RSS);
        const result = await getClaudeStatus();
        expect(result.summary!.activeIncidents).toEqual(["Claude.ai is down"]);
    });
});
