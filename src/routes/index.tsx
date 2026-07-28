import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import katex from "katex";
import { z } from "zod";
import "katex/dist/katex.min.css";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NEET Test Paper PDF Generator" },
      {
        name: "description",
        content:
          "Upload a questions JSON file and generate a customizable two-column NEET-style test paper PDF with LaTeX math rendering.",
      },
      { property: "og:title", content: "NEET Test Paper PDF Generator" },
      {
        property: "og:description",
        content:
          "Turn a questions JSON file into a formatted, template-driven test paper PDF.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

// ---------- Zod schema ----------
const richField = z.object({
  text: z.string(),
  image: z.string().optional().default(""),
});

const questionSchema = z.object({
  qno: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  year: z.union([z.number(), z.string(), z.null()]).optional(),
  question: richField,
  options: z.record(z.string(), richField).refine((o) => Object.keys(o).length >= 2, {
    message: "Each question needs at least 2 options",
  }),
  answer: z.string().optional(),
  explanation: richField.optional(),
  subject: z.string().optional(),
  chapter: z.string().optional(),
  topic: z.string().optional(),
  difficulty: z.string().optional(),
});

const paperSchema = z.array(questionSchema).min(1, "JSON must contain at least one question");

type QItem = z.infer<typeof questionSchema>;

// ---------- Meta ----------
type Meta = {
  academy: string;
  category: string;
  testTitle: string;
  testDate: string;
  duration: string;
  marks: string;
  subjectsList: string;
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

// ---------- Templates ----------
// Uses {{tokens}} that are replaced at render time.
const DEFAULT_HEADER_TEMPLATE = `<header class="paper-header">
  <div class="paper-header-left">
    <div class="academy-name">{{academy}}</div>
    <div class="academy-rule"></div>
    <div class="academy-category">{{category}}</div>
  </div>
  <table class="paper-header-info"><tbody>
    <tr><td>{{testTitle}}</td></tr>
    <tr><td>Test Date: {{testDate}}</td></tr>
    <tr><td>Time Duration : {{duration}}</td></tr>
    <tr><td>Test Marks :{{marks}}</td></tr>
  </tbody></table>
</header>
{{subjectsTable}}`;

const DEFAULT_QUESTION_TEMPLATE = `<div class="question">
  <div class="qrow">
    <span class="qnum">{{qno}}.</span>
    <span class="qtext">{{question}}</span>
  </div>
  {{questionImage}}
  <ol class="options">{{options}}</ol>
</div>`;

const DEFAULT_OPTION_TEMPLATE = `<li class="option">
  <span class="opt-num">({{index}})</span>
  <span class="opt-text">{{text}}{{image}}</span>
</li>`;

const DEFAULT_CUSTOM_CSS = `/* Add or override styles. These apply to preview + print. */
/* Example:
.subject-heading { color: #0b3a7a; text-decoration: underline; }
.paper { font-family: Georgia, serif; }
*/`;

// ---------- Math renderer ----------
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#x")) {
      const codePoint = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (key.startsWith("#")) {
      const codePoint = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[key] ?? match;
  });
}

