import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PATHS,
  compactWhitespace,
  eventTagsFromText,
  listFilesRecursive,
  normalizeExactDate,
  readJson,
  shortText,
  writeJson,
} from './shared.mjs';

async function main() {
  const env = await loadLocalEnv();
  const config = await readJson(PATHS.config, {});
  const companies = (await readJson(path.join(PATHS.data, 'companies.json'), { companies: [] })).companies || [];
  const aliases = await readJson(path.join(PATHS.data, 'company_aliases.json'), {});
  const vaultPath = env.OBSIDIAN_VAULT_PATH || config.obsidian_vault_path || config.obsidianVaultPath || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    await writeJson(path.join(PATHS.data, 'obsidian_hits.json'), {
      meta: { status: 'not_configured', message: 'OBSIDIAN_VAULT_PATH 未配置' },
      hits: [],
      warnings: ['Obsidian 未配置；profile 候选事件无法本地验证。'],
    });
    console.log('Obsidian scan skipped: OBSIDIAN_VAULT_PATH is not configured.');
    return;
  }
  const resolvedVault = path.resolve(vaultPath);
  let files = [];
  try {
    files = await listFilesRecursive(resolvedVault, ['.md', '.markdown']);
  } catch (error) {
    await writeJson(path.join(PATHS.data, 'obsidian_hits.json'), {
      meta: { status: 'not_available', vault_path: resolvedVault, message: error.message },
      hits: [],
      warnings: [`Obsidian 路径不可用：${resolvedVault}`],
    });
    console.log(`Obsidian scan skipped: ${resolvedVault} is not available.`);
    return;
  }
  const includeGlobs = splitList(env.OBSIDIAN_INCLUDE_GLOBS || config.obsidian_include_globs || 'stk/**/*.md,inbox/stk/**/*.md,knowledge/qa/*stk*.md');
  const excludeGlobs = splitList(env.OBSIDIAN_EXCLUDE_GLOBS || config.obsidian_exclude_globs || '_system/**,_claude_review_output_*/**,title-content-fix-review/**,**/attachments/**');
  const maxHits = Number(env.OBSIDIAN_MAX_HITS || config.obsidian_max_hits || 240);
  const filtered = files.filter((file) => globAllowed(path.relative(resolvedVault, file), includeGlobs, excludeGlobs));
  const hits = [];
  for (const file of filtered) {
    const text = await fs.readFile(file, 'utf8');
    const frontmatter = parseFrontmatter(text);
    const body = text.replace(/^---[\s\S]*?---\s*/, '');
    const matchedCompanies = matchCompanies(body, frontmatter, companies, aliases, file, resolvedVault);
    for (const match of matchedCompanies) {
      const displayBody = sanitizeNoteBody(body);
      const title = inferTitle(displayBody || body, file);
      if (isRawTableOnlyNote(title, displayBody)) continue;
      const sourceUrl = inferSourceUrl(frontmatter, body);
      const level = inferLevel(body, sourceUrl, frontmatter);
      const eventText = `${title} ${displayBody}`;
      const eventType = inferEventType(eventText);
      const summary = shortText(displayBody || title, 180);
      if (!eventType && !isHighSignalText(`${title} ${summary}`)) continue;
      hits.push({
        ticker: match.company.ticker,
        display_name: aliases[match.company.ticker]?.display || `${match.company.ticker}${aliases[match.company.ticker]?.short_cn ? ` · ${aliases[match.company.ticker].short_cn}` : ''}`,
        file: path.relative(resolvedVault, file).split(path.sep).join('/'),
        absolute_file: file,
        date: normalizeExactDate(frontmatter.date || body) || null,
        title,
        summary,
        event_type: eventType || 'research_note',
        impact: inferImpact(`${title} ${summary}`),
        tags: [...new Set([...(splitList(frontmatter.tags || '') || []), ...eventTagsFromText(displayBody)])],
        level,
        sourceUrl,
        source_url: sourceUrl,
        validationStatus: sourceUrl ? (level === 'L1' ? 'confirmed' : 'watching') : 'needs_source',
        validation_status: sourceUrl ? (level === 'L1' ? 'confirmed' : 'watching') : 'needs_source',
        matchedBy: match.matchedBy,
        matched_by: match.matchedBy,
        sourceType: 'obsidian',
        source_type: 'obsidian',
        why_it_matters: shortText(inferWhyItMatters(`${title} ${summary}`), 120),
      });
    }
  }
  const deduped = dedupeBy(hits, (hit) => `${hit.ticker}|${hit.file}|${hit.title}`)
    .sort((a, b) => hitRank(b) - hitRank(a) || String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, maxHits);
  await writeJson(path.join(PATHS.data, 'obsidian_hits.json'), {
    meta: {
      status: 'ok',
      vault_path: resolvedVault,
      scanned_files: filtered.length,
      hit_count: deduped.length,
      total_matches_before_limit: hits.length,
      include_globs: includeGlobs,
      exclude_globs: excludeGlobs,
      max_hits: maxHits,
    },
    hits: deduped,
    warnings: [],
  });
  console.log(`Obsidian hits written: ${deduped.length} (${filtered.length} files scanned, ${hits.length} matches before limit)`);
}

