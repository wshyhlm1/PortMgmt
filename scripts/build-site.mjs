import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { PATHS, ROOT, ensureDir, escapeHtml, pathExists } from './shared.mjs';

const ENCRYPTED_MARKER = 'data-portmgmt-encrypted="v1"';
const DEFAULT_REMEMBER_DAYS = 45;
const DEFAULT_KDF_ITERATIONS = 150000;

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
  if (process.argv.includes('--encrypt')) {
    await encryptSiteFromEnv();
  }
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

async function encryptSiteFromEnv() {
  const env = await loadEnv();
  const password = env.PORTMGMT_PASSWORD || env.PORTMGMT_ACCESS_PASSWORD || env.DAILY_BRIEF_PASSWORD || env.DAILY_BRIEF_ACCESS_PASSWORD || '';
  if (!password) {
    console.log('Encryption disabled (set PORTMGMT_PASSWORD to enable).');
    return;
  }
  const rememberDays = parsePositiveNumber(env.PORTMGMT_REMEMBER_DAYS || env.DAILY_BRIEF_REMEMBER_DAYS, DEFAULT_REMEMBER_DAYS);
  const kdfIterations = Math.max(10000, Math.floor(parsePositiveNumber(env.PORTMGMT_KDF_ITERATIONS, DEFAULT_KDF_ITERATIONS)));
  const htmlFiles = await listHtmlFiles(PATHS.reports);
  let encryptedCount = 0;
  let skippedCount = 0;
  for (const file of htmlFiles) {
    const html = await fs.readFile(file, 'utf8');
    if (isEncryptedHtml(html)) {
      skippedCount += 1;
      continue;
    }
    const sourcePath = path.relative(PATHS.reports, file).split(path.sep).join('/');
    await fs.writeFile(file, encryptHtmlDocument(html, password, sourcePath, { rememberDays, kdfIterations }), 'utf8');
    encryptedCount += 1;
  }
  await fs.writeFile(path.join(PATHS.reports, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');
  console.log(`Encrypted ${encryptedCount} HTML file${encryptedCount === 1 ? '' : 's'} (${skippedCount} already encrypted, remember ${rememberDays}d).`);
  console.log('Built portfolio_reports/robots.txt to disallow indexing.');
}

async function loadEnv() {
  const env = {};
  for (const file of [path.join(ROOT, '.env'), path.join(ROOT, '.env.local')]) {
    if (!(await pathExists(file))) continue;
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith('#')) continue;
      const index = clean.indexOf('=');
      if (index === -1) continue;
      const key = clean.slice(0, index).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      env[key] = clean.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return { ...env, ...process.env };
}

function parsePositiveNumber(raw, fallback) {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isEncryptedHtml(html) {
  return html.slice(0, 1024).includes(ENCRYPTED_MARKER);
}

async function listHtmlFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listHtmlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(fullPath);
    }
  }
  return out;
}

