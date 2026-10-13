#!/usr/bin/env node
/**
 * ComplyAble accessibility scan: CLI and GitHub Action in one zero-dependency file.
 *
 *   npx github:sachinmaharjan/complyable-scan-action scan https://example.gov --fail-on P1 --format junit --output a11y.xml
 *
 * Exit codes: 0 passed · 1 accessibility threshold failed · 2 usage or service error.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const DEFAULT_API = "https://complyable-one.vercel.app";
const inAction = process.env.GITHUB_ACTIONS === "true" && process.env.INPUT_URL !== undefined;
const RANK = { P1: 1, P2: 2, P3: 3 };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function readConfig() {
  if (inAction) {
    const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
    const lines = (name) => input(name).split("\n").map((s) => s.trim()).filter(Boolean);
    return {
      url: input("url"),
      apiKey: input("api_key"),
      apiUrl: input("api_url") || DEFAULT_API,
      standard: input("standard") || "2.1",
      pages: Number(input("pages") || 10),
      failOn: input("fail_on") || "P1",
      format: input("format") || "junit",
      output: input("output") || "complyable-results.xml",
      cookies: lines("cookies"),
      headers: lines("headers"),
    };
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "api-key": { type: "string" },
      "api-url": { type: "string" },
      standard: { type: "string", default: "2.1" },
      pages: { type: "string", default: "10" },
      "fail-on": { type: "string", default: "P1" },
      format: { type: "string", default: "text" },
      output: { type: "string" },
      cookie: { type: "string", multiple: true },
      header: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  const args = positionals[0] === "scan" ? positionals.slice(1) : positionals;
  if (values.help || !args[0]) {
    console.log(`Usage: complyable scan <url> [options]

  --api-key <key>        API key (or set COMPLYABLE_API_KEY)
  --standard <v>         WCAG version: 2.0 | 2.1 (default, DOJ Title II) | 2.2
  --pages <n>            Pages to crawl, 1-25 (default 10; capped by plan)
  --fail-on <p>          Fail at P1 (default) | P2 | P3 | none
  --format <f>           text (default) | json | junit
  --output <file>        Write the report to a file
  --cookie <name=value>  Session cookie for pages behind a login (repeatable)
  --header <Name: value> Extra header, e.g. Authorization or Vercel protection bypass (repeatable)
  --api-url <url>        ComplyAble API base URL`);
    process.exit(values.help ? 0 : 2);
  }
  return {
    url: args[0],
    apiKey: values["api-key"] ?? process.env.COMPLYABLE_API_KEY ?? "",
    apiUrl: values["api-url"] ?? process.env.COMPLYABLE_API_URL ?? DEFAULT_API,
    standard: values.standard,
    pages: Number(values.pages),
    failOn: values["fail-on"],
    format: values.format,
    output: values.output,
    cookies: values.cookie ?? [],
    headers: values.header ?? [],
  };
}

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
const ghEsc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const meets = (issue, failOn) => failOn !== "none" && issue.kind === "wcag" && RANK[issue.priority] <= RANK[failOn];

function toJunit(report, failOn) {
  const suites = report.pages.map((page) => {
    const cases = page.issues
      .filter((i) => i.kind !== "advisory")
      .map((i) => {
        const name = `${i.priority} ${i.id}${i.criteria.length ? ` (WCAG ${i.criteria.join(", ")})` : ""}`;
        const detail = [
          i.help,
          `${i.nodeCount} instance(s). ${i.description}`,
          ...i.nodes.map((n) => `- ${n.target}\n  ${n.html}`),
          ...i.references.map((r) => `W3C: ${r.understanding}`),
        ].join("\n");
        const body = meets(i, failOn)
          ? `<failure message="${esc(i.help)}" type="${esc(i.priority)}">${esc(detail)}</failure>`
          : `<skipped message="${esc(i.kind === "review" ? "Needs human review" : `Below fail-on threshold (${failOn})`)}"/>`;
        return `    <testcase classname="${esc(page.url)}" name="${esc(name)}">${body}</testcase>`;
      });
    cases.push(`    <testcase classname="${esc(page.url)}" name="Page score ${page.score}/100 (${esc(report.standard)})"/>`);
    const failures = page.issues.filter((i) => meets(i, failOn)).length;
    return `  <testsuite name="${esc(page.title || page.url)}" tests="${cases.length}" failures="${failures}">\n${cases.join("\n")}\n  </testsuite>`;
  });
  const total = report.pages.reduce((n, p) => n + p.issues.filter((i) => meets(i, failOn)).length, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="ComplyAble ${esc(report.standard)}" failures="${total}">\n${suites.join("\n")}\n</testsuites>\n`;
}

function aggregate(report) {
  const map = new Map();
  for (const p of report.pages)
    for (const i of p.issues) {
      if (i.kind !== "wcag") continue;
      const a = map.get(i.id) ?? { ...i, instances: 0, pages: 0 };
      a.instances += i.nodeCount;
      a.pages += 1;
      map.set(i.id, a);
    }
  return [...map.values()].sort((a, b) => RANK[a.priority] - RANK[b.priority] || b.instances - a.instances);
}

function toText(report) {
  const s = report.summary;
  const t = report.threshold;
  const lines = [
    `ComplyAble ${report.standard} scan of ${report.url}${report.authenticated ? " (authenticated)" : ""}`,
    `Score ${s.score}/100 · ${plural(s.pagesScanned, "page")} · ${plural(s.instances, "failure instance")} (P1 ${s.byPriority.P1}, P2 ${s.byPriority.P2}, P3 ${s.byPriority.P3}) · ${s.rules.review} needs review · ${s.rules.advisory} advisory`,
    t.failOn === "none" ? "Threshold: none (report only)" : `${t.passed ? "PASSED" : "FAILED"}: ${t.failingInstances} instances at ${t.failOn} or higher`,
    "",
  ];
  for (const i of aggregate(report).slice(0, 20))
    lines.push(`  ${i.priority}  ${i.help}  [WCAG ${i.criteria.join(", ") || "—"}]  ${i.instances}× on ${plural(i.pages, "page")}`);
  for (const n of report.notices ?? []) lines.push(`\nNotice: ${n}`);
  if (report.errors?.length) lines.push(`\n${report.errors.length} page(s) could not be scanned.`);
  return lines.join("\n");
}

function toMarkdown(report) {
  const s = report.summary;
  const t = report.threshold;
  const verdict = t.failOn === "none" ? "Report only" : t.passed ? "✅ Passed" : `❌ Failed: ${t.failingInstances} instances at ${t.failOn}+`;
  const rows = aggregate(report)
    .slice(0, 25)
    .map((i) => `| ${i.priority} | ${i.help.replace(/\|/g, "\\|")} | ${i.criteria.map((c) => `[${c}](${i.references.find((r) => r.sc === c)?.understanding ?? "#"})`).join(", ") || "—"} | ${i.instances} | ${i.pages} |`);
  const pages = report.pages.map((p) => `| ${p.score} | ${p.failed} | ${p.needsReview} | ${p.url} |`);
  return [
    `## ♿ ComplyAble accessibility scan: ${verdict}`,
    `**${report.standard}** · score **${s.score}/100** · ${plural(s.pagesScanned, "page")} · ${plural(s.instances, "failure instance")} · ${s.rules.review} need review${report.authenticated ? " · authenticated" : ""}`,
    "",
    rows.length ? "| Priority | Issue | WCAG | Instances | Pages |\n|---|---|---|---|---|\n" + rows.join("\n") : "No automated WCAG failures found.",
    "",
    "<details><summary>Pages</summary>\n\n| Score | Failures | Review | URL |\n|---|---|---|---|\n" + pages.join("\n") + "\n\n</details>",
    "",
    "_Automated testing finds a subset of WCAG issues; manual review is still required._",
  ].join("\n");
}

async function main() {
  const cfg = readConfig();
  if (!cfg.apiKey) throw Object.assign(new Error("An API key is required (--api-key or COMPLYABLE_API_KEY)."), { usage: true });
  if (!["P1", "P2", "P3", "none"].includes(cfg.failOn)) throw Object.assign(new Error("fail-on must be P1, P2, P3, or none"), { usage: true });
  if (!["text", "json", "junit"].includes(cfg.format)) throw Object.assign(new Error("format must be text, json, or junit"), { usage: true });

  if (inAction) {
    console.log(`::add-mask::${cfg.apiKey}`);
    for (const c of cfg.cookies) console.log(`::add-mask::${c.slice(c.indexOf("=") + 1)}`);
    for (const h of cfg.headers) console.log(`::add-mask::${h.slice(h.indexOf(":") + 1).trim()}`);
  }

  console.error(`Scanning ${cfg.url} against WCAG ${cfg.standard} AA (up to ${cfg.pages} pages)…`);
  const res = await fetch(new URL("/api/v1/scans", cfg.apiUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}`, "user-agent": "complyable-cli/1" },
    body: JSON.stringify({ url: cfg.url, maxPages: cfg.pages, standard: cfg.standard, failOn: cfg.failOn, cookies: cfg.cookies, headers: cfg.headers }),
    signal: AbortSignal.timeout(330_000),
  });
  const report = await res.json().catch(() => null);
  if (!res.ok && !(res.status === 422 && report?.pages)) {
    throw new Error(report?.error?.message ?? `ComplyAble API returned HTTP ${res.status}`);
  }

  const out = cfg.format === "json" ? JSON.stringify(report, null, 2) : cfg.format === "junit" ? toJunit(report, cfg.failOn) : toText(report);
  if (cfg.output) writeFileSync(cfg.output, out);
  console.log(cfg.output || cfg.format === "text" ? toText(report) : out);

  if (inAction) {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, toMarkdown(report) + "\n");
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `score=${report.summary.score}\npassed=${report.threshold.passed}\nfailing=${report.threshold.failingInstances}\nreport=${cfg.output ?? ""}\n`,
      );
    for (const i of aggregate(report).filter((i) => meets(i, cfg.failOn)).slice(0, 10))
      console.log(`::error title=${ghEsc(`${i.priority} WCAG ${i.criteria.join(", ")}: ${i.id}`)}::${ghEsc(`${i.help}: ${plural(i.instances, "instance")} on ${plural(i.pages, "page")}`)}`);
  }
  return report.threshold.passed || cfg.failOn === "none" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(inAction ? `::error::${ghEsc(err.message)}` : `Error: ${err.message}`);
    process.exit(2);
  },
);
