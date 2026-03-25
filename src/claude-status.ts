// ---------------------------------------------------------------------------
// Claude status page - fetch real-time status and incident history
// ---------------------------------------------------------------------------

import type { StatusIncident, StatusUpdate, StatusSummary, StatusResult } from "./types.js";

const STATUS_SUMMARY_URL = "https://status.claude.com/api/v2/summary.json";
const STATUS_RSS_URL = "https://status.claude.com/history.rss";

// ---------------------------------------------------------------------------
// Summary JSON parsing (real-time status)
// ---------------------------------------------------------------------------

interface RawSummaryJson {
    page?: { updated_at?: string };
    status?: { indicator?: string; description?: string };
    components?: Array<{ name?: string; status?: string; showcase?: boolean }>;
    incidents?: Array<{ name?: string }>;
    scheduled_maintenances?: Array<{ name?: string }>;
}

/** Parse the summary JSON response into a StatusSummary. */
export function parseStatusSummary(json: RawSummaryJson): StatusSummary {
    return {
        indicator: json.status?.indicator ?? "unknown",
        description: json.status?.description ?? "Unknown",
        components: (json.components ?? [])
            .filter((c) => c.showcase !== false)
            .map((c) => ({
                name: c.name ?? "Unknown",
                status: c.status ?? "unknown",
            })),
        activeIncidents: (json.incidents ?? []).map((i) => i.name ?? "Unknown incident"),
        scheduledMaintenances: (json.scheduled_maintenances ?? []).map((m) => m.name ?? "Unknown maintenance"),
        updatedAt: json.page?.updated_at ?? new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// RSS parsing (incident history)
// ---------------------------------------------------------------------------

/** Parse an RFC 2822 date string to ISO 8601. */
function rfc2822ToIso(dateStr: string): string {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toISOString();
}

/** Decode HTML entities (&lt; &gt; &amp; &quot; &#39; &#NNN; &#xHH;). */
function decodeEntities(html: string): string {
    const named: Record<string, string> = {
        "&lt;": "<",
        "&gt;": ">",
        "&amp;": "&",
        "&quot;": '"',
        "&#39;": "'",
        "&apos;": "'",
    };
    return html
        .replace(/&(?:lt|gt|amp|quot|apos|#39);/g, (m) => named[m] ?? m)
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Extract the text content between a pair of XML tags (first occurrence). */
function xmlTag(xml: string, tag: string): string {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const start = xml.indexOf(open);
    if (start === -1) return "";
    const end = xml.indexOf(close, start + open.length);
    if (end === -1) return "";
    return xml.slice(start + open.length, end).trim();
}

/**
 * Parse status updates from an incident's HTML description.
 *
 * Each update is a `<p>` block with structure:
 *   <p><small>Mar 25, 09:35 UTC</small><br><strong>Investigating</strong> - message text</p>
 */
function parseUpdates(descriptionHtml: string, pubYear: number): StatusUpdate[] {
    const updates: StatusUpdate[] = [];

    const paragraphs = descriptionHtml.split(/<\/?p>/i).filter((s) => s.trim());

    for (const p of paragraphs) {
        const smallMatch = p.match(/<small>(.*?)<\/small>/i);
        const strongMatch = p.match(/<strong>(.*?)<\/strong>/i);
        if (!smallMatch || !strongMatch) continue;

        const rawTs = smallMatch[1].trim();
        const status = strongMatch[1].trim();

        const afterStrong = p.slice(p.indexOf("</strong>") + "</strong>".length);
        const message = afterStrong
            .replace(/^\s*-\s*/, "")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .trim();

        const tsWithYear = `${rawTs.replace(" UTC", "")} ${pubYear} UTC`;
        const parsed = new Date(tsWithYear);
        const timestamp = isNaN(parsed.getTime()) ? rawTs : parsed.toISOString();

        updates.push({ timestamp, status, message });
    }

    return updates;
}

/** Parse the raw RSS XML into incident history. */
export function parseStatusRss(xml: string): { feedDate: string; incidents: StatusIncident[] } {
    const feedDate = rfc2822ToIso(xmlTag(xml, "pubDate"));

    const incidents: StatusIncident[] = [];
    let pos = 0;
    while (true) {
        const itemStart = xml.indexOf("<item>", pos);
        if (itemStart === -1) break;
        const itemEnd = xml.indexOf("</item>", itemStart);
        if (itemEnd === -1) break;
        const itemXml = xml.slice(itemStart, itemEnd + "</item>".length);
        pos = itemEnd + "</item>".length;

        const title = decodeEntities(xmlTag(itemXml, "title"));
        const link = xmlTag(itemXml, "link");
        const rawPubDate = xmlTag(itemXml, "pubDate");
        const pubDate = rfc2822ToIso(rawPubDate);
        const descriptionRaw = xmlTag(itemXml, "description");
        const descriptionHtml = decodeEntities(descriptionRaw);

        const pubYear = new Date(rawPubDate).getFullYear() || new Date().getFullYear();
        const updates = parseUpdates(descriptionHtml, pubYear);
        const currentStatus = updates.length > 0 ? updates[0].status : "Unknown";

        incidents.push({ title, link, pubDate, currentStatus, updates });
    }

    return { feedDate, incidents };
}

// ---------------------------------------------------------------------------
// Combined status fetcher
// ---------------------------------------------------------------------------

/** Options for fetching Claude status. */
export interface GetStatusOptions {
    /** Maximum number of history incidents to return (default: all). */
    maxIncidents?: number;
    /** Only return incidents with this status (case-insensitive). */
    statusFilter?: string;
    /** Only return incidents from the last N days. */
    daysBack?: number;
}

/** Fetch Claude's real-time status and incident history. */
export async function getClaudeStatus(options: GetStatusOptions = {}): Promise<StatusResult> {
    const [summaryResult, rssResult] = await Promise.allSettled([
        fetch(STATUS_SUMMARY_URL).then(async (resp) => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return (await resp.json()) as RawSummaryJson;
        }),
        fetch(STATUS_RSS_URL).then(async (resp) => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp.text();
        }),
    ]);

    if (summaryResult.status === "rejected" && rssResult.status === "rejected") {
        throw new Error(`Failed to fetch Claude status: summary (${summaryResult.reason}), RSS (${rssResult.reason})`);
    }

    const summary = summaryResult.status === "fulfilled" ? parseStatusSummary(summaryResult.value) : null;

    let feedDate = "";
    let incidents: StatusIncident[] = [];
    if (rssResult.status === "fulfilled") {
        const parsed = parseStatusRss(rssResult.value);
        feedDate = parsed.feedDate;
        incidents = parsed.incidents;
    }

    let filtered = incidents;

    if (options.daysBack != null) {
        const cutoff = Date.now() - options.daysBack * 24 * 60 * 60 * 1000;
        filtered = filtered.filter((inc) => new Date(inc.pubDate).getTime() > cutoff);
    }

    if (options.statusFilter) {
        const f = options.statusFilter.toLowerCase();
        filtered = filtered.filter((inc) => inc.currentStatus.toLowerCase() === f);
    }

    if (options.maxIncidents != null && options.maxIncidents > 0) {
        filtered = filtered.slice(0, options.maxIncidents);
    }

    const operational = summary
        ? summary.indicator === "none"
        : !incidents.some((inc) => {
              const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
              const isRecent = new Date(inc.pubDate).getTime() > recentCutoff;
              const isUnresolved = inc.currentStatus.toLowerCase() !== "resolved";
              return isRecent && isUnresolved;
          });

    return {
        summary,
        operational,
        incidentCount: filtered.length,
        incidents: filtered,
        feedDate,
    };
}
