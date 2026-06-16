import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const PATHS = {
  initial: path.join(ROOT, 'initial'),
  uploads: path.join(ROOT, 'uploads'),
  data: path.join(ROOT, 'data'),
  dataQuality: path.join(ROOT, 'data', 'data_quality'),
  market: path.join(ROOT, 'data', 'market'),
  marketCache: path.join(ROOT, 'data', 'market_cache'),
  snapshots: path.join(ROOT, 'data', 'snapshots'),
  reports: path.join(ROOT, 'portfolio_reports'),
  config: path.join(ROOT, 'portfolio.config.json'),
};

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function relativeToRoot(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

export async function listFilesRecursive(dir, extensions = null) {
  if (!(await pathExists(dir))) return [];
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listFilesRecursive(full, extensions));
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!extensions || extensions.includes(ext)) out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function todayInZone(timeZone = process.env.REPORT_TZ || 'Asia/Shanghai', date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function snapshotName(date = new Date()) {
  return `${date.toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`;
}

export function hashId(...parts) {
  return createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 12);
}

export function stripMarkdown(value = '') {
  return String(value)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .trim();
}

export function compactWhitespace(value = '') {
  return stripMarkdown(value).replace(/\s+/g, ' ').trim();
}

export function excerpt(value = '', max = 900) {
  const clean = compactWhitespace(value);
  if (clean.length <= max) return clean || null;
  return `${clean.slice(0, max - 1)}...`;
}

export function shortText(value = '', max = 160) {
  const clean = compactWhitespace(value);
  if (!clean) return null;
  if (clean.length <= max) return clean;
  const clipped = clean.slice(0, max);
  const boundary = Math.max(clipped.lastIndexOf('。'), clipped.lastIndexOf('；'), clipped.lastIndexOf(';'));
  return `${(boundary > 48 ? clipped.slice(0, boundary + 1) : clipped).trim()}...`;
}

export function containsMarkdownTable(value = '') {
  const text = String(value || '');
  return /^\s*\|.+\|\s*$/m.test(text) || /\|\s*:?-{2,}:?\s*\|/.test(text);
}

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function splitTags(value = '') {
  const clean = stripMarkdown(value)
    .replace(/[，、/|;；]/g, ',')
    .replace(/#/g, ',')
    .replace(/\s{2,}/g, ',');
  return [...new Set(clean.split(',').map((tag) => tag.trim()).filter(Boolean))];
}

export function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function missingLabel(value, label = '待补充') {
  if (value === null || value === undefined) return label;
  if (Array.isArray(value) && value.length === 0) return label;
  if (typeof value === 'string' && value.trim() === '') return label;
  return value;
}

export function parseMarkdownTables(markdown = '') {
  const lines = markdown.split(/\r?\n/);
  const tables = [];
  let block = [];
  const flush = () => {
    if (block.length < 2) {
      block = [];
      return;
    }
    const rows = block.map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => stripMarkdown(cell.trim())));
    const separatorIndex = rows.findIndex((row) => row.every((cell) => /^:?-{2,}:?$/.test(cell)));
    const header = rows[0] || [];
    const body = rows.slice(separatorIndex === 1 ? 2 : 1).filter((row) => row.some(Boolean));
    if (header.length && body.length) tables.push({ header, rows: body });
    block = [];
  };
  for (const line of lines) {
    if (/^\s*\|.+\|\s*$/.test(line)) block.push(line);
    else flush();
  }
  flush();
  return tables;
}

export function keyValueFromTables(markdown = '') {
  const result = {};
  for (const table of parseMarkdownTables(markdown)) {
    if (table.header.length < 2) continue;
    for (const row of table.rows) {
      const key = compactWhitespace(row[0]);
      const value = compactWhitespace(row.slice(1).join(' / '));
      if (key && value && key.length <= 24) result[key] = value;
    }
  }
  return result;
}

export function headingLevel(line) {
  const match = line.match(/^(#{1,6})\s+/);
  return match ? match[1].length : 0;
}

export function extractSection(markdown = '', patterns = []) {
  const lines = markdown.split(/\r?\n/);
  const tests = patterns.map((pattern) => (pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i')));
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!headingLevel(lines[i])) continue;
    const clean = compactWhitespace(lines[i]);
    if (tests.some((test) => test.test(clean))) {
      start = i + 1;
      level = headingLevel(lines[i]);
      break;
    }
  }
  if (start === -1) return '';
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const nextLevel = headingLevel(lines[i]);
    if (nextLevel && nextLevel <= level) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

export function extractModule(markdown = '', moduleNumber) {
  return extractSection(markdown, [new RegExp(`模块\\s*${moduleNumber}`)]);
}

export function parseBullets(markdown = '') {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^[-*]\s+(.+)$/) || line.match(/^\d+[.)、]\s*(.+)$/);
      return match ? compactWhitespace(match[1]) : null;
    })
    .filter(Boolean);
}

