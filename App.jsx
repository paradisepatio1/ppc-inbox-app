import { useState, useEffect, useCallback } from "react";

// ─── Config ────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly";

// ─── Brand ─────────────────────────────────────────────────────────────────
const B = {
  navy:    "#1E3246",
  teal:    "#46828C",
  light:   "#78B4BE",
  gold:    "#C9A84C",
  bg:      "#0B1825",
  surf:    "#132030",
  surf2:   "#1a2d40",
  border:  "rgba(70,130,140,0.18)",
  text:    "#dff0f3",
  muted:   "#6a95a5",
};

const CATS = {
  leads:   { label: "Leads",              icon: "👤", color: B.gold,    q: "patio cover estimate quote inquiry" },
  quotes:  { label: "Quotes",             icon: "📋", color: B.light,   q: "quote proposal estimate patio cover" },
  permits: { label: "Permits & Plan Check",icon: "🏗️", color: "#e07b4a", q: "permit plan check correction building department" },
};

// ─── Google OAuth helpers ───────────────────────────────────────────────────
function loadGoogleScript() {
  return new Promise((resolve) => {
    if (window.google) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = resolve;
    document.head.appendChild(s);
  });
}

async function getAccessToken() {
  await loadGoogleScript();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) reject(resp);
        else resolve(resp.access_token);
      },
    });
    client.requestAccessToken({ prompt: "consent" });
  });
}

// ─── Gmail API helpers ──────────────────────────────────────────────────────
async function gmailSearch(token, query, maxResults = 5) {
  // Last 30 days filter — Gmail uses Unix timestamp for "after:"
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const unixTimestamp = Math.floor(since.getTime() / 1000);
  const fullQuery = `${query} after:${unixTimestamp}`;
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(fullQuery)}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await r.json();
  return data.messages || [];
}

async function gmailGetThread(token, threadId) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return r.json();
}

async function gmailGetMessage(token, msgId) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return r.json();
}

// ─── Drive API helpers ──────────────────────────────────────────────────────
async function driveSearch(token, emailContext) {
  // Step 1: Ask Claude to extract the best search keyword from the email context
  const keyword = await callClaude(
    `From this email context, extract the single best search term to find matching files in Google Drive.
The Drive folder is named "Engineering for jobs" and contains subfolders named like "Smith, John - 123 Main St".
Extract either: a street address number (like 31251), a last name, or a street name — whichever is most specific.
Return ONLY the search term, nothing else, no quotes, no explanation.

Email context: ${emailContext.slice(0, 300)}`,
    "Return only the search keyword, nothing else."
  );

  const term = keyword.trim().split("
")[0].trim();

  // Step 2: Find the "Engineering for jobs" folder
  const folderRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent("name = 'Engineering for jobs' and mimeType = 'application/vnd.google-apps.folder'")}&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const folderData = await folderRes.json();
  const folder = folderData.files?.[0];

  if (!folder) {
    // Fallback: fullText search across all Drive
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`fullText contains '${term}'`)}&fields=files(id,name,mimeType,webViewLink)&pageSize=5`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const d = await r.json();
    return d.files || [];
  }

  // Step 3: Search by folder name match first
  const nameRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folder.id}' in parents and name contains '${term}'`)}&fields=files(id,name,mimeType,webViewLink)&pageSize=5`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const nameData = await nameRes.json();
  if (nameData.files?.length) return nameData.files;

  // Step 4: Fallback — fullText search inside the Engineering for jobs folder
  const ftRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folder.id}' in parents and fullText contains '${term}'`)}&fields=files(id,name,mimeType,webViewLink)&pageSize=5`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const ftData = await ftRes.json();
  return ftData.files || [];
}

// ─── Anthropic API helper ───────────────────────────────────────────────────
async function callClaude(prompt, system) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  return data.content?.[0]?.text || "";
}

function parseJSON(text) {
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch { return null; }
}

// ─── Components ─────────────────────────────────────────────────────────────

function Tag({ label, color }) {
  return (
    <span style={{
      background: color + "22", border: `1px solid ${color}44`,
      color, borderRadius: 4, padding: "2px 8px",
      fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
      textTransform: "uppercase", fontFamily: "monospace",
    }}>{label}</span>
  );
}

function DriveFiles({ files, loading }) {
  if (loading) return <div style={{ fontSize: 12, color: B.muted, marginTop: 10 }}>🔍 Searching Drive...</div>;
  if (!files) return null;
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${B.border}` }}>
      <div style={{ fontSize: 10, color: B.muted, letterSpacing: "0.1em", textTransform: "uppercase", fontFamily: "monospace", marginBottom: 6 }}>
        📁 Engineering for Jobs
      </div>
      {files.length === 0
        ? <div style={{ fontSize: 12, color: B.muted }}>No matching Drive files found.</div>
        : files.map(f => (
          <a key={f.id} href={f.webViewLink} target="_blank" rel="noreferrer"
            style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4,
              color: B.light, fontSize: 12, textDecoration: "none" }}>
            {f.mimeType?.includes("folder") ? "📂" : "📄"} <span style={{ textDecoration: "underline" }}>{f.name}</span>
          </a>
        ))
      }
    </div>
  );
}

