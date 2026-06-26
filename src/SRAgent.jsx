import { useState } from "react";

const COLS = ["part_number", "cm_location", "type", "date", "qty", "product_code", "platform"];

const SAMPLE_PREV = `part_number\tcm_location\ttype\tdate\tqty\tproduct_code\tplatform
1234567\tTaiwan\tcommit\t04/07/2026\t13\tAB\tABC200
1245678\tMumbai, India\tforecast\t04/07/2026\t18\tXY\tMCD530`;

const SAMPLE_CURR = `part_number\tcm_location\ttype\tdate\tqty\tproduct_code\tplatform
1234567\tTaiwan\tcommit\t04/14/2026\t20\tAB\tABC200
1245678\tMumbai, India\tforecast\t04/14/2026\t18\tXY\tMCD530
9988776\tShenzhen, China\tforecast\t04/21/2026\t50\tZZ\tXPR100`;

const SYSTEM_PROMPT = `You are a supply chain operations analyst. You are given two weekly Schedule Receipt (SR) snapshots from a demand planning team. Columns: Part Number, CM Location, Type (forecast/commit), Date, Qty, Product Code, Platform. CMs are Contract Manufacturers and key external stakeholders; changes can affect their production plans.

Return ONLY a JSON object, no markdown fences, no preamble or trailing text. Keep every string under 100 characters. Schema:
{
  "summary": "string",
  "key_themes": ["string"],
  "questions_for_demand_planning": [{"question": "string", "context": "string"}],
  "questions_for_cms": [{"question": "string", "context": "string"}],
  "risk_flags": ["string"]
}`;

function parseSR(raw) {
  const lines = raw.trim().split("\n").filter((l) => l.trim());
  if (!lines.length) return [];
  const firstCells = lines[0].split(/\t|,/).map((c) => c.trim().toLowerCase());
  const isHeader = firstCells.some(
    (c) => c.includes("part") || c.includes("type") || c.includes("platform")
  );
  const dataLines = isHeader ? lines.slice(1) : lines;
  return dataLines
    .map((line) => {
      const cells = line.split(/\t|,/).map((c) => c.trim());
      const obj = {};
      COLS.forEach((k, i) => {
        obj[k] = cells[i] || "";
      });
      return obj;
    })
    .filter((r) => r.part_number);
}

function diffSRs(prev, curr) {
  const prevMap = Object.fromEntries(prev.map((r) => [r.part_number, r]));
  const currMap = Object.fromEntries(curr.map((r) => [r.part_number, r]));
  const added = curr.filter((r) => !prevMap[r.part_number]);
  const removed = prev.filter((r) => !currMap[r.part_number]);
  const changed = curr.reduce((acc, r) => {
    const p = prevMap[r.part_number];
    if (!p) return acc;
    const fields = COLS.filter((k) => r[k] !== p[k] && r[k] && p[k]);
    if (fields.length) acc.push({ current: r, previous: p, fields });
    return acc;
  }, []);
  return { added, removed, changed };
}

function buildDiffText(prev, curr, diff) {
  return [
    `PREVIOUS WEEK (${prev.length} rows):\n` + prev.map((r) => COLS.map((k) => r[k]).join("|")).join("\n"),
    `CURRENT WEEK (${curr.length} rows):\n` + curr.map((r) => COLS.map((k) => r[k]).join("|")).join("\n"),
    `ADDED: ${diff.added.map((r) => r.part_number).join(", ") || "none"}`,
    `REMOVED: ${diff.removed.map((r) => r.part_number).join(", ") || "none"}`,
    `CHANGED: ${
      diff.changed
        .map(
          (c) =>
            `${c.current.part_number}[${c.fields
              .map((f) => `${f}:${c.previous[f]}->${c.current[f]}`)
              .join(",")}]`
        )
        .join("; ") || "none"
    }`,
  ].join("\n\n");
}

// Calls the Anthropic API. In production, replace this URL with your own
// backend proxy endpoint (see docs/ARCHITECTURE.md) so the API key never
// reaches the browser.
async function callClaude(diffText) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: diffText }],
    }),
  });
  const data = await response.json();
  if (data.error) throw new Error(`${data.error.type}: ${data.error.message}`);
  const text = data.content.map((b) => b.text || "").join("").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON found in model response");
  return JSON.parse(text.slice(start, end + 1));
}

