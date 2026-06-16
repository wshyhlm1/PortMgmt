import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PATHS,
  compactWhitespace,
  ensureDir,
  hashId,
  pathExists,
  readJson,
  shortText,
  todayInZone,
  writeJson,
} from '../shared.mjs';

export const ENRICHMENT_TYPES = ['models', 'financials', 'valuation', 'capex'];
export const ENRICHMENT_ROOT = path.join(PATHS.data, 'enrichment');

export async function ensureEnrichmentDirs() {
  for (const type of ENRICHMENT_TYPES) {
    await ensureDir(path.join(ENRICHMENT_ROOT, 'raw', type));
    await ensureDir(path.join(ENRICHMENT_ROOT, 'candidates', type));
  }
  await ensureDir(path.join(ENRICHMENT_ROOT, 'verified'));
  await ensureDir(path.join(ENRICHMENT_ROOT, 'rejected'));
}

export async function appendEnrichmentError(record) {
  await ensureEnrichmentDirs();
  const file = path.join(ENRICHMENT_ROOT, 'errors.json');
  const current = await readJson(file, { errors: [] });
  const key = (item) => `${item.type || ''}|${item.source_url || ''}|${item.message || ''}`;
  current.errors = (current.errors || []).filter((item) => key(item) !== key(record));
  current.errors.push({ at: new Date().toISOString(), ...record });
  await writeJson(file, current);
}

