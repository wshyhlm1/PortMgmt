# PortMgmt

本项目是“本地优先 + DailyBrief 风格静态网页”的美股科技持仓组合跟踪原型。首版流水线会读取 `initial/*_profile.md` 和 `uploads/` 中的 Markdown/CSV，生成结构化 JSON、每日 HTML/JSON/Markdown 报告、`index.html` 与 `archive.html`。

## 本地生成

```bash
npm install
npm run build
```

生成后的入口是：

```text
portfolio_reports/index.html
```

也可以运行完整日常流程：

```bash
npm run daily
```

`build` 会按 `import -> supplemental -> obsidian -> market -> events -> render -> quality -> build-site -> market:live -> validate-report` 执行完整链路。`daily` 也使用同一链路，并在 `.env.local` 缺少 `DEPLOY_HOST` 或 `DEPLOY_PATH` 时跳过自托管部署，不会让本地生成失败。

## 盘中行情刷新

报告页的 `刷新行情` 按钮只读取已经生成或服务端提供的 JSON，不会在纯静态 HTML 中主动运行本地脚本。

静态 GitHub Pages 模式：

```bash
npm run market:live
```

该命令生成：

- `data/market_live/latest.json`
- `portfolio_reports/market_live.json`

页面默认优先读取 `/market_live.json`，失败后尝试 `data/market_live/latest.json` 等 fallback 路径。若文件不存在，页面会提示：`当前部署模式不支持实时刷新，请运行 npm run market:live 生成最新行情。`

本地或自托管模式：

- 可用 cron 每 1 分钟或 5 分钟运行 `npm run market:live`，让静态按钮读取最新 `market_live.json`。
- 也可以用 nginx 反代、serverless、小型本地服务提供 `/api/market/live`，并把 `portfolio.config.json` 的 `market.live_endpoint` 改为该接口。
- 纯静态 HTML 不能直接执行 Node 脚本；实时刷新需要本地小服务、serverless、nginx 反代接口或预生成 JSON。

行情源不依赖付费 API。脚本优先尝试东方财富公开接口，覆盖不足时 fallback 到 Yahoo chart/page，再 fallback 到 Stooq 日线 CSV。公开源失败时保留上一版 live JSON，并在 `errors` 中记录原因，页面保留旧值并显示失败或缺项状态。

## 第三轮质量原则

页面只展示 verified 数据。无法通过 schema、语义或可见文本校验的数据不会进入 HTML，会落入 rejected/candidate 文件或缺口提示。

- 指引：页面只读 `data/guidance/guidance_verified.json` 对应的结构化行；无法归入白名单指标、value 是年份/长句、comment 未中文化、日期无法推断的候选会进入 `data/guidance/guidance_rejected.json`。
- 资料库：原始扫描保留在 `data/obsidian_hits_raw.json`；页面只展示 `data/obsidian_hits_verified.json` 中每个 ticker 最多 8 条高质量命中，不展示本地路径、URL、source 或 confidence。
- 估值：Forward PE、EV/EBITDA、FCF Yield 和未来 EPS 不硬填。页面只读取 `data/valuation_verified.json` 中带 `source_title/source_url`、`period`、`as_of`、`confidence` 的 verified 行；HTML 只展示简短资料标题和数据日期，不展示完整 URL。
- AI Capex：三张主表不再展示“相关公司/相关持仓/映射持仓”列，改为短句 `传导说明`。数值列只展示带期间和单位的 Capex/产能信息；`待核对`、raw URL、长英文说明进入 data quality 或 rejected。
- LLM：Qwen 输出只作为 candidate，不能直接进入 HTML。估值候选先放到 `data/llm_candidates/valuation/*.json`，运行 `npm run llm:validate` 后，合格字段才写入 `data/valuation_verified.json` 并供后续渲染使用。
- 模型：顶部发布时间线范围固定为 2025-06-06 至 2026-06-06，只展示 high/medium、最多 12 条、日期倒序；模型表要求来源明确、字段完整度至少 5 个有效字段，不渲染空 provider 分组。
- 财务：`initial/*_profile.md` 中可验证的财务表先进入 `data/financials/candidates/from_profiles.json`，再在期间、指标、单位、来源明确时合并到 `financial_history_verified.json`；页面显示 `financial_coverage_summary.json` 的年度/季度/核心字段覆盖率。
- 展示：业务拆分收入/占比必须带币种、单位和百分比，并在 JSON 中写入 `display/share_display/revenue_value/currency`；估值缺口文本以最终 render 状态反推，区分 `缺失`、`有候选但未验证`、已 verified，不展示裸财务数字或 `-` 占位。
- 总览：驱动因素使用 `[市场背景]`、`[财报/指引]`、`[公司事件]`、`[行业链]`、`[暂无高置信驱动]` 标签，并在 JSON 中保留 `driver_type` / `driver_label`。
- 风险：优先展示 profile/source-backed 的公司特异性风险摘要；无新增高置信公司特异性风险时显示统一占位，不用地缘政治、出口管制、监管模板硬填每家公司。