function encryptHtmlDocument(html, password, sourcePath, options) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, options.kdfIterations, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(html, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return renderEncryptedShell({
    sourcePath,
    rememberDays: options.rememberDays,
    kdfIterations: options.kdfIterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    payload: toBase64(Buffer.concat([ciphertext, authTag])),
  });
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function renderEncryptedShell(meta) {
  const payloadJson = JSON.stringify({
    v: 1,
    sourcePath: meta.sourcePath,
    rememberDays: meta.rememberDays,
    iterations: meta.kdfIterations,
    salt: meta.salt,
    iv: meta.iv,
    payload: meta.payload,
  });
  return `<!doctype html>
<html lang="zh-CN" ${ENCRYPTED_MARKER}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <title>PortMgmt · Locked</title>
  <style>
    :root { color-scheme: light dark; --bg:#f5f7f8; --card:#fff; --text:#17202a; --muted:#667085; --border:#d9e0e6; --accent:#0f766e; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    @media (prefers-color-scheme: dark) { :root { --bg:#101317; --card:#171b21; --text:#e6edf3; --muted:#a6b0bd; --border:#2d3742; --accent:#3fb7a7; } }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 20px; background: var(--bg); color: var(--text); }
    .card { width: min(100%, 420px); padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); box-shadow: 0 18px 44px rgba(16, 24, 40, 0.12); }
    .eyebrow { margin: 0 0 6px; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    h1 { margin: 0; font-size: 24px; line-height: 1.2; letter-spacing: 0; }
    .hint { margin: 12px 0 18px; color: var(--muted); font-size: 14px; line-height: 1.6; }
    label { display: block; margin-bottom: 6px; font-size: 14px; font-weight: 650; }
    input[type="password"] { width: 100%; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--text); font: inherit; }
    input[type="password"]:focus { outline: 2px solid color-mix(in srgb, var(--accent), transparent 72%); border-color: var(--accent); }
    .remember { display: flex; align-items: center; gap: 8px; margin: 14px 0 16px; color: var(--muted); font-size: 13px; font-weight: 500; }
    .remember input { width: 16px; height: 16px; }
    button { width: 100%; border: 0; border-radius: 8px; padding: 12px 16px; background: var(--accent); color: #fff; cursor: pointer; font: inherit; font-weight: 700; }
    button:disabled { cursor: wait; opacity: 0.7; }
    .status { min-height: 20px; margin-top: 12px; color: var(--muted); font-size: 13px; }
    .status.error { color: #b42318; }
    .fine-print { margin: 14px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
  </style>
</head>
<body>
  <form class="card" id="unlock-form">
    <p class="eyebrow">PortMgmt</p>
    <h1>输入共享密码</h1>
    <p class="hint">这份组合管理报告已在发布前静态加密。</p>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <label class="remember">
      <input id="remember" type="checkbox" checked>
      <span>记住密码</span>
    </label>
    <button id="unlock-button" type="submit">打开报告</button>
    <div class="status" id="status" aria-live="polite"></div>
    <p class="fine-print">密码不会发送到服务器，只在浏览器本地用于解密页面。</p>
  </form>
  <script>
(function () {
  "use strict";
  var encrypted = ${payloadJson};
  var storageKey = "portmgmt:password:v1";
  var form = document.getElementById("unlock-form");
  var input = document.getElementById("password");
  var remember = document.getElementById("remember");
  var button = document.getElementById("unlock-button");
  var status = document.getElementById("status");
  var decoder = new TextDecoder();
  var encoder = new TextEncoder();

  function setStatus(message, isError) {
    status.textContent = message || "";
    status.classList.toggle("error", Boolean(isError));
  }

  function b64ToBytes(value) {
    var binary = atob(value);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function readRememberedPassword() {
    try {
      var raw = localStorage.getItem(storageKey);
      if (!raw) return "";
      var saved = JSON.parse(raw);
      if (!saved || !saved.password || !saved.expiresAt || saved.expiresAt <= Date.now()) {
        localStorage.removeItem(storageKey);
        return "";
      }
      return saved.password;
    } catch (_) {
      return "";
    }
  }

  function rememberPassword(password) {
    if (!remember.checked) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        password: password,
        expiresAt: Date.now() + encrypted.rememberDays * 24 * 60 * 60 * 1000,
      }));
    } catch (_) {}
  }

  async function deriveKey(password) {
    var baseKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({
      name: "PBKDF2",
      salt: b64ToBytes(encrypted.salt),
      iterations: encrypted.iterations,
      hash: "SHA-256",
    }, baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }

  async function decrypt(password) {
    var key = await deriveKey(password);
    var plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(encrypted.iv) }, key, b64ToBytes(encrypted.payload));
    return decoder.decode(plain);
  }

  async function unlock(password, automatic) {
    if (!window.crypto || !crypto.subtle) {
      setStatus("当前浏览器不支持 Web Crypto，无法解密页面。", true);
      return;
    }
    button.disabled = true;
    setStatus(automatic ? "正在使用已保存的密码打开..." : "正在解密...", false);
    try {
      var html = await decrypt(password);
      rememberPassword(password);
      document.open();
      document.write(html);
      document.close();
    } catch (_) {
      if (automatic) {
        try { localStorage.removeItem(storageKey); } catch (_) {}
      }
      button.disabled = false;
      setStatus("密码不对，或者这份报告使用了不同的旧密码。", true);
      input.focus();
      input.select();
    }
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    unlock(input.value, false);
  });

  var savedPassword = readRememberedPassword();
  if (savedPassword) unlock(savedPassword, true);
})();
  </script>
</body>
</html>`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