export async function fetchPublicSource(source, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'user-agent': options.userAgent || 'PortMgmt enrichment/0.1 aimee@example.local',
        accept: 'text/html,application/json,text/plain;q=0.8,*/*;q=0.5',
      },
    });
    const body = await response.text();
    const text = htmlToText(body);
    return {
      id: source.id || hashId(source.url),
      fetched_at: new Date().toISOString(),
      status: response.status,
      ok: response.ok,
      provider: source.provider || null,
      source_title: source.title || titleFromHtml(body) || source.url,
      source_url: source.url,
      source_kind: source.kind || 'public_web',
      text_excerpt: shortText(text, 1800),
      text_full: shortText(text, 100000),
      byte_length: Buffer.byteLength(body),
    };
  } catch (error) {
    await appendEnrichmentError({
      type: source.type || 'unknown',
      source_url: source.url,
      message: error.message,
    });
    return {
      id: source.id || hashId(source.url),
      fetched_at: new Date().toISOString(),
      ok: false,
      provider: source.provider || null,
      source_title: source.title || source.url,
      source_url: source.url,
      source_kind: source.kind || 'public_web',
      error: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function writeRawPayload(type, fileBase, payload) {
  await ensureEnrichmentDirs();
  const file = path.join(ENRICHMENT_ROOT, 'raw', type, `${safeFile(fileBase)}.json`);
  await writeJson(file, payload);
  return file;
}

export async function writeCandidatePayload(type, fileBase, rows, meta = {}) {
  await ensureEnrichmentDirs();
  const file = path.join(ENRICHMENT_ROOT, 'candidates', type, `${safeFile(fileBase)}.json`);
  await writeJson(file, {
    generated_at: new Date().toISOString(),
    type,
    ...meta,
    rows,
  });
  return file;
}

export async function readCandidateRows(type) {
  const dir = path.join(ENRICHMENT_ROOT, 'candidates', type);
  if (!(await pathExists(dir))) return [];
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  const rows = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const payload = await readJson(full, null);
    const candidates = Array.isArray(payload) ? payload : payload?.rows || payload?.candidates || [];
    for (const row of candidates) rows.push({ file: path.relative(PATHS.data, full).split(path.sep).join('/'), row });
  }
  return rows;
}

export async function validateEnrichmentType(type) {
  await ensureEnrichmentDirs();
  const candidates = await readCandidateRows(type);
  const verified = [];
  const rejected = [];
  for (const candidate of candidates) {
    const reason = rejectReason(type, candidate.row);
    if (reason) rejected.push({ ...candidate, reason });
    else verified.push(normalizeRow(type, candidate.row));
  }
  await writeJson(path.join(ENRICHMENT_ROOT, 'verified', `${type}.json`), {
    generated_at: new Date().toISOString(),
    type,
    rows: verified,
  });
  await writeJson(path.join(ENRICHMENT_ROOT, 'rejected', `${type}.json`), {
    generated_at: new Date().toISOString(),
    type,
    rows: rejected,
  });
  return { type, verified: verified.length, rejected: rejected.length };
}

export function reportDateFromConfig(config = {}) {
  return todayInZone(config.report_timezone || process.env.REPORT_TZ || 'Asia/Shanghai');
}

export function confidenceValue(row = {}) {
  return String(row.confidence || row.confidence_level || '').toLowerCase();
}

export function safeFile(value = '') {
  return String(value || 'payload').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'payload';
}

export function htmlToText(value = '') {
  return compactWhitespace(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'"));
}

export function titleFromHtml(value = '') {
  const match = String(value || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? compactWhitespace(htmlToText(match[1])) : null;
}

function rejectReason(type, row = {}) {
  if (!row || typeof row !== 'object') return 'not_object';
  if (confidenceValue(row) === 'low') return 'low_confidence';
  if (type === 'models') return rejectModel(row);
  if (type === 'financials') return rejectFinancial(row);
  if (type === 'valuation') return rejectValuation(row);
  if (type === 'capex') return rejectCapex(row);
  return 'unknown_type';
}

function rejectModel(row) {
  for (const field of ['provider', 'model', 'release_date', 'source_title', 'source_url']) {
    if (!row[field]) return `missing_${field}`;
  }
  if (!['exact', 'month', 'estimated'].includes(row.date_confidence)) return 'date_confidence_invalid';
  if (!row.api_pricing || !row.api_pricing.as_of || !row.api_pricing.pricing_url) return 'pricing_missing';
  return null;
}

function rejectFinancial(row) {
  for (const field of ['ticker', 'field', 'period', 'value', 'unit', 'source_title', 'source_url', 'as_of']) {
    if (!row[field]) return `missing_${field}`;
  }
  if (!row.fiscal_year && !row.fiscal_quarter) return 'fiscal_period_missing';
  return null;
}

function rejectValuation(row) {
  for (const field of ['ticker', 'field', 'value', 'period', 'as_of']) {
    if (!row[field]) return `missing_${field}`;
  }
  if (!row.source_title && !row.source_url) return 'source_missing';
  if (!/(x|倍|%|\$|USD|美元|EUR|€|RMB|CNY|¥|KRW|₩|TWD|NT\$|新台币|N\/A)/i.test(String(row.value))) return 'unit_missing';
  return null;
}

function rejectCapex(row) {
  for (const field of ['ticker', 'company', 'field', 'value', 'period', 'source_title', 'source_url', 'as_of']) {
    if (!row[field]) return `missing_${field}`;
  }
  if (!/(Capex|CAPEX|资本开支|capital|capacity|AI|cloud|数据中心)/i.test(`${row.field} ${row.value}`)) return 'not_capex_related';
  if (!/(B|M|亿|美元|人民币|欧元|韩元|新台币|\$|€|¥|₩|GW|MW|%)/i.test(String(row.value))) return 'unit_missing';
  return null;
}

function normalizeRow(type, row) {
  const confidence = confidenceValue(row) || 'medium';
  if (type === 'models') {
    return {
      provider: row.provider,
      model: row.model,
      release_date: row.release_date,
      date_confidence: row.date_confidence,
      context_window: row.context_window || null,
      modalities: Array.isArray(row.modalities) ? row.modalities : [],
      key_capabilities: row.key_capabilities || null,
      api_pricing: row.api_pricing,
      next_model_info: row.next_model_info || null,
      source_title: row.source_title,
      source_url: row.source_url,
      confidence,
    };
  }
  return { ...row, confidence };
}