function ThreadCard({ thread, onDraft, token, selected, onSelect }) {
  const cat = CATS[thread.category] || {};
  const [driveFiles, setDriveFiles] = useState(null);
  const [driveLoading, setDriveLoading] = useState(false);

  async function loadDrive() {
    if (driveFiles !== null || !token) return;
    setDriveLoading(true);
    // Use full email context to find relevant Drive files
    const context = `${thread.subject || ""} ${thread.from || ""} ${thread.snippet || ""}`;
    const files = await driveSearch(token, context);
    setDriveFiles(files);
    setDriveLoading(false);
  }

  function handleClick() {
    onSelect(thread);
    loadDrive();
  }

  return (
    <div onClick={handleClick} style={{
      background: selected ? B.surf2 : B.surf,
      border: `1px solid ${selected ? cat.color || B.teal : B.border}`,
      borderLeft: `3px solid ${cat.color || B.teal}`,
      borderRadius: 10, padding: "14px 16px", cursor: "pointer",
      transition: "all 0.15s", marginBottom: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
            <span>{cat.icon}</span>
            <Tag label={cat.label} color={cat.color || B.teal} />
          </div>
          <div style={{ fontWeight: 600, color: B.text, fontSize: 14, marginBottom: 3,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {thread.subject || "(No subject)"}
          </div>
          <div style={{ color: B.muted, fontSize: 12, whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "ellipsis" }}>
            {thread.from}
          </div>
        </div>
        <button onClick={e => { e.stopPropagation(); onDraft(thread); }}
          style={{ flexShrink: 0, background: "transparent",
            border: `1px solid ${cat.color || B.teal}`, color: cat.color || B.teal,
            borderRadius: 6, padding: "5px 12px", fontSize: 11, fontWeight: 700,
            cursor: "pointer", letterSpacing: "0.05em", transition: "all 0.15s" }}
          onMouseEnter={e => { e.target.style.background = cat.color || B.teal; e.target.style.color = "#fff"; }}
          onMouseLeave={e => { e.target.style.background = "transparent"; e.target.style.color = cat.color || B.teal; }}>
          Draft ✉️
        </button>
      </div>
      {thread.snippet && (
        <div style={{ marginTop: 8, color: B.muted, fontSize: 12, lineHeight: 1.6,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {thread.snippet}
        </div>
      )}
      {thread.action && (
        <div style={{ marginTop: 8, background: "rgba(201,168,76,0.08)",
          border: "1px solid rgba(201,168,76,0.25)", borderRadius: 5,
          padding: "5px 10px", fontSize: 11, color: B.gold }}>
          ⚡ {thread.action}
        </div>
      )}
      {selected && <DriveFiles files={driveFiles} loading={driveLoading} />}
    </div>
  );
}

function DraftModal({ draft, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!draft) return null;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: B.surf, border: `1px solid ${B.teal}`, borderRadius: 14,
        maxWidth: 620, width: "100%", maxHeight: "82vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${B.border}`,
          display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 700, color: B.text, fontSize: 15 }}>✉️ Draft Reply</div>
          <button onClick={onClose} style={{ background: "none", border: "none",
            color: B.muted, cursor: "pointer", fontSize: 22 }}>×</button>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
          {draft.loading
            ? <div style={{ color: B.muted, textAlign: "center", padding: 40 }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>✍️</div>
                Drafting reply...
              </div>
            : <pre style={{ fontFamily: "inherit", whiteSpace: "pre-wrap",
                color: B.text, fontSize: 13, lineHeight: 1.7, margin: 0 }}>
                {draft.text}
              </pre>
          }
        </div>
        {!draft.loading && (
          <div style={{ padding: "12px 20px", borderTop: `1px solid ${B.border}`,
            display: "flex", gap: 10 }}>
            <button onClick={() => { navigator.clipboard.writeText(draft.text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              style={{ background: B.teal, border: "none", color: "#fff", borderRadius: 7,
                padding: "8px 18px", fontWeight: 700, cursor: "pointer", fontSize: 13 }}>
              {copied ? "✓ Copied!" : "Copy"}
            </button>
            <button onClick={onClose}
              style={{ background: "transparent", border: `1px solid ${B.border}`,
                color: B.muted, borderRadius: 7, padding: "8px 16px", cursor: "pointer", fontSize: 13 }}>
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
  const [token, setToken] = useState(null);
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(null);

  async function signIn() {
    try {
      setError("");
      setStatus("Connecting to Google...");
      const t = await getAccessToken();
      setToken(t);
      setStatus("Connected! Click Scan Gmail to load emails.");
    } catch (e) {
      setError("Google sign-in failed. Make sure popups are allowed and try again.");
      setStatus("");
    }
  }

  async function scanGmail() {
    if (!token) return signIn();
    setLoading(true);
    setError("");
    setThreads([]);

    try {
      const results = await Promise.all(
        Object.entries(CATS).map(async ([cat, info]) => {
          setStatus(`Scanning ${info.label}...`);
          const messages = await gmailSearch(token, info.q, 5);
          const threads = await Promise.all(
            messages.map(m => gmailGetMessage(token, m.id))
          );
          return threads.map(msg => {
            const headers = msg.payload?.headers || [];
            const get = (name) => headers.find(h => h.name === name)?.value || "";
            return {
              id: msg.id,
              threadId: msg.threadId,
              subject: get("Subject"),
              from: get("From"),
              snippet: msg.snippet || "",
              category: cat,
              action: null,
            };
          });
        })
      );

      // Dedupe by threadId
      const seen = new Set();
      const deduped = results.flat().filter(t => {
        if (seen.has(t.threadId)) return false;
        seen.add(t.threadId);
        return true;
      });

      // Ask Claude to add action flags
      if (deduped.length > 0) {
        setStatus("Analyzing emails...");
        const analysis = await callClaude(
          `For each of these email threads, suggest a short action item (under 8 words) or null if no action needed. Return ONLY a JSON array of objects with fields: id and action.\n\n${JSON.stringify(deduped.map(t => ({ id: t.id, subject: t.subject, from: t.from, snippet: t.snippet.slice(0, 100) })))}`,
          "You are an assistant for Paradise Patio Covers, a patio cover contractor. Return ONLY valid JSON, no markdown."
        );
        const actions = parseJSON(analysis);
        if (Array.isArray(actions)) {
          const actionMap = Object.fromEntries(actions.map(a => [a.id, a.action]));
          deduped.forEach(t => { if (actionMap[t.id]) t.action = actionMap[t.id]; });
        }
      }

      setThreads(deduped);
      setStatus(`Found ${deduped.length} relevant threads`);
    } catch (e) {
      console.error(e);
      setError("Failed to scan Gmail. Your session may have expired — try signing in again.");
      setStatus("");
    }
    setLoading(false);
  }

  async function draftReply(thread) {
    setDraft({ loading: true, text: "" });
    const cat = CATS[thread.category] || {};
    const text = await callClaude(
      `Draft a professional reply for this email:\nSubject: ${thread.subject}\nFrom: ${thread.from}\nCategory: ${cat.label}\nSnippet: ${thread.snippet}\n${thread.action ? `Action needed: ${thread.action}` : ""}`,
      `You are drafting emails for Paradise Patio Covers (La Habra, CA). Write professional, friendly, concise replies. Sign off as "Eric | Paradise Patio Covers | 909-772-8880 | CSLB #1113688". Return ONLY the email body, no subject line, no markdown.`
    );
    setDraft({ loading: false, text: text || "Could not generate draft." });
  }

  const filtered = activeTab === "all" ? threads : threads.filter(t => t.category === activeTab);
  const counts = Object.fromEntries(Object.keys(CATS).map(k => [k, threads.filter(t => t.category === k).length]));

  return (
    <div style={{ minHeight: "100vh", background: B.bg, fontFamily: "'Georgia', serif", color: B.text }}>

      {/* Header */}
      <div style={{ background: B.navy, borderBottom: `2px solid ${B.teal}`,
        padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, zIndex: 50 }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: "0.18em", color: B.light,
            textTransform: "uppercase", fontFamily: "monospace" }}>Paradise Patio Covers</div>
          <div style={{ fontSize: 19, fontWeight: 700, color: B.text, letterSpacing: "0.01em" }}>
            Inbox Command Center
          </div>
          <div style={{ fontSize: 10, color: B.muted, fontFamily: "monospace" }}>Gmail + Google Drive</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!token && (
            <button onClick={signIn}
              style={{ background: "transparent", border: `1px solid ${B.gold}`,
                color: B.gold, borderRadius: 7, padding: "8px 16px", fontWeight: 700,
                cursor: "pointer", fontSize: 12, fontFamily: "monospace" }}>
              Sign in with Google
            </button>
          )}
          {token && (
            <div style={{ fontSize: 10, color: "#4caf82", fontFamily: "monospace",
              background: "rgba(76,175,130,0.1)", border: "1px solid rgba(76,175,130,0.3)",
              borderRadius: 5, padding: "3px 8px" }}>● Connected</div>
          )}
          <button onClick={scanGmail} disabled={loading}
            style={{ background: loading ? "rgba(70,130,140,0.3)" : B.teal,
              border: "none", color: "#fff", borderRadius: 7, padding: "9px 18px",
              fontWeight: 700, cursor: loading ? "not-allowed" : "pointer",
              fontSize: 12, fontFamily: "monospace", letterSpacing: "0.05em" }}>
            {loading ? "⟳ Scanning..." : "⟳ Scan Gmail"}
          </button>
        </div>
      </div>

      <div style={{ maxWidth: 780, margin: "0 auto", padding: "24px 16px" }}>

        {status && (
          <div style={{ background: "rgba(70,130,140,0.12)", border: "1px solid rgba(70,130,140,0.25)",
            borderRadius: 7, padding: "8px 14px", fontSize: 12, color: B.light,
            marginBottom: 16, fontFamily: "monospace" }}>
            {status}
          </div>
        )}
        {error && (
          <div style={{ background: "rgba(220,80,60,0.12)", border: "1px solid rgba(220,80,60,0.35)",
            borderRadius: 7, padding: "10px 14px", fontSize: 13, color: "#f08070", marginBottom: 16 }}>
            {error}
          </div>
        )}

        {/* Empty state */}
        {threads.length === 0 && !loading && !error && (
          <div style={{ textAlign: "center", padding: "50px 20px 30px" }}>
            <div style={{ fontSize: 46, marginBottom: 14 }}>📬</div>
            <div style={{ fontSize: 17, color: B.text, marginBottom: 6 }}>Ready to scan your inbox</div>
            <div style={{ fontSize: 13, color: B.muted, marginBottom: 28 }}>
              {token ? 'Click "Scan Gmail" to find leads, quotes, and permit emails'
                      : 'Sign in with Google to get started'}
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              {Object.entries(CATS).map(([k, v]) => (
                <div key={k} style={{ background: B.surf, border: `1px solid ${v.color}33`,
                  borderRadius: 10, padding: "14px 20px", minWidth: 140, textAlign: "center" }}>
                  <div style={{ fontSize: 24, marginBottom: 6 }}>{v.icon}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: v.color }}>{v.label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tabs */}
        {threads.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
            {[["all", "All", "🗂️", B.teal, threads.length],
              ...Object.entries(CATS).map(([k, v]) => [k, v.label, v.icon, v.color, counts[k]])
            ].map(([key, label, icon, color, count]) => (
              <button key={key} onClick={() => setActiveTab(key)}
                style={{ background: activeTab === key ? color : "transparent",
                  border: `1px solid ${activeTab === key ? color : B.border}`,
                  color: activeTab === key ? "#fff" : B.muted,
                  borderRadius: 20, padding: "5px 14px", cursor: "pointer",
                  fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}>
                {icon} {label} ({count})
              </button>
            ))}
          </div>
        )}

        {/* Threads */}
        {filtered.map(thread => (
          <ThreadCard key={thread.id} thread={thread} token={token}
            onDraft={draftReply} selected={selected?.id === thread.id}
            onSelect={setSelected} />
        ))}
      </div>

      <DraftModal draft={draft} onClose={() => setDraft(null)} />
    </div>
  );
}