async function loadLocalEnv() {
  const envPath = path.join(PATHS.data, '..', '.env.local');
  try {
    const text = await fs.readFile(envPath, 'utf8');
    return Object.fromEntries(text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
      }));
  } catch {
    return {};
  }
}

function parseFrontmatter(text) {
  const match = text.match(/^---\s*([\s\S]*?)\s*---/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([^:]+):\s*(.*)$/);
    if (!item) continue;
    out[item[1].trim()] = item[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function matchCompanies(body, frontmatter, companies, aliases, file, vaultPath) {
  const relative = path.relative(vaultPath, file).split(path.sep).join('/');
  const haystack = compactWhitespace([
    relative,
    body.slice(0, 4000),
    frontmatter.ticker,
    frontmatter.tags,
    frontmatter.aliases,
  ].filter(Boolean).join(' '));
  const out = [];
  for (const company of companies) {
    const probes = [
      [company.ticker, 'ticker'],
      [company.display_ticker, 'ticker'],
      [company.company_name, 'alias'],
      [company.chinese_name, 'alias'],
      [aliases[company.ticker]?.short_cn, 'alias'],
      [aliases[company.ticker]?.display, 'alias'],
    ].filter(([value]) => value);
    const matched = probes.find(([value, type]) => {
      const probe = String(value).replace(/\..+$/, '').trim();
      if (!probe || probe.length < 2) return false;
      return probeMatches(haystack, probe, type);
    });
    if (matched) out.push({ company, matchedBy: matched[1] });
  }
  return out;
}

function probeMatches(haystack, probe, type) {
  if (type === 'ticker' && /^[A-Z0-9]{1,4}$/.test(probe)) {
    const escaped = probe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(haystack);
  }
  return haystack.includes(probe);
}

function inferTitle(body, file) {
  const heading = body.split(/\r?\n/).find((line) => /^#\s+/.test(line));
  return heading ? compactWhitespace(heading.replace(/^#\s+/, '')) : path.basename(file, path.extname(file));
}

function sanitizeNoteBody(markdown = '') {
  const lines = String(markdown || '').split(/\r?\n/);
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (isMarkdownTableLine(line)) continue;
    const clean = line
      .replace(/!\[[^\]]*]\([^)]+\)/g, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .trim();
    if (!clean) continue;
    if (/^(Table|表)\s*\d+/i.test(clean)) continue;
    if (/^(原始文件|原件路径|图片|OCR|附件)\s*[：:]\s*$/.test(clean)) continue;
    out.push(clean);
  }
  return out.join('\n').trim();
}

function isMarkdownTableLine(line = '') {
  const text = String(line || '').trim();
  return /^\|.+\|$/.test(text) || /\|\s*:?-{2,}:?\s*\|/.test(text);
}

function isRawTableOnlyNote(title = '', body = '') {
  const clean = compactWhitespace(body);
  return /原始数据表|raw data table/i.test(title)
    && (!clean || clean.length < 120 || !/(财报|电话会|CapEx|CAPEX|资本开支|指引|订单|产能|客户|监管|诉讼|模型|发布|上调|下调)/i.test(clean));
}

function inferSourceUrl(frontmatter, body) {
  const direct = frontmatter.source || frontmatter.url || frontmatter.originalUrl || frontmatter.original_url;
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  return (body.match(/https?:\/\/[^\s)）]+/) || [null])[0];
}

function inferLevel(body, sourceUrl, frontmatter) {
  const confidence = String(frontmatter.confidence || '').toUpperCase();
  if (['L1', 'L2', 'L3'].includes(confidence)) return confidence;
  if (/Rumor|传闻|爆料|自媒体|未证实/i.test(body)) return 'L3';
  if (sourceUrl && /(sec\.gov|investor|ir\.|press-release|earnings|annualreports)/i.test(sourceUrl)) return 'L1';
  if (sourceUrl) return 'L2';
  return 'unknown';
}

function inferEventType(text = '') {
  const rules = [
    ['earnings', /财报|业绩会|电话会|earnings|FY\d{2}|Q[1-4]/i],
    ['guidance_change', /指引|上调|下调|raised|lowered|guidance/i],
    ['capex_change', /CapEx|CAPEX|资本开支|上修|扩产/i],
    ['capacity_update', /产能|CoWoS|HBM|EUV|CPO|机柜|订单|backlog|供给|交期/i],
    ['product_launch', /发布|推出|launch|Rubin|Blackwell|TPU|ASIC|Gemini|Claude|GPT|Qwen|DeepSeek|Grok/i],
    ['regulation', /监管|出口管制|关税|法案|诉讼|调查|禁令/i],
    ['customer_order', /客户|订单|Google|Meta|Amazon|Microsoft|Oracle|NVIDIA|英伟达/i],
    ['financing', /融资|发债|回购|分红|股息|convertible|debt/i],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

function inferImpact(text = '') {
  if (/下调|承压|风险|限制|禁令|利空|削减|下滑|低于预期|miss/i.test(text)) return 'negative';
  if (/上调|超预期|强劲|利好|增长|扩产|订单|受益|raised|beat/i.test(text)) return 'positive';
  if (/不确定|mixed|分歧|波动/i.test(text)) return 'mixed';
  return 'watch';
}

function inferWhyItMatters(text = '') {
  const clean = compactWhitespace(text);
  const sentence = clean.split(/[。；;.!?]/).find((part) => /(收入|利润|CapEx|CAPEX|订单|产能|客户|供应链|模型|算力|AI|风险|监管)/i.test(part));
  return sentence || clean;
}

function isHighSignalText(text = '') {
  return /(财报|电话会|CapEx|CAPEX|资本开支|指引|上调|下调|订单|产能|客户|监管|诉讼|模型|发布|AI|Rubin|Blackwell|TPU|HBM|CoWoS|CPO)/i.test(text);
}

function hitRank(hit) {
  let score = 0;
  if (hit.source_url) score += 12;
  if (hit.level === 'L1') score += 10;
  if (hit.level === 'L2') score += 6;
  if (hit.impact === 'positive' || hit.impact === 'negative') score += 5;
  if (hit.date) score += 3;
  if (/stk\/resources|inbox\/stk/.test(hit.file)) score += 2;
  if (/财报|电话会|CapEx|资本开支|指引|订单|产能|发布/.test(hit.title)) score += 3;
  return score;
}

function splitList(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/[,\n;；]/).map((item) => item.trim()).filter(Boolean);
}

function globAllowed(relativePath, includes, excludes) {
  if (excludes.some((glob) => globMatch(relativePath, glob))) return false;
  if (!includes.length) return true;
  return includes.some((glob) => globMatch(relativePath, glob));
}

function globMatch(value, glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function dedupeBy(items, getKey) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
