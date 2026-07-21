import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NEET Test Paper PDF Generator" },
      {
        name: "description",
        content:
          "Upload a questions JSON file and generate a print-ready two-column NEET-style test paper PDF with LaTeX math rendering.",
      },
      { property: "og:title", content: "NEET Test Paper PDF Generator" },
      {
        property: "og:description",
        content:
          "Turn a questions JSON file into a formatted two-column test paper PDF.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type QItem = {
  qno: number;
  question: { text: string; image?: string };
  options: Record<string, { text: string; image?: string }>;
  subject?: string;
  chapter?: string;
};

type Meta = {
  academy: string;
  category: string;
  testTitle: string;
  testDate: string;
  duration: string;
  marks: string;
  subjectsList: string; // one "Subject:Type" per line
};

const DEFAULT_META: Meta = {
  academy: "Success Code Academy",
  category: "NEET UG | Medical",
  testTitle: "RE-NEET FST -1",
  testDate: "05-06-2026",
  duration: "180min",
  marks: "720",
  subjectsList: "Physics:FST\nChemistry:FST\nBiology:FST",
};

// Render inline LaTeX embedded between \( \) or \[ \] (and $...$).
function renderMath(input: string): string {
  if (!input) return "";
  // Normalize: handle \( \) \[ \] and $...$
  const parts: { type: "text" | "math"; value: string; display?: boolean }[] = [];
  let i = 0;
  const s = input;
  while (i < s.length) {
    const pIdx = s.indexOf("\\(", i);
    const dIdx = s.indexOf("\\[", i);
    const $Idx = s.indexOf("$", i);
    const candidates = [pIdx, dIdx, $Idx].filter((x) => x >= 0);
    if (candidates.length === 0) {
      parts.push({ type: "text", value: s.slice(i) });
      break;
    }
    const next = Math.min(...candidates);
    if (next > i) parts.push({ type: "text", value: s.slice(i, next) });
    if (next === pIdx) {
      const end = s.indexOf("\\)", next + 2);
      if (end < 0) {
        parts.push({ type: "text", value: s.slice(next) });
        break;
      }
      parts.push({ type: "math", value: s.slice(next + 2, end), display: false });
      i = end + 2;
    } else if (next === dIdx) {
      const end = s.indexOf("\\]", next + 2);
      if (end < 0) {
        parts.push({ type: "text", value: s.slice(next) });
        break;
      }
      parts.push({ type: "math", value: s.slice(next + 2, end), display: true });
      i = end + 2;
    } else {
      const end = s.indexOf("$", next + 1);
      if (end < 0) {
        parts.push({ type: "text", value: s.slice(next) });
        break;
      }
      parts.push({ type: "math", value: s.slice(next + 1, end), display: false });
      i = end + 1;
    }
  }
  return parts
    .map((p) => {
      if (p.type === "text") {
        return escapeHtml(p.value);
      }
      try {
        return katex.renderToString(p.value, {
          throwOnError: false,
          displayMode: !!p.display,
          output: "html",
        });
      } catch {
        return escapeHtml(p.value);
      }
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function groupBySubject(items: QItem[]): { subject: string; items: QItem[] }[] {
  const order: string[] = [];
  const map = new Map<string, QItem[]>();
  for (const it of items) {
    const sub = it.subject || "Questions";
    if (!map.has(sub)) {
      map.set(sub, []);
      order.push(sub);
    }
    map.get(sub)!.push(it);
  }
  return order.map((s) => ({ subject: s, items: map.get(s)! }));
}

function Index() {
  const [meta, setMeta] = useState<Meta>(DEFAULT_META);
  const [items, setItems] = useState<QItem[] | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [error, setError] = useState<string>("");

  const grouped = useMemo(() => (items ? groupBySubject(items) : []), [items]);

  const onFile = async (f: File) => {
    setError("");
    try {
      const text = await f.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("JSON must be an array of questions.");
      setItems(parsed as QItem[]);
      setFileName(f.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read file");
      setItems(null);
    }
  };

  const subjectRows = meta.subjectsList
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, type] = l.split(":").map((x) => x?.trim() ?? "");
      return { name, type: type || "" };
    });

  return (
    <div className="min-h-screen bg-muted/40">
      <div className="no-print border-b bg-background">
        <div className="mx-auto max-w-6xl px-6 py-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">NEET Test Paper PDF Generator</h1>
            <p className="text-sm text-muted-foreground">
              Upload a questions JSON, edit the header, then Print → Save as PDF.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => window.print()}
              disabled={!items}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              Download PDF
            </button>
          </div>
        </div>
      </div>

      <div className="no-print mx-auto max-w-6xl px-6 py-6 grid gap-6 md:grid-cols-[320px_1fr]">
        <aside className="space-y-4">
          <div className="rounded-lg border bg-background p-4 space-y-3">
            <h2 className="font-semibold text-sm">1. Upload questions JSON</h2>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
              }}
              className="block w-full text-sm"
            />
            {fileName && (
              <p className="text-xs text-muted-foreground">
                Loaded: <span className="font-medium">{fileName}</span>
                {items && ` — ${items.length} questions`}
              </p>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <div className="rounded-lg border bg-background p-4 space-y-3">
            <h2 className="font-semibold text-sm">2. Header details</h2>
            {(
              [
                ["academy", "Academy name"],
                ["category", "Category line"],
                ["testTitle", "Test title"],
                ["testDate", "Test date"],
                ["duration", "Duration"],
                ["marks", "Total marks"],
              ] as [keyof Meta, string][]
            ).map(([k, label]) => (
              <label key={k} className="block text-xs">
                <span className="text-muted-foreground">{label}</span>
                <input
                  value={meta[k]}
                  onChange={(e) => setMeta({ ...meta, [k]: e.target.value })}
                  className="mt-1 w-full rounded border px-2 py-1 text-sm"
                />
              </label>
            ))}
            <label className="block text-xs">
              <span className="text-muted-foreground">
                Subjects (one per line: Name:Type)
              </span>
              <textarea
                value={meta.subjectsList}
                onChange={(e) => setMeta({ ...meta, subjectsList: e.target.value })}
                rows={4}
                className="mt-1 w-full rounded border px-2 py-1 text-sm font-mono"
              />
            </label>
          </div>

          <p className="text-xs text-muted-foreground">
            Tip: in the print dialog choose <b>Save as PDF</b>, margins{" "}
            <b>Default</b>, and enable <b>Background graphics</b>.
          </p>
        </aside>

        <section className="rounded-lg border bg-background p-4">
          <h2 className="mb-3 font-semibold text-sm text-muted-foreground">
            Preview
          </h2>
          <div className="preview-frame">
            <PaperDocument meta={meta} subjectRows={subjectRows} grouped={grouped} />
          </div>
        </section>
      </div>

      {/* Print-only: full document */}
      <div className="print-only">
        <PaperDocument meta={meta} subjectRows={subjectRows} grouped={grouped} />
      </div>
    </div>
  );
}