function normalizePossiblyEscapedHtml(input: string): string {
  let current = input;
  for (let i = 0; i < 3; i += 1) {
    const next = decodeHtmlEntities(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

// Only allow http(s), relative and data:image URLs for <img src>.
function safeImageUrl(raw: string): string {
  const url = (raw || "").trim();
  if (/^(https?:\/\/|\/|\.\/|\.\.\/)/i.test(url)) return escapeHtml(url);
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(url))
    return escapeHtml(url);
  return "";
}

// Escape, then re-allow a small set of inline + table HTML tags used in question text.
// All attributes are stripped so no event handlers / styles can be injected.
const ALLOWED_TAGS = [
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "ul", "ol", "li", "p", "div",
  "span", "sub", "sup", "strong", "small", "br", "em", "b", "i", "u",
];

function sanitizeInlineHtml(raw: string): string {
  const escaped = escapeHtml(normalizePossiblyEscapedHtml(raw));
  // Attributes may contain escaped entities (&quot; etc.), so match anything
  // that is not the closing &gt; sequence.
  const re = new RegExp(
    `&lt;(\\/?)(${ALLOWED_TAGS.join("|")})((?:\\s(?:(?!&gt;)[\\s\\S])*?)?)\\s*(\\/?)&gt;`,
    "gi"
  );

  const withTags = escaped.replace(re, (_m, slash, tag, _attrs: string, selfClose: string) => {
    return `<${slash}${tag.toLowerCase()}${selfClose}>`;
  });

  // Inline diagrams: keep <img> but only with an allowlisted src. Every other
  // attribute (width/height/style) is dropped so CSS controls the mm sizing.
  return withTags.replace(
    /&lt;img((?:\s(?:(?!&gt;)[\s\S])*?)?)\s*\/?&gt;/gi,
    (_m, attrs: string) => {
      const srcMatch = /src\s*=\s*(?:&quot;([^&]*)&quot;|&#39;([^&]*)&#39;|([^\s&]+))/i.exec(
        attrs ?? ""
      );
      const rawSrc = decodeHtmlEntities(srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "");
      const safe = safeImageUrl(rawSrc);
      return safe ? `<img src="${safe}" alt="" />` : "";
    }
  );
}


function renderMath(input: string): string {
  if (!input) return "";
  const s = input;
  const parts: { type: "text" | "math"; value: string; display?: boolean }[] = [];
  let i = 0;
  while (i < s.length) {
    const pIdx = s.indexOf("\\(", i);
    const dIdx = s.indexOf("\\[", i);
    const $Idx = s.indexOf("$", i);
    const cand = [pIdx, dIdx, $Idx].filter((x) => x >= 0);
    if (cand.length === 0) {
      parts.push({ type: "text", value: s.slice(i) });
      break;
    }
    const next = Math.min(...cand);
    if (next > i) parts.push({ type: "text", value: s.slice(i, next) });
    if (next === pIdx) {
      const end = s.indexOf("\\)", next + 2);
      if (end < 0) { parts.push({ type: "text", value: s.slice(next) }); break; }
      parts.push({ type: "math", value: s.slice(next + 2, end), display: false });
      i = end + 2;
    } else if (next === dIdx) {
      const end = s.indexOf("\\]", next + 2);
      if (end < 0) { parts.push({ type: "text", value: s.slice(next) }); break; }
      parts.push({ type: "math", value: s.slice(next + 2, end), display: true });
      i = end + 2;
    } else {
      const end = s.indexOf("$", next + 1);
      if (end < 0) { parts.push({ type: "text", value: s.slice(next) }); break; }
      parts.push({ type: "math", value: s.slice(next + 1, end), display: false });
      i = end + 1;
    }
  }
  return parts
    .map((p) => {
      if (p.type === "text") return sanitizeInlineHtml(p.value);
      try {
        return katex.renderToString(p.value, {
          throwOnError: false,
          displayMode: !!p.display,
          output: "htmlAndMathml",
          strict: "ignore",
          trust: false,
        });
      } catch {
        return escapeHtml(p.value);
      }
    })
    .join("");
}

// ---------- Template engine (safe {{token}} replace, no eval) ----------
function fillTemplate(tpl: string, tokens: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, key) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : ""
  );
}

// ---------- Grouping ----------
function groupBySubject(items: QItem[]) {
  const order: string[] = [];
  const map = new Map<string, QItem[]>();
  for (const it of items) {
    const sub = it.subject || "Questions";
    if (!map.has(sub)) { map.set(sub, []); order.push(sub); }
    map.get(sub)!.push(it);
  }
  return order.map((s) => ({ subject: s, items: map.get(s)! }));
}

