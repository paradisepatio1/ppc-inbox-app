import { useState } from "react";

const BRAND = {
  navy: "#1E3246",
  teal: "#46828C",
  light: "#78B4BE",
  gold: "#C9A84C",
  bg: "#0f1e2b",
  surface: "#162636",
  surface2: "#1d3448",
  text: "#e8f4f6",
  muted: "#7a9baa",
};

const GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1";
const DRIVE_MCP_URL = "https://drivemcp.googleapis.com/mcp/v1";

const CATEGORIES = {
  leads:   { label: "Leads",              icon: "👤", color: BRAND.gold,    query: "patio cover estimate quote inquiry" },
  quotes:  { label: "Quotes",             icon: "📋", color: BRAND.light,   query: "quote proposal estimate patio cover" },
  permits: { label: "Permits & Plan Check",icon: "🏗️", color: "#e07b4a",    query: "permit plan check correction building department" },
};

// ─── API helpers ────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";

async function callClaude(messages, systemPrompt, mcpServers) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ANTHROPIC_API_KEY ? { "x-api-key": ANTHROPIC_API_KEY } : {}),
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemPrompt,
      messages,
      mcp_servers: mcpServers,
    }),
  });
  return res.json();
}

function extractText(data) {
  if (!data?.content) return "";
  return data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

function parseJSON(data) {
  const blocks = data?.content || [];
  for (const b of blocks) {
    if (b.type !== "text") continue;
    try {
      const clean = b.text.replace(/```json|```/g, "").trim();
      const val = JSON.parse(clean);
      if (val) return val;
    } catch {}
  }
  // fallback: tool results
  for (const b of blocks) {
    if (b.type !== "mcp_tool_result") continue;
    try {
      const raw = b?.content?.[0]?.text || "";
      const val = JSON.parse(raw.replace(/```json|```/g, "").trim());
      if (val) return val;
    } catch {}
  }
  return null;
}

// ─── Drive helpers ──────────────────────────────────────────────────────────

async function searchDriveForJob(keyword) {
  // Look inside the "Engineering for jobs" folder for a matching client subfolder
  const data = await callClaude(
    [{ role: "user", content: `I have a Google Drive folder called "Engineering for jobs" that contains subfolders named by client or job address. Using the Drive MCP: 1) Find the folder named "Engineering for jobs". 2) Search inside it for a subfolder matching this keyword: "${keyword}". 3) Return the matching subfolder and up to 3 files inside it. Return ONLY a JSON array (no markdown) with fields: name, id, mimeType, webViewLink. If nothing found return [].` }],
    `You are an assistant for Paradise Patio Covers. Use the Google Drive MCP tools. First find the "Engineering for jobs" parent folder, then search within it for the client match. Return ONLY a JSON array (no markdown, no preamble) with fields: name, id, mimeType, webViewLink. If nothing found return [].`,
    [{ type: "url", url: DRIVE_MCP_URL, name: "drive-mcp" }]
  );
  return parseJSON(data) || [];
}

async function saveToDrive(filename, content) {
  const data = await callClaude(
    [{ role: "user", content: `Create a new Google Doc in Google Drive named "${filename}" with this content:\n\n${content}` }],
    `You are an assistant for Paradise Patio Covers. Use the Google Drive MCP to create a file. Return ONLY a JSON object (no markdown) with fields: id, name, webViewLink.`,
    [{ type: "url", url: DRIVE_MCP_URL, name: "drive-mcp" }]
  );
  return parseJSON(data);
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function Pill({ label, color }) {
  return (
    <span style={{
      background: color + "22", border: `1px solid ${color}55`,
      color, borderRadius: 4, padding: "2px 7px", fontSize: 10,
      fontWeight: 700, letterSpacing: "0.07em", fontFamily: "monospace",
      textTransform: "uppercase",
    }}>{label}</span>
  );
}

function DrivePanel({ files, loading, onSave, saveState }) {
  if (loading) return (
    <div style={{ marginTop: 10, fontSize: 12, color: BRAND.muted }}>🔍 Searching Drive...</div>
  );
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, color: BRAND.muted, marginBottom: 6, fontFamily: "monospace",
        letterSpacing: "0.08em", textTransform: "uppercase" }}>📁 Engineering for Jobs — Drive Files</div>
      {files.length === 0 ? (
        <div style={{ fontSize: 12, color: BRAND.muted }}>No matching Drive files found.</div>
      ) : (
        files.map(f => (
          <a key={f.id} href={f.webViewLink} target="_blank" rel="noreferrer"
            style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4,
              color: BRAND.light, fontSize: 12, textDecoration: "none" }}
            onMouseEnter={e => e.currentTarget.style.color = "#fff"}
            onMouseLeave={e => e.currentTarget.style.color = BRAND.light}>
            <span>{f.mimeType?.includes("folder") ? "📂" : "📄"}</span>
            <span style={{ textDecoration: "underline" }}>{f.name}</span>
          </a>
        ))
      )}
      {onSave && (
        <button onClick={onSave} disabled={!!saveState}
          style={{ marginTop: 8, background: "transparent",
            border: `1px solid ${BRAND.gold}`, color: BRAND.gold,
            borderRadius: 6, padding: "4px 12px", fontSize: 11,
            fontWeight: 700, cursor: saveState ? "not-allowed" : "pointer",
            opacity: saveState === "saving" ? 0.6 : 1,
          }}>
          {saveState === "saving" ? "Saving..." : saveState === "saved" ? "✓ Saved to Drive" : "💾 Save Quote to Drive"}
        </button>
      )}
    </div>
  );
}