function PaperDocument({
  meta,
  subjectRows,
  grouped,
}: {
  meta: Meta;
  subjectRows: { name: string; type: string }[];
  grouped: { subject: string; items: QItem[] }[];
}) {
  return (
    <div className="paper">
      <header className="paper-header">
        <div className="paper-header-left">
          <div className="academy-name">{meta.academy}</div>
          <div className="academy-rule" />
          <div className="academy-category">{meta.category}</div>
        </div>
        <table className="paper-header-info">
          <tbody>
            <tr>
              <td>{meta.testTitle}</td>
            </tr>
            <tr>
              <td>Test Date: {meta.testDate}</td>
            </tr>
            <tr>
              <td>Time Duration : {meta.duration}</td>
            </tr>
            <tr>
              <td>Test Marks :{meta.marks}</td>
            </tr>
          </tbody>
        </table>
      </header>

      {subjectRows.length > 0 && (
        <table className="subjects-table">
          <tbody>
            {subjectRows.map((r, i) => (
              <tr key={i}>
                <td className="subject-name">{r.name}</td>
                <td className="subject-type">{r.type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {grouped.length === 0 && (
        <div className="empty-state">
          Upload a JSON file to preview the paper here.
        </div>
      )}

      {grouped.map((g) => (
        <section key={g.subject} className="subject-section">
          <h2 className="subject-heading">{g.subject}</h2>
          <div className="two-col">
            {g.items.map((q) => (
              <QuestionBlock key={q.qno} q={q} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function QuestionBlock({ q }: { q: QItem }) {
  const optionKeys = Object.keys(q.options || {});
  return (
    <div className="question">
      <div className="qrow">
        <span className="qnum">{q.qno}.</span>
        <span
          className="qtext"
          dangerouslySetInnerHTML={{ __html: renderMath(q.question.text) }}
        />
      </div>
      {q.question.image && (
        <div className="qimage">
          <img src={q.question.image} alt="" />
        </div>
      )}
      <ol className="options">
        {optionKeys.map((k, idx) => {
          const opt = q.options[k];
          return (
            <li key={k} className="option">
              <span className="opt-num">({idx + 1})</span>
              <span
                className="opt-text"
                dangerouslySetInnerHTML={{ __html: renderMath(opt.text) }}
              />
              {opt.image && <img className="opt-img" src={opt.image} alt="" />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