// ---------- Component ----------
function Index() {
  const [meta, setMeta] = useState<Meta>(DEFAULT_META);
  const [rawJson, setRawJson] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [items, setItems] = useState<QItem[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [tab, setTab] = useState<"data" | "header" | "templates">("data");

  const [headerTpl, setHeaderTpl] = useState(DEFAULT_HEADER_TEMPLATE);
  const [questionTpl, setQuestionTpl] = useState(DEFAULT_QUESTION_TEMPLATE);
  const [optionTpl, setOptionTpl] = useState(DEFAULT_OPTION_TEMPLATE);
  const [customCss, setCustomCss] = useState(DEFAULT_CUSTOM_CSS);
  const [debugBoxes, setDebugBoxes] = useState(false);
  const [columns, setColumns] = useState<1 | 2>(2);


  const validate = (text: string) => {
    setErrors([]);
    if (!text.trim()) { setItems(null); return; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setErrors([`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`]);
      setItems(null);
      return;
    }
    const result = paperSchema.safeParse(parsed);
    if (!result.success) {
      const msgs = result.error.issues.slice(0, 30).map((iss) => {
        const path = iss.path.length ? iss.path.join(".") : "(root)";
        return `• ${path}: ${iss.message}`;
      });
      if (result.error.issues.length > 30) {
        msgs.push(`…and ${result.error.issues.length - 30} more issues`);
      }
      setErrors(msgs);
      setItems(null);
      return;
    }
    setItems(result.data);
  };

  useEffect(() => { validate(rawJson); /* eslint-disable-next-line */ }, [rawJson]);

  const onFile = async (f: File) => {
    const text = await f.text();
    setFileName(f.name);
    setRawJson(text);
  };

  const subjectRows = useMemo(
    () =>
      meta.subjectsList
        .split("\n").map((l) => l.trim()).filter(Boolean)
        .map((l) => {
          const [name, type] = l.split(":").map((x) => x?.trim() ?? "");
          return { name, type: type || "" };
        }),
    [meta.subjectsList]
  );

  const grouped = useMemo(() => (items ? groupBySubject(items) : []), [items]);

  // Build header HTML from template
  const headerHtml = useMemo(() => {
    const subjectsTable = subjectRows.length
      ? `<table class="subjects-table"><tbody>${subjectRows
          .map(
            (r) =>
              `<tr><td class="subject-name">${escapeHtml(r.name)}</td><td class="subject-type">${escapeHtml(r.type)}</td></tr>`
          )
          .join("")}</tbody></table>`
      : "";
    return fillTemplate(headerTpl, {
      academy: escapeHtml(meta.academy),
      category: escapeHtml(meta.category),
      testTitle: escapeHtml(meta.testTitle),
      testDate: escapeHtml(meta.testDate),
      duration: escapeHtml(meta.duration),
      marks: escapeHtml(meta.marks),
      subjectsTable,
    });
  }, [headerTpl, meta, subjectRows]);

  const buildQuestionsHtml = () =>
    grouped
      .map(
        (g) =>
          `<section class="subject-section"><h2 class="subject-heading">${escapeHtml(
            g.subject
          )}</h2><div class="two-col col-${columns}">${g.items
            .map((q) => {
              const keys = Object.keys(q.options);
              const optsHtml = keys
                .map((k, idx) =>
                  fillTemplate(optionTpl, {
                    index: String(idx + 1),
                    key: escapeHtml(k),
                    text: renderMath(q.options[k].text),
                    image: safeImageUrl(q.options[k].image ?? "")
                      ? `<img class="opt-img" src="${safeImageUrl(q.options[k].image!)}" alt="" />`
                      : "",
                  })
                )
                .join("");
              return fillTemplate(questionTpl, {
                qno: String(q.qno),
                question: renderMath(q.question.text),
                questionImage: safeImageUrl(q.question.image ?? "")
                  ? `<div class="qimage"><img src="${safeImageUrl(q.question.image)}" alt="" /></div>`
                  : "",

                options: optsHtml,
                subject: escapeHtml(q.subject ?? ""),
                chapter: escapeHtml(q.chapter ?? ""),
              });
            })
            .join("")}</div></section>`
      )
      .join("");

  const questionsHtml = useMemo(buildQuestionsHtml, [grouped, questionTpl, optionTpl, columns]);

  const paperHtml = `<div class="paper">${headerHtml}${
    grouped.length === 0
      ? `<div class="empty-state">${items ? "" : "Upload a JSON file to preview the paper."}</div>`
      : questionsHtml
  }</div>`;

  const canPrint = !!items && errors.length === 0;

  // ---- Temporary debug overlay: measure every diagram in mm ----
  useEffect(() => {
    const PX_PER_MM = 96 / 25.4;
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>(".paper img"));
    if (!debugBoxes) {
      imgs.forEach((img) => {
        img.removeAttribute("data-mm");
        img.removeAttribute("data-overflow");
        img.parentElement?.removeAttribute("data-mmlabel");
      });
      return;
    }
    const measure = () => {
      document.querySelectorAll<HTMLImageElement>(".paper img").forEach((img) => {
        const r = img.getBoundingClientRect();
        const w = r.width / PX_PER_MM;
        const h = r.height / PX_PER_MM;
        const isOpt = !!img.closest(".option, .options, .opt-text");
        const cap = isOpt ? 34 : 45;
        const parent = img.parentElement?.getBoundingClientRect();
        const overflows =
          w > cap + 0.6 || h > cap + 0.6 || (!!parent && r.width > parent.width + 1);
        const label = `${w.toFixed(1)}×${h.toFixed(1)}mm / cap ${cap}mm`;
        img.setAttribute("data-mm", label);
        img.parentElement?.setAttribute("data-mmlabel", label);
        if (overflows) img.setAttribute("data-overflow", "1");
        else img.removeAttribute("data-overflow");
      });
    };
    measure();
    const t = window.setTimeout(measure, 400);
    window.addEventListener("resize", measure);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", measure);
    };
  }, [debugBoxes, paperHtml]);


  const resetTemplate = (which: "header" | "question" | "option" | "css") => {
    if (which === "header") setHeaderTpl(DEFAULT_HEADER_TEMPLATE);
    if (which === "question") setQuestionTpl(DEFAULT_QUESTION_TEMPLATE);
    if (which === "option") setOptionTpl(DEFAULT_OPTION_TEMPLATE);
    if (which === "css") setCustomCss(DEFAULT_CUSTOM_CSS);
  };

  return (
    <div className={`min-h-screen bg-muted/40${debugBoxes ? " debug-diagrams" : ""}`}>
      {/* Injected custom CSS (preview + print) */}
      <style dangerouslySetInnerHTML={{ __html: customCss }} />

      <div className="no-print border-b bg-background">
        <div className="mx-auto max-w-6xl px-6 py-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">NEET Test Paper PDF Generator</h1>
            <p className="text-sm text-muted-foreground">
              Upload JSON, customize the template, then Print → Save as PDF.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground select-none">
              Layout
              <select
                value={columns}
                onChange={(e) => setColumns(Number(e.target.value) === 1 ? 1 : 2)}
                className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
              >
                <option value={2}>2 columns</option>
                <option value={1}>1 column</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground select-none">
              <input
                type="checkbox"
                checked={debugBoxes}
                onChange={(e) => setDebugBoxes(e.target.checked)}
              />
              Debug diagram boxes (mm)
            </label>
            <button
              onClick={() => window.print()}
              disabled={!canPrint}
              title={!canPrint ? "Fix JSON errors first" : "Open print dialog"}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              Download PDF
            </button>
          </div>
        </div>
      </div>

      <div className="no-print mx-auto max-w-6xl px-6 py-6 grid gap-6 md:grid-cols-[360px_1fr]">
        <aside className="space-y-4">
          <div className="flex gap-1 rounded-lg bg-background p-1 border">
            {(["data", "header", "templates"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm capitalize ${
                  tab === t ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === "data" && (
            <div className="rounded-lg border bg-background p-4 space-y-3">
              <h2 className="font-semibold text-sm">Questions JSON</h2>
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
              <textarea
                value={rawJson}
                onChange={(e) => setRawJson(e.target.value)}
                placeholder="…or paste JSON here"
                rows={10}
                className="w-full rounded border px-2 py-1 text-xs font-mono"
              />
              {errors.length > 0 && (
                <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive space-y-1 max-h-60 overflow-auto">
                  <div className="font-semibold">
                    Validation failed ({errors.length}):
                  </div>
                  {errors.map((e, i) => (
                    <div key={i} className="font-mono whitespace-pre-wrap">{e}</div>
                  ))}
                </div>
              )}
              {items && errors.length === 0 && (
                <div className="rounded border border-green-500/40 bg-green-500/5 p-2 text-xs text-green-700">
                  ✓ Valid — {items.length} questions parsed
                </div>
              )}
            </div>
          )}

          {tab === "header" && (
            <div className="rounded-lg border bg-background p-4 space-y-3">
              <h2 className="font-semibold text-sm">Header details</h2>
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
          )}

          {tab === "templates" && (
            <div className="space-y-4">
              <TemplateBox
                title="Header template"
                hint="Tokens: {{academy}} {{category}} {{testTitle}} {{testDate}} {{duration}} {{marks}} {{subjectsTable}}"
                value={headerTpl}
                onChange={setHeaderTpl}
                onReset={() => resetTemplate("header")}
              />
              <TemplateBox
                title="Question template"
                hint="Tokens: {{qno}} {{question}} {{questionImage}} {{options}} {{subject}} {{chapter}}"
                value={questionTpl}
                onChange={setQuestionTpl}
                onReset={() => resetTemplate("question")}
              />
              <TemplateBox
                title="Option template"
                hint="Tokens: {{index}} {{key}} {{text}} {{image}}"
                value={optionTpl}
                onChange={setOptionTpl}
                onReset={() => resetTemplate("option")}
              />
              <TemplateBox
                title="Custom CSS"
                hint="Overrides styles for preview and PDF."
                value={customCss}
                onChange={setCustomCss}
                onReset={() => resetTemplate("css")}
                mono
              />
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            In the print dialog: <b>Save as PDF</b>, margins <b>Default</b>,
            enable <b>Background graphics</b>.
          </p>
        </aside>

        <section className="rounded-lg border bg-background p-4">
          <h2 className="mb-3 font-semibold text-sm text-muted-foreground">Preview</h2>
          <div className="preview-frame">
            <div dangerouslySetInnerHTML={{ __html: paperHtml }} />
          </div>
        </section>
      </div>

      <div className="print-only">
        <div dangerouslySetInnerHTML={{ __html: paperHtml }} />
      </div>
    </div>
  );
}

function TemplateBox({
  title, hint, value, onChange, onReset, mono,
}: {
  title: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  onReset: () => void;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-background p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">{title}</h3>
        <button
          onClick={onReset}
          className="text-xs text-muted-foreground hover:text-foreground underline"
        >
          Reset
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground leading-snug">{hint}</p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        className={`w-full rounded border px-2 py-1 text-xs ${mono !== false ? "font-mono" : ""}`}
        spellCheck={false}
      />
    </div>
  );
}