function ThreadCard({ thread, onDraft, onSelect, selected }) {
  const catInfo = CATEGORIES[thread.category] || {};
  const [driveFiles, setDriveFiles] = useState(null);
  const [driveLoading, setDriveLoading] = useState(false);

  async function loadDrive() {
    if (driveFiles !== null) return;
    setDriveLoading(true);
    const keyword = thread.subject || thread.from || "";
    const files = await searchDriveForJob(keyword);
    setDriveFiles(files);
    setDriveLoading(false);
  }

  function handleSelect() {
    onSelect(thread);
    loadDrive();
  }

  return (
    <div onClick={handleSelect} style={{
      background: selected ? BRAND.surface2 : BRAND.surface,
      border: `1px solid ${selected ? catInfo.color || BRAND.teal : "rgba(70,130,140,0.2)"}`,
      borderLeft: `3px solid ${catInfo.color || BRAND.teal}`,
      borderRadius: 8, padding: "14px 16px", cursor: "pointer",
      transition: "all 0.15s ease", marginBottom: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 13 }}>{catInfo.icon}</span>
            <Pill label={catInfo.label} color={catInfo.color || BRAND.teal} />
          </div>
          <div style={{ fontWeight: 600, color: BRAND.text, fontSize: 14, marginBottom: 3,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {thread.subject || "(No subject)"}
          </div>
          <div style={{ color: BRAND.muted, fontSize: 12, whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "ellipsis" }}>
            {thread.from}
          </div>
        </div>
        <button onClick={e => { e.stopPropagation(); onDraft(thread); }}
          style={{ background: "transparent", border: `1px solid ${catInfo.color || BRAND.teal}`,
            color: catInfo.color || BRAND.teal, borderRadius: 6, padding: "4px 10px",
            fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
            letterSpacing: "0.05em", transition: "all 0.15s", flexShrink: 0 }}
          onMouseEnter={e => { e.target.style.background = catInfo.color || BRAND.teal; e.target.style.color = "#fff"; }}
          onMouseLeave={e => { e.target.style.background = "transparent"; e.target.style.color = catInfo.color || BRAND.teal; }}>
          Draft Reply
        </button>
      </div>

      {thread.snippet && (
        <div style={{ marginTop: 8, color: BRAND.muted, fontSize: 12, lineHeight: 1.5,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {thread.snippet}
        </div>
      )}
      {thread.action && (
        <div style={{ marginTop: 8, background: "rgba(201,168,76,0.1)",
          border: "1px solid rgba(201,168,76,0.3)", borderRadius: 5,
          padding: "5px 10px", fontSize: 11, color: BRAND.gold }}>
          ⚡ {thread.action}
        </div>
      )}

      {/* Drive panel — only shown when selected */}
      {selected && (
        <DrivePanel files={driveFiles || []} loading={driveLoading} />
      )}
    </div>
  );
}

function DraftModal({ draft, onClose }) {
  const [copied, setCopied] = useState(false);
  const [saveState, setSaveState] = useState(null); // null | "saving" | "saved" | {link}

  if (!draft) return null;

  async function handleSave() {
    setSaveState("saving");
    const filename = `PPC Quote — ${draft.subject || "Reply"} — ${new Date().toLocaleDateString()}`;
    const result = await saveToDrive(filename, draft.text);
    setSaveState(result?.webViewLink ? { link: result.webViewLink } : "saved");
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: BRAND.surface, border: `1px solid ${BRAND.teal}`,
        borderRadius: 12, maxWidth: 620, width: "100%", maxHeight: "82vh",
        display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: `1px solid rgba(70,130,140,0.3)`,
          display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 700, color: BRAND.text, fontSize: 15 }}>✉️ Draft Reply</div>
          <button onClick={onClose} style={{ background: "none", border: "none",
            color: BRAND.muted, cursor: "pointer", fontSize: 22, lineHeight: 1 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
          {draft.loading ? (
            <div style={{ color: BRAND.muted, textAlign: "center", padding: 40 }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>✍️</div>
              Drafting reply...
            </div>
          ) : (
            <pre style={{ fontFamily: "inherit", whiteSpace: "pre-wrap", color: BRAND.text,
              fontSize: 13, lineHeight: 1.7, margin: 0 }}>{draft.text}</pre>
          )}
        </div>

        {/* Footer */}
        {!draft.loading && (
          <div style={{ padding: "12px 20px", borderTop: `1px solid rgba(70,130,140,0.3)`,
            display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={() => { navigator.clipboard.writeText(draft.text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              style={{ background: BRAND.teal, border: "none", color: "#fff",
                borderRadius: 7, padding: "8px 18px", fontWeight: 700, cursor: "pointer", fontSize: 13 }}>
              {copied ? "✓ Copied!" : "Copy"}
            </button>
            <button onClick={handleSave} disabled={!!saveState}
              style={{ background: "transparent", border: `1px solid ${BRAND.gold}`,
                color: BRAND.gold, borderRadius: 7, padding: "8px 18px",
                fontWeight: 700, cursor: saveState ? "not-allowed" : "pointer", fontSize: 13,
                opacity: saveState === "saving" ? 0.6 : 1 }}>
              {saveState === "saving" ? "Saving..." : saveState?.link ? "✓ Saved!" : "💾 Save to Drive"}
            </button>
            {saveState?.link && (
              <a href={saveState.link} target="_blank" rel="noreferrer"
                style={{ fontSize: 12, color: BRAND.light, textDecoration: "underline" }}>
                Open in Drive ↗
              </a>
            )}
            <button onClick={onClose} style={{ background: "transparent",
              border: `1px solid rgba(70,130,140,0.3)`, color: BRAND.muted,
              borderRadius: 7, padding: "8px 16px", cursor: "pointer", fontSize: 13, marginLeft: "auto" }}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [draft, setDraft] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");

  async function fetchAndCategorize() {
    setLoading(true);
    setError("");
    setThreads([]);
    setStatus("Connecting to Gmail...");

    try {
      const results = await Promise.all(
        Object.entries(CATEGORIES).map(async ([cat, info]) => {
          setStatus(`Scanning ${info.label}...`);
          const data = await callClaude(
            [{ role: "user", content: `Search Gmail for threads related to: ${info.query}. Return up to 5 results with thread id, subject, from address, and snippet.` }],
            `You are an assistant for Paradise Patio Covers, a patio cover construction company in La Habra, CA.
Use the Gmail MCP tool to search threads. Return ONLY a JSON array (no markdown, no preamble) of objects with fields: id, subject, from, snippet, action.
The "action" field should be a short string (under 10 words) describing what needs to be done, or null if no action needed.`,
            [{ type: "url", url: GMAIL_MCP_URL, name: "gmail-mcp" }]
          );

          const parsed = parseJSON(data);
          if (!Array.isArray(parsed)) return [];
          return parsed.map(t => ({ ...t, category: cat }));
        })
      );

      const seen = new Set();
      const deduped = results.flat().filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
      setThreads(deduped);
      setStatus(`Found ${deduped.length} relevant threads`);
    } catch {
      setError("Failed to load Gmail. Make sure Gmail is connected and try again.");
      setStatus("");
    }
    setLoading(false);
  }

  async function draftReply(thread) {
    setDraft({ loading: true, text: "", subject: thread.subject });
    try {
      const catInfo = CATEGORIES[thread.category] || {};
      const data = await callClaude(
        [{ role: "user", content: `Draft a professional reply for:\nSubject: ${thread.subject}\nFrom: ${thread.from}\nCategory: ${catInfo.label}\nSnippet: ${thread.snippet}\n${thread.action ? `Action needed: ${thread.action}` : ""}` }],
        `You are drafting emails for Paradise Patio Covers (La Habra, CA). Write professional, friendly, concise emails.
Sign off as "Eric | Paradise Patio Covers | 909-772-8880 | CSLB #1113688".
Return ONLY the email body text, no subject line, no markdown.`,
        [{ type: "url", url: GMAIL_MCP_URL, name: "gmail-mcp" }]
      );
      setDraft({ loading: false, text: extractText(data) || "Could not generate draft.", subject: thread.subject });
    } catch {
      setDraft({ loading: false, text: "Error generating draft.", subject: thread.subject });
    }
  }

  const filtered = activeTab === "all" ? threads : threads.filter(t => t.category === activeTab);
  const counts = Object.fromEntries(Object.keys(CATEGORIES).map(k => [k, threads.filter(t => t.category === k).length]));

  return (
    <div style={{ minHeight: "100vh", background: BRAND.bg, fontFamily: "'Georgia', serif", color: BRAND.text }}>

      {/* Header */}
      <div style={{ background: BRAND.navy, borderBottom: `2px solid ${BRAND.teal}`,
        padding: "18px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.15em", color: BRAND.light,
            textTransform: "uppercase", fontFamily: "monospace", marginBottom: 4 }}>
            Paradise Patio Covers
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: BRAND.text }}>
            Inbox Command Center
          </div>
          <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2, fontFamily: "monospace" }}>
            Gmail + Google Drive
          </div>
        </div>
        <button onClick={fetchAndCategorize} disabled={loading}
          style={{ background: loading ? "rgba(70,130,140,0.3)" : BRAND.teal,
            border: "none", color: "#fff", borderRadius: 8, padding: "10px 20px",
            fontWeight: 700, cursor: loading ? "not-allowed" : "pointer",
            fontSize: 13, letterSpacing: "0.05em", fontFamily: "monospace" }}>
          {loading ? "⟳ Scanning..." : "⟳ Scan Gmail"}
        </button>
      </div>

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 16px" }}>

        {status && (
          <div style={{ background: "rgba(70,130,140,0.15)", border: "1px solid rgba(70,130,140,0.3)",
            borderRadius: 7, padding: "8px 14px", fontSize: 12, color: BRAND.light,
            marginBottom: 16, fontFamily: "monospace" }}>
            {status}
          </div>
        )}
        {error && (
          <div style={{ background: "rgba(220,80,60,0.15)", border: "1px solid rgba(220,80,60,0.4)",
            borderRadius: 7, padding: "10px 14px", fontSize: 13, color: "#f08070", marginBottom: 16 }}>
            {error}
          </div>
        )}

        {/* Legend */}
        {threads.length === 0 && !loading && !error && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ textAlign: "center", padding: "48px 20px 24px", color: BRAND.muted }}>
              <div style={{ fontSize: 44, marginBottom: 12 }}>📬</div>
              <div style={{ fontSize: 16, marginBottom: 6, color: BRAND.text }}>Ready to scan your inbox</div>
              <div style={{ fontSize: 13 }}>Click "Scan Gmail" to find leads, quotes, and permit emails</div>
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              {Object.entries(CATEGORIES).map(([k, v]) => (
                <div key={k} style={{ background: BRAND.surface, border: `1px solid ${v.color}33`,
                  borderRadius: 8, padding: "12px 18px", textAlign: "center", minWidth: 140 }}>
                  <div style={{ fontSize: 22, marginBottom: 6 }}>{v.icon}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: v.color }}>{v.label}</div>
                  <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 4 }}>
                    {k === "leads" && "New inquiries"}
                    {k === "quotes" && "Open proposals"}
                    {k === "permits" && "Permit threads"}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 20, background: BRAND.surface, border: `1px solid rgba(70,130,140,0.2)`,
              borderRadius: 8, padding: "12px 16px", fontSize: 12, color: BRAND.muted }}>
              <strong style={{ color: BRAND.light }}>Drive integration:</strong> Click any thread to surface matching Drive files and folders. Draft a quote reply and save it directly to Drive.
            </div>
          </div>
        )}

        {/* Tabs */}
        {threads.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
            {[["all", "All", "🗂️", BRAND.teal, threads.length], ...Object.entries(CATEGORIES).map(([k, v]) => [k, v.label, v.icon, v.color, counts[k]])].map(([key, label, icon, color, count]) => (
              <button key={key} onClick={() => setActiveTab(key)}
                style={{ background: activeTab === key ? color : "transparent",
                  border: `1px solid ${activeTab === key ? color : "rgba(70,130,140,0.3)"}`,
                  color: activeTab === key ? "#fff" : BRAND.muted,
                  borderRadius: 20, padding: "6px 14px", cursor: "pointer",
                  fontSize: 12, fontWeight: 600, transition: "all 0.15s",
                  display: "flex", alignItems: "center", gap: 6 }}>
                {icon} {label} <span style={{ opacity: 0.8 }}>({count})</span>
              </button>
            ))}
          </div>
        )}

        {/* Thread list */}
        <div>
          {filtered.map(thread => (
            <ThreadCard key={thread.id} thread={thread}
              onDraft={draftReply} onSelect={setSelected}
              selected={selected?.id === thread.id} />
          ))}
        </div>
      </div>

      <DraftModal draft={draft} onClose={() => setDraft(null)} />
    </div>
  );
}