export default function SRAgent() {
  const [prevRaw, setPrevRaw] = useState("");
  const [currRaw, setCurrRaw] = useState("");
  const [diff, setDiff] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function runAnalysis() {
    setError("");
    const prev = parseSR(prevRaw);
    const curr = parseSR(currRaw);
    if (!prev.length || !curr.length) {
      setError("Paste SR data into both fields before running (or load the sample data).");
      return;
    }
    const d = diffSRs(prev, curr);
    setDiff(d);
    setLoading(true);
    try {
      const r = await callClaude(buildDiffText(prev, curr, d));
      setResult(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setDiff(null);
    setResult(null);
    setError("");
  }

  if (diff && result) {
    return <ResultsView diff={diff} result={result} onReset={reset} />;
  }

  return (
    <div style={{ maxWidth: 680, padding: "1rem 0" }}>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 4 }}>SR Reconciliation Agent</h2>
      <p style={{ fontSize: 13, color: "#666", marginBottom: 20 }}>
        Paste last week and this week's SR data, then run the analysis.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <SRInput label="Previous week SR" value={prevRaw} onChange={setPrevRaw} onSample={() => setPrevRaw(SAMPLE_PREV)} />
        <SRInput label="Current week SR" value={currRaw} onChange={setCurrRaw} onSample={() => setCurrRaw(SAMPLE_CURR)} />
      </div>

      <p style={{ fontSize: 12, color: "#999", marginBottom: 12 }}>
        Copy-paste directly from Excel (tab-separated) or CSV. Header row is optional.
      </p>

      {error && <p style={{ fontSize: 13, color: "#c0392b", marginBottom: 10 }}>{error}</p>}

      <button onClick={runAnalysis} disabled={loading} style={{ padding: "8px 20px", fontWeight: 500, fontSize: 14 }}>
        {loading ? "Analysing…" : "Run analysis"}
      </button>
    </div>
  );
}

function SRInput({ label, value, onChange, onSample }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <label style={{ fontSize: 13, fontWeight: 500 }}>{label}</label>
        <button onClick={onSample} style={{ fontSize: 11, padding: "2px 8px" }}>
          load sample
        </button>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste SR rows here"
        style={{ width: "100%", minHeight: 130, fontFamily: "monospace", fontSize: 12, padding: 10 }}
      />
    </div>
  );
}

function ResultsView({ diff, result, onReset }) {
  return (
    <div style={{ maxWidth: 680, padding: "1rem 0" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <strong>Analysis complete</strong>
        <span>+{diff.added.length} added</span>
        <span>-{diff.removed.length} removed</span>
        <span>~{diff.changed.length} changed</span>
        <button onClick={onReset} style={{ marginLeft: "auto" }}>
          New analysis
        </button>
      </div>

      <section style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, textTransform: "uppercase", color: "#666" }}>Summary</h3>
        <p>{result.summary}</p>
      </section>

      <section style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, textTransform: "uppercase", color: "#666" }}>Change log</h3>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th align="left">Status</th>
              <th align="left">Part #</th>
              <th align="left">Details</th>
            </tr>
          </thead>
          <tbody>
            {diff.added.map((r) => (
              <tr key={r.part_number}>
                <td>added</td>
                <td>{r.part_number}</td>
                <td>{r.platform} / {r.cm_location} / {r.type} / qty {r.qty}</td>
              </tr>
            ))}
            {diff.removed.map((r) => (
              <tr key={r.part_number}>
                <td>removed</td>
                <td>{r.part_number}</td>
                <td>{r.platform} / {r.cm_location} / {r.type} / qty {r.qty}</td>
              </tr>
            ))}
            {diff.changed.map((c) => (
              <tr key={c.current.part_number}>
                <td>changed</td>
                <td>{c.current.part_number}</td>
                <td>
                  {c.fields.map((f) => `${f}: ${c.previous[f]} → ${c.current[f]}`).join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {result.risk_flags?.length > 0 && (
        <section style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 13, textTransform: "uppercase", color: "#c0392b" }}>Risk flags</h3>
          <ul>
            {result.risk_flags.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </section>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <QuestionList title="Questions for demand planning" items={result.questions_for_demand_planning} />
        <QuestionList title="Questions for CMs" items={result.questions_for_cms} />
      </div>
    </div>
  );
}

function QuestionList({ title, items = [] }) {
  return (
    <div>
      <h3 style={{ fontSize: 13, textTransform: "uppercase", color: "#666" }}>{title}</h3>
      {items.map((q, i) => (
        <div key={i} style={{ marginBottom: 10 }}>
          <p style={{ fontWeight: 500, fontSize: 13, margin: 0 }}>Q{i + 1}. {q.question}</p>
          <p style={{ fontSize: 12, color: "#666", margin: 0 }}>{q.context}</p>
        </div>
      ))}
    </div>
  );
}