export function normalizeExactDate(text = '') {
  const iso = String(text).match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const zh = String(text).match(/\b(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\b/);
  if (zh) return `${zh[1]}-${zh[2].padStart(2, '0')}-${zh[3].padStart(2, '0')}`;
  return null;
}

export function dateText(text = '') {
  const exact = normalizeExactDate(text);
  if (exact) return exact;
  const ym = String(text).match(/\b(20\d{2})[-/年](\d{1,2})\s*月?\b/);
  if (ym) return `${ym[1]}-${ym[2].padStart(2, '0')}`;
  const quarter = String(text).match(/\b(20\d{2})\s*(?:Q|年Q|年第?)([1-4])\b/i);
  if (quarter) return `${quarter[1]}Q${quarter[2]}`;
  return compactWhitespace(text).slice(0, 24) || null;
}

export function detectImpactDirection(text = '') {
  const clean = compactWhitespace(text);
  const positive = /(正面|积极|利好|上调|增长|超预期|强劲|受益|改善|放量|提升|增量|看多|首选)/.test(clean);
  const negative = /(负面|消极|利空|下调|风险|限制|收紧|削去|下降|承压|诉讼|调查|制裁|禁令)/.test(clean);
  if (positive && negative) return 'mixed';
  if (positive) return 'positive';
  if (negative) return 'negative';
  if (/中性|符合预期|不确定/.test(clean)) return 'neutral';
  return 'unknown';
}

export function eventTagsFromText(text = '') {
  const tags = [];
  const rules = [
    ['#财报', /(财报|业绩会|earnings|10-Q|10-K|6-K|8-K)/i],
    ['#产品发布', /(发布|推出|launch|产品|模型|芯片|设备)/i],
    ['#分析师预期', /(分析师|大摩|高盛|评级|目标价|预期|consensus)/i],
    ['#高管变动', /(CEO|CFO|高管|任命|离任|管理层)/i],
    ['#监管', /(监管|法案|SEC|出口管制|禁令|反垄断|诉讼|调查|FDPR)/i],
    ['#供应链', /(供应链|订单|backlog|产能|客户|供应商|HBM|CoWoS|EUV|DUV)/i],
    ['#Rumor', /(Rumor|传闻|爆料|匿名|WSB|Twitter|X\/Twitter|社交平台)/i],
    ['#公司公告', /(公司公告|正式公告|press release|投资者日|IR)/i],
  ];
  for (const [tag, test] of rules) {
    if (test.test(text)) tags.push(tag);
  }
  return [...new Set(tags)];
}

export function classifyEventLevel({ text = '', sourceUrl = null, sourceFile = null } = {}) {
  const clean = compactWhitespace(text);
  if (!sourceUrl && !sourceFile) return 'draft';
  if (/(Rumor|传闻|爆料|匿名|WSB|Twitter|X\/Twitter|社交平台|自媒体|非权威)/i.test(clean)) return 'L3';
  if (sourceUrl && /(sec\.gov|\/ir\/|investor|investors|press-release|earnings|annualreports|公告)/i.test(sourceUrl)) return 'L1';
  if (sourceUrl && /(bloomberg|reuters|wsj|semianalysis|nikkei|financialtimes|ft\.com|theinformation)/i.test(sourceUrl)) return 'L2';
  if (sourceFile) return 'L2';
  return 'draft';
}

export function verificationStatusForLevel(level) {
  if (level === 'L1') return '已确认：需保留原文链接与 Obsidian/Bosidian 路径';
  if (level === 'L2') return '待验证：来自本地资料或权威二级来源，需补原始链接/验证进度';
  if (level === 'L3') return '流言归档：不进入确认催化，不参与核心摘要';
  return '待补充来源：默认不进入催化';
}

export function inferGroup(company = {}) {
  const subIndustry = String(company.sub_industry || '');
  const tagText = (company.tags || []).join(' ');
  if (/半导体设备|光刻|EUV|DUV/i.test(subIndustry)) return '半导体设备';
  if (/OSAT|封测|封装与测试/i.test(subIndustry)) return 'OSAT';
  if (/晶圆代工|Foundry|FAB|代工/i.test(subIndustry)) return 'FAB';
  if (/光互联|光网络|光模块|光通信|Optical/i.test(subIndustry)) return '光互联';
  if (/通信设备|Communication Equipment|电信/i.test(subIndustry)) return '通信设备';
  if (/功率半导体|汽车半导体|MCU|连接安全/i.test(subIndustry)) return '功率/汽车半导体';
  if (/云|Cloud|Hyperscaler/i.test(subIndustry)) return '云厂商';
  if (/OSAT|封测|封装与测试/i.test(tagText)) return 'OSAT';
  if (/FAB|晶圆|Foundry|代工|台积电|三星/i.test(tagText)) return 'FAB';
  if (/半导体设备|光刻|EUV|DUV/i.test(tagText)) return '半导体设备';
  if (/GPU/i.test(tagText)) return 'GPU';
  if (/ASIC|TPU/i.test(tagText)) return 'ASIC';
  if (/光互联|光网络|光模块|CPO|Optical/i.test(tagText)) return '光互联';
  if (/云|Cloud|Hyperscaler/i.test(tagText)) return '云厂商';
  if (/通信|网络|电信|RAN|5G|6G/i.test(tagText)) return '通信设备';
  if (/软件|AI平台|大模型|企业AI/i.test(tagText)) return '软件/AI应用';
  if (/软件|AI平台|大模型|企业AI/i.test(subIndustry)) return '软件/AI应用';
  return '未分组';
}

export function sortByOrder(items = []) {
  return [...items].sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : 9999;
    const bo = Number.isFinite(b.order) ? b.order : 9999;
    return ao - bo || String(a.ticker || a.id || '').localeCompare(String(b.ticker || b.id || ''));
  });
}