AI Capex 当前表结构：

- 海外CSP / 国内链：`公司、最近4季度Capex、最新季度Capex、最新全年指引、上次指引、调整幅度、管理层/机构评价、传导说明`
- 持仓公司Capex：`Ticker、公司、最近4季度Capex、最新季度Capex、YoY/QoQ、最新指引、投资重点、资金压力、传导说明`

## Qwen 百炼

Qwen adapter 是可选能力，默认关闭。API key 放 `.env.local` 或 CI Secret，不写入发布产物。

`.env.example` 中的相关变量：

```bash
LLM_PROVIDER=qwen
DASHSCOPE_API_KEY=
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-plus
QWEN_REASONING_EFFORT=high
LLM_ENABLED=false
```

Qwen 仅用于资料摘要、翻译清洗、候选结构化、公开网页 raw text 转 candidate、watchlist 初始 profile candidate 和缺口补充提示。Qwen 不直接写 HTML，不覆盖 verified JSON，不在无来源时编造财务或估值数据。`LLM_ENABLED=false` 时，`npm run llm:tasks` 和 `npm run llm:validate` 仍可运行，不调用 API。

估值补充流程：

```bash
npm run llm:tasks
# 人工或 LLM 将估值候选保存到 data/llm_candidates/valuation/*.json
npm run llm:validate
npm run render
npm run build-site
npm run validate
```

## 公开数据补充层

公开数据抓取不直接进入 HTML。所有补充数据按下面流程进入项目：

```text
data/enrichment/
  raw/<models|financials|valuation|capex>/
  candidates/<models|financials|valuation|capex>/
  verified/<models|financials|valuation|capex>.json
  rejected/<models|financials|valuation|capex>.json
```

工作流：

```bash
npm run enrich:models
npm run models:timeline
npm run enrich:financials
npm run enrich:valuation
npm run enrich:capex
npm run enrich:validate
npm run financials:fetch
npm run financials:validate
```

- `raw` 保存官方或公开页面抓取结果和摘录。
- `candidates` 保存结构化候选。
- `verified` 只收录 schema 合格、来源/日期/口径完整且非低置信的数据。
- `rejected` 保存低置信、缺来源、缺单位、字段不匹配或非对应主题的数据。
- 抓取失败不会让 build 失败，会记录到 `data/enrichment/errors.json`。
- 模型发布时间线输出到 `data/enrichment/verified/model_release_timeline.json`，缺口文档见 `docs/model_release_data_gap.md`。
- 财务历史输出到 `data/financials/financial_history_verified.json`，缺口文档见 `docs/financial_history_data_gap.md`。

Capex 兼容层同时写入：

```text
data/capex/raw/
data/capex/candidates/
data/capex/verified.json
data/capex/rejected.json
```

模型发布数据优先抓厂商官方模型文档、pricing、changelog 和 announcement；上市公司财务优先用 SEC companyfacts / submissions，其次公司 IR 年报/季报、台湾 MOPS、韩国 DART。估值与 Capex 只在来源、期间、单位和置信度通过校验后进入 verified。LLM/Qwen 只能生成 candidate、翻译、PDF/HTML 摘要或 parsing hint，不能直接写 verified JSON 或 HTML。

模型发布补齐：

```bash
npm run enrich:models
npm run models:timeline
npm run enrich:validate
```

模型价格展示规则：

- 已解析官方价格：显示 `输入 $x / 1M tokens；缓存 $y / 1M tokens；输出 $z / 1M tokens；截至 YYYY-MM-DD`。
- 官方价格页存在但未解析：显示 `待解析官方价格`。
- 不能显示 `见官方定价页`。

模型发布时间线规则：

- 只取 `2025-06-06` 至 `2026-06-06` 区间内 high / medium 置信度记录。
- 字段固定为 `日期、厂商、模型、类型、核心变化、API定价、数据状态`。
- 类型使用枚举；数据状态使用 `verified`、`date_estimated`、`source_unparsed`。
- 缺精确日期时显示月份或“前后”，不把 raw English、坏日期或“后续信息待官方确认”写入 HTML。

财务历史补齐：

```bash
npm run financials:fetch
npm run financials:validate
npm run render
```

