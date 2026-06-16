import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDir, escapeHtml, pathExists } from './shared.mjs';

async function main() {
  await ensureDir(PATHS.reports);
  const reports = await findReports();
  if (!reports.length) {
    throw new Error('No dated reports found. Run npm run render first.');
  }
  const latest = reports.at(-1);
  await fs.copyFile(latest.html, path.join(PATHS.reports, 'index.html'));
  await fs.writeFile(path.join(PATHS.reports, 'archive.html'), renderArchive(reports, latest.date), 'utf8');
  await fs.writeFile(path.join(PATHS.reports, '.nojekyll'), '', 'utf8');
  console.log(`Built portfolio_reports/index.html from ${latest.date}.`);
}

async function findReports() {
  const entries = await fs.readdir(PATHS.reports, { withFileTypes: true });
  const reports = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const html = path.join(PATHS.reports, entry.name, `${entry.name}.html`);
    const json = path.join(PATHS.reports, entry.name, `${entry.name}.json`);
    const md = path.join(PATHS.reports, entry.name, `${entry.name}.md`);
    if (await pathExists(html)) {
      reports.push({
        date: entry.name,
        html,
        has_json: await pathExists(json),
        has_md: await pathExists(md),
      });
    }
  }
  return reports.sort((a, b) => a.date.localeCompare(b.date));
}

function renderArchive(reports, latestDate) {
  const rows = reports.slice().reverse().map((report) => `<tr>
    <td data-label="Date"><a href="${escapeHtml(report.date)}/${escapeHtml(report.date)}.html">${escapeHtml(report.date)}</a>${report.date === latestDate ? ' <span class="pill">latest</span>' : ''}</td>
    <td data-label="HTML"><a href="${escapeHtml(report.date)}/${escapeHtml(report.date)}.html">HTML</a></td>
    <td data-label="JSON">${report.has_json ? `<a href="${escapeHtml(report.date)}/${escapeHtml(report.date)}.json">JSON</a>` : '<span class="muted">missing</span>'}</td>
    <td data-label="Markdown">${report.has_md ? `<a href="${escapeHtml(report.date)}/${escapeHtml(report.date)}.md">MD</a>` : '<span class="muted">missing</span>'}</td>
  </tr>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PortMgmt Archive</title>
  <style>
    :root { color-scheme: light dark; --bg:#f4f6f8; --card:#fff; --text:#17202a; --muted:#667085; --border:#d9e0e6; --accent:#0f766e; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    @media (prefers-color-scheme: dark) { :root { --bg:#101317; --card:#171b21; --text:#e6edf3; --muted:#a6b0bd; --border:#2d3742; --accent:#3fb7a7; } }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-size:14px; line-height:1.55; }
    main { max-width: 920px; margin: 0 auto; padding: 28px 16px 48px; }
    h1 { margin:0 0 4px; letter-spacing:0; }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .muted { color:var(--muted); }
    .card { margin-top:18px; background:var(--card); border:1px solid var(--border); border-radius:8px; overflow:hidden; }
    table { width:100%; border-collapse:collapse; }
    th, td { padding:11px 12px; border-bottom:1px solid var(--border); text-align:left; }
    th { color:var(--muted); background: color-mix(in srgb, var(--card), var(--bg) 40%); font-size:12px; }
    tr:last-child td { border-bottom:0; }
    .pill { display:inline-flex; padding:2px 7px; border:1px solid var(--border); border-radius:999px; color:var(--muted); font-size:12px; }
    @media (max-width: 640px) { table, thead, tbody, tr, th, td { display:block; } thead { display:none; } td { display:grid; grid-template-columns:90px minmax(0,1fr); gap:8px; border:0; } td::before { content:attr(data-label); color:var(--muted); } tr { border-bottom:1px solid var(--border); } }
  </style>
</head>
<body>
  <main>
    <h1>PortMgmt Archive</h1>
    <div class="muted">Latest report: ${escapeHtml(latestDate)}</div>
    <div class="card">
      <table>
        <thead><tr><th>Date</th><th>HTML</th><th>JSON</th><th>Markdown</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </main>
</body>
</html>`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