手工补充缺失字段时，把公开源 raw text 或表格先放到 `data/financials/candidates/` 或 `data/llm_candidates/`，字段必须包含 ticker、metric、period、display、source_title、source_url、as_of、confidence。通过 `financials:validate` 后才允许进入 `data/financials/financial_history_verified.json`。

财务 coverage 规则：

- `financials:fetch` 会生成 `data/financials/candidates/from_profiles.json`、`data/financials/financial_history_verified.json` 和 `data/financials/financial_coverage_summary.json`。
- HTML 财务表上方展示 `财务覆盖：年度 X/3，季度 Y/2，核心字段 Z% verified`；核心字段低于 50% 时追加覆盖不足提示。
- 非美公司缺口必须说明 adapter，例如 MOPS、DART、IR PDF、20-F，不用空白值替代。

## 关注列表

关注列表用于新增 AAOI 这类 watching 标的。watching 不进入组合收益计算，也不会自动变成持仓。

配置在 `portfolio.config.json` 的 `watchlist` 字段：

```json
{
  "ticker": "AAOI",
  "company_name": "Applied Optoelectronics",
  "status": "watching",
  "is_holding": false,
  "priority": "medium",
  "sector_tags": ["光通信", "数据中心", "光模块"],
  "init_status": "pending",
  "added_at": "YYYY-MM-DD",
  "notes": "新增观察标的，先建档，不进入组合收益计算。"
}
```

常用命令：

```bash
npm run watchlist:add -- AAOI --status watching --priority medium
npm run watchlist:init -- AAOI
npm run watchlist:validate -- AAOI
npm run watchlist:promote -- AAOI
npm run watchlist:archive -- AAOI
```

AAOI 初始化 prompt 会写入：

```text
data/watchlist_tasks/AAOI_research_prompt.md
```

资料库 AI、Qwen 或人工补充后，将 JSON candidate 保存到：

```text
data/watchlist_candidates/AAOI_profile_candidate.json
```

`watchlist:validate` 通过后会写入 `data/companies/AAOI.json` 和 `initial/AAOI_profile.md`；未通过则写入 `data/watchlist_rejected/AAOI.json`。只有运行 `watchlist:promote` 后，`is_holding=true`，下一次 build 才纳入组合收益和持仓追踪。

## 数据上传

- 初始标的资料放在 `initial/*_profile.md`。
- 后续用户导入资料放在 `uploads/`。
- 当前支持 Markdown profile 与简单 CSV；XLSX/DOCX/PDF adapter 已保留 stub，后续接入。
- 重新导入后运行：

```bash
npm run import
npm run render
npm run build-site
```

导入结果位于：

- `data/companies.json`
- `data/events.json`
- `data/reminders.json`
- `data/ai_capex.json`
- `data/ai_models.json`
- `data/market/<YYYY-MM-DD>.json`
- `data/obsidian_hits.json`
- `data/data_quality/missing_info_prompt_<YYYY-MM-DD>.md`
- `data/snapshots/*.json`

未知字段保持 `null`、空数组或进入 `missing_info_prompt`。初始 profile 中没有原始链接的事件默认不会进入 L1 confirmed，也不会作为页面事实展示。

## GitHub Pages

1. 将项目推送到 GitHub。
2. 在仓库 Settings -> Actions -> General 中把 Workflow permissions 设为 `Read and write permissions`。
3. 在仓库 Settings -> Secrets and variables -> Actions 中配置可选 Variables：
   - `REPORT_TZ`：默认 `Asia/Shanghai`。
   - `REPORT_HOUR`：默认 `8`，可用逗号设置多个本地小时，例如 `8,21`。
   - `REPORT_DAYS`：默认 `*`，可设为 `1-5` 只跑工作日。
4. 手动触发 `Portfolio Management Report` workflow，首次成功后会创建 `gh-pages` 分支。
5. 在 Settings -> Pages 中选择 `Deploy from a branch`，分支选 `gh-pages`，目录选 `/ (root)`。
6. 访问：

```text
https://<username>.github.io/<repo>/
```

workflow 参照 DailyBrief 的发布方式：cron 每小时多次触发，但先由 gate 任务按 `REPORT_TZ` / `REPORT_HOUR` / `REPORT_DAYS` 判断是否真正运行；手动触发和 push 到 `main` 会跳过 gate 并立即生成。构建会先从 `gh-pages` 恢复旧的 `portfolio_reports` 历史目录，再运行公开数据更新、行情刷新、渲染、质量校验，最后把整个 `portfolio_reports` 发布到 `gh-pages`。

GitHub runner 无法访问本机 Obsidian vault，因此 CI 中会把 Obsidian 扫描降级为 not_available；页面仍会使用仓库内的 profile、supplemental、公开 enrichment、行情缓存和财务/估值/Capex 数据生成。外部 API key 应放 GitHub Actions Secrets，非秘密配置放 Variables。

## 自托管 nginx

在服务器创建目录：

```bash
sudo mkdir -p /var/www/portmgmt
sudo chown www-data:www-data /var/www/portmgmt
```

本地创建 `.env.local`：

```bash
DEPLOY_HOST=user@server
DEPLOY_PATH=/var/www/portmgmt
```

部署最新报告：

```bash
npm run deploy
```

部署指定日期：

```bash
npm run deploy -- 2026-06-04
```

nginx 示例见 `docs/web_access.md`。

## 安全说明

不要把私有研报原文、敏感持仓、完整上传文件发布到公开 GitHub Pages。公开页面应只放摘要、必要字段和必要链接。API keys 放 `.env.local` 或 GitHub Secrets，非秘密配置放 `portfolio.config.json` 或 GitHub Variables。

## 命令

- `npm run import`：导入 `initial/` 与 `uploads/`。
- `npm run obsidian`：扫描可选 Obsidian/Bosidian vault；未配置时写入 not_configured，不失败。
- `npm run market`：生成 `data/market/<YYYY-MM-DD>.json` 行情缓存；renderer 不联网。
- `npm run market:live`：生成 `data/market_live/latest.json` 与 `portfolio_reports/market_live.json`，供页面 `刷新行情` 按钮读取。
- `npm run render`：从结构化 JSON 和 market cache 生成 `portfolio_reports/<YYYY-MM-DD>/<YYYY-MM-DD>.html|json|md`。
- `npm run quality`：生成 audit 与 `missing_info_prompt`。
- `npm run build-site`：生成 `portfolio_reports/index.html`、`archive.html`、`.nojekyll`。
- `npm run llm:tasks`：生成待处理 LLM/人工补充任务，不调用 API。
- `npm run llm:run`：在 `LLM_ENABLED=true` 时调用 Qwen，失败只写入 `data/llm_candidates/errors.json`。
- `npm run llm:validate`：校验 LLM/人工 candidate，写入 `data/valuation_verified.json`。
- `npm run enrich:models`：抓取模型厂商官方模型/定价页面，写入 enrichment raw/candidates，并执行模型 verified overlay。
- `npm run models:timeline`：生成最近一年关键模型发布时间线和模型缺口文档。
- `npm run enrich:financials`：抓取 SEC companyfacts 财务候选，写入 enrichment candidates。
- `npm run financials:fetch`：从已校验候选和 source registry 构建 `data/financials/financial_history_verified.json` 与财务缺口文档。
- `npm run financials:validate`：校验财务历史 display/source/unit，禁止裸数字、无来源金额和金额/比率错配。
- `npm run enrich:valuation`：把已校验估值同步到 enrichment 候选并抓取公开 source raw。
- `npm run enrich:capex`：抓取/规范化 Capex 公开源，写入 `data/capex` 与 enrichment。
- `npm run enrich:validate`：校验 enrichment candidates，写入 verified/rejected。
- `npm run watchlist:add`：新增 watching 标的配置。
- `npm run watchlist:init`：生成初始化任务和资料库 AI prompt。
- `npm run watchlist:validate`：校验 profile candidate，成功后生成初始 profile。
- `npm run watchlist:promote`：将 watching 标的提升为 holding。
- `npm run watchlist:archive`：归档关注标的。
- `npm run daily`：执行日常全流程，外部 API 当前为 stub。
- `npm run deploy`：可选自托管 scp + nginx 上传。
- `npm run test`：校验数据文件和 L1/L2/L3 约束。
- `npm run validate-report`：同时校验日期报告与 `portfolio_reports/index.html`，拦截脏 HTML、指引/风险/资料库/刷新行情/估值任务质量问题。
- `npm run typecheck`：对脚本执行 `node --check`。

## 外部 API 状态

当前已接入东方财富公开行情接口，并以 Yahoo chart/page 和 Stooq 日线 CSV 作为 fallback，可计算 price、1D/5D/20D/YTD 和相对 QQQ/MAG7。公开端点缺 market cap、PE/PS、beta 时，对应字段会保持缺口并进入 data quality warning，不编造。后续可补：

- Yahoo Finance / Bloomberg / 其他行情源
- Bloomberg / Reuters / 公司 IR / SEC 新闻扫描
- Obsidian/Bosidian vault 增量扫描
- L1 原文链接和本地存档路径补全
