# PortMgmt 公开数据整理文档（模型发布 + 持仓财务历史）

生成日期：2026-06-06
用途：发送给 Codex，用作 `models` 与 `financial_history` 数据补齐的公开源种子文档。  
原则：公开信息先进入 raw/candidate，经 schema 与来源校验后才进入 verified 与 HTML。

---

## 1. 模型发布数据：官方源与已整理字段

### 1.1 OpenAI

官方源：
- OpenAI API Pricing: https://openai.com/api/pricing/
- GPT-5.5 model docs: https://developers.openai.com/api/docs/models/gpt-5.5
- GPT-5.5 announcement: https://openai.com/index/introducing-gpt-5-5/

已整理信息：
- GPT-5.5：OpenAI 官方价格页列为 flagship model，描述为“coding and professional work”模型。
- GPT-5.5 API 价格：输入 $5.00 / 1M tokens；cached input $0.50 / 1M tokens；输出 $30.00 / 1M tokens。
- GPT-5.5 模型文档列出 alias/snapshot：`gpt-5.5`、`gpt-5.5-2026-04-23`。
- GPT-5.5 发布时间：2026-04-23；API 可用更新时间：2026-04-24。
- GPT-5.4：价格页列出输入 $2.50 / 1M tokens；cached input $0.25 / 1M tokens；输出 $15.00 / 1M tokens。
- GPT-5.4 mini：输入 $0.75 / 1M tokens；cached input $0.075 / 1M tokens；输出 $4.50 / 1M tokens。

建议进入模型时间线：
- 2026-04-23：OpenAI GPT-5.5 / GPT-5.5 Pro 发布；标记为“旗舰模型 / agentic coding / professional work”。

---

### 1.2 Anthropic / Claude

官方源：
- Claude models overview: https://platform.claude.com/docs/en/about-claude/models/overview
- Claude pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Claude Opus 4.8 changes: https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8

已整理信息：
- 最新模型比较包括 Claude Opus 4.8、Claude Sonnet 4.6、Claude Haiku 4.5。
- Claude Opus 4.8：定位为 Anthropic 最强复杂推理与 agentic coding 模型；API ID `claude-opus-4-8`；1M tokens context（Microsoft Foundry 例外为 200k）；max output 128k；价格 $5 / input MTok，$25 / output MTok。
- Claude Sonnet 4.6：定位为速度与智能平衡；API ID `claude-sonnet-4-6`；1M tokens context；max output 64k；价格 $3 / input MTok，$15 / output MTok。
- Claude Haiku 4.5：API ID `claude-haiku-4-5-20251001`；200k context；max output 64k；价格 $1 / input MTok，$5 / output MTok。
- Claude pricing docs 还列出 prompt caching 价格：Opus 4.8 cache hit $0.50 / MTok，Sonnet 4.6 cache hit $0.30 / MTok，Haiku 4.5 cache hit $0.10 / MTok。

建议进入模型时间线：
- 2025-10-01：Claude Haiku 4.5（根据 API ID 日期）。
- 2026-02：Claude Sonnet 4.6（需 Codex 用官方 release/news 或模型元数据确认 exact/month）。
- 2026-05：Claude Opus 4.8（需 Codex 用官方 changelog/announcement 确认 exact date）。

---

### 1.3 Google Gemini

官方源：
- Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
- Gemini API changelog: https://ai.google.dev/gemini-api/docs/changelog
- Gemini 3 Flash blog: https://blog.google/products-and-platforms/products/gemini/gemini-3-flash/

已整理信息：
- Gemini 3 Flash Preview：model id `gemini-3-flash-preview`；官方描述为速度型 frontier intelligence，支持 search and grounding。
- Gemini 3 Flash Preview 标准价格：text/image/video 输入 $0.50 / 1M tokens；audio 输入 $1.00 / 1M tokens；输出 $3.00 / 1M tokens；context caching $0.05 / 1M tokens（text/image/video）和 $0.10 / 1M tokens（audio）。
- Gemini 3 Pro Image：model id `gemini-3-pro-image`；标准价格 text/image 输入 $2.00 / 1M tokens；text/thinking 输出 $12.00 / 1M tokens；image 输出 $120.00 / 1M tokens。
- Gemini 3 Flash blog 显示 Gemini 3 Flash 可通过 Gemini API、Google AI Studio、Vertex AI、Gemini Enterprise 访问。
- Gemini API changelog 可作为 release timeline 的主要抓取入口。

建议进入模型时间线：
- 2026-01 前后：Gemini 3 Flash Preview（需 Codex 用 changelog 或 blog published date 确认）。
- 2026-05：Gemini 3.1 / image-preview deprecation 与 Gemini 3 API 更新（用于标注模型生命周期）。

---

### 1.4 xAI / Grok

官方源：
- Grok 4.3 docs: https://docs.x.ai/developers/models/grok-4.3

已整理信息：
- Grok 4.3：支持 configurable reasoning（none/low/medium/high）。
- Grok 4.3 价格：输入 $1.25 / 1M tokens；cached tokens $0.20 / 1M tokens；输出 $2.50 / 1M tokens。

建议进入模型时间线：
- 2026 年：Grok 4.3；需 Codex 用 xAI docs metadata 或 release notes 抽取 exact/month 日期。

---

### 1.5 Qwen / Alibaba DashScope

官方源：
- DashScope/Qwen API docs: https://help.aliyun.com/zh/model-studio/qwen-api-via-dashscope
- DashScope model pricing: https://help.aliyun.com/zh/model-studio/model-pricing

已整理信息：
- 阿里云百炼 / Model Studio 支持 Qwen API 调用，计费按输入和输出 token。
- 官方价格页说明：Batch 调用输入/输出 token 单价通常按实时推理价格的 50% 计费；上下文缓存只对输入 token 打折；两者不能同时生效。
- pricing 页面本身应由 Codex 脚本解析各 Qwen 模型的输入/输出价格、阶梯区间、上下文缓存价格。

建议进入模型时间线：
- 2025-2026：Qwen3 / Qwen3.5 / Qwen-plus 等以 DashScope 官方模型列表为准；Codex 需要抓模型列表页和 pricing 表，而不是手工填。

---

### 1.6 DeepSeek

官方源：
- DeepSeek API docs: https://api-docs.deepseek.com/
- DeepSeek pricing details: https://api-docs.deepseek.com/quick_start/pricing-details-usd/

已整理信息：
- DeepSeek pricing details 表包含字段：MODEL、CONTEXT LENGTH、MAX COT TOKENS、MAX OUTPUT TOKENS、1M TOKENS INPUT PRICE（CACHE HIT）、1M TOKENS INPUT PRICE（CACHE MISS）、1M TOKENS OUTPUT PRICE。
- Codex 应直接解析官方 pricing table，生成 `api_pricing.cached_input_per_1m`、`input_per_1m`、`output_per_1m`。

建议进入模型时间线：
- 2025-2026：DeepSeek V3/R1/V3.2 等，以官方 docs/news 为准；缺 exact date 时进入 candidate，不进 timeline 主轴。

---

### 1.7 Kimi / Moonshot

官方源：
- Kimi API platform: https://platform.moonshot.cn/
- Kimi model list: https://platform.kimi.ai/docs/models
- Kimi API pricing help: https://www.kimi.com/help/kimi-api/api-pricing
- Kimi API newsletter: https://platform.moonshot.ai/blog/posts/Kimi_API_Newsletter

已整理信息：
- Kimi K2.6：平台首页显示为最新智能模型，强调长程代码编写、Agent 自主执行增强；价格：缓存命中 ¥1.10 / MTok，输入 ¥6.50 / MTok，输出 ¥27.00 / MTok。
- Kimi K2.5：支持视觉与文本输入、思考/非思考模式、对话与 Agent 任务；上下文 256k；价格：缓存命中 ¥0.70 / MTok，输入 ¥4.00 / MTok，输出 ¥21.00 / MTok。
- Moonshot V1：上下文 131,072 tokens；输入 ¥10.00 / MTok，输出 ¥30.00 / MTok。
- Kimi API newsletter 显示 2025-11-08 推出 kimi-k2-thinking 与 kimi-k2-thinking-turbo，并更新定价。

建议进入模型时间线：
- 2025-11-08：Kimi K2 Thinking / K2 Thinking Turbo。
- 2026 年：Kimi K2.5 / K2.6；需 Codex 用官方 docs metadata 或网页抓取日期确认。

---

## 2. 模型发布时间线需求

在模型发布 tab 顶部新增“最近一年关键模型发布时间线”。报告日期为 2026-06-06，则时间范围为：2025-06-06 至 2026-06-06。

时间线建议首批包含：

| 日期 | 厂商 | 模型 | 类型 | 摘要 | 置信度 |
|---|---|---|---|---|---|
| 2025-10-01 | Anthropic | Claude Haiku 4.5 | API模型 | 低成本近前沿模型，200k context，$1/$5 每 MTok。 | high（API ID日期） |
| 2025-11-08 | Moonshot | Kimi K2 Thinking / Turbo | 推理/Agent模型 | 面向复杂推理、多步骤指令和 Agent 任务。 | high（官方 newsletter） |
| 2026-04-23 | OpenAI | GPT-5.5 / GPT-5.5 Pro | 旗舰模型 | 面向复杂真实工作、agentic coding 与 professional work；API 4/24 可用。 | high（官方发布） |
| 2026-05 | Anthropic | Claude Opus 4.8 | 旗舰模型 | 复杂推理与 agentic coding 模型，1M context，$5/$25 每 MTok。 | medium（需 exact date） |
| 2026-01~2026-06 | Google | Gemini 3 Flash Preview | 速度型前沿模型 | frontier intelligence + search/grounding；输入 $0.50、输出 $3.00 每 MTok。 | medium（需 exact date） |
| 2026 | xAI | Grok 4.3 | 推理模型 | configurable reasoning；输入 $1.25、输出 $2.50 每 MTok。 | medium（需 exact date） |
| 2026 | Kimi | Kimi K2.6 | 多模态/Agent模型 | 256k context，输入 ¥6.50、输出 ¥27.00 每 MTok。 | medium（需 exact date） |

Codex 必须把 exact date 未确认的项标记为 `date_confidence: month|estimated`，不得硬填精确日。

---

## 3. 持仓公司财务历史数据公开源映射

### 3.1 通用源

- SEC EDGAR API: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
- SEC Developer Resources: https://www.sec.gov/about/developer-resources

SEC 提供 submissions history 和 extracted XBRL data 的 RESTful JSON API。美国公司和许多 ADR/foreign issuers 可用 SEC companyfacts / submissions 抽取 10-K、10-Q、20-F、6-K 数据。

### 3.2 Ticker 源映射

| Ticker | 公司 | 首选来源 | 形式 | 备注 |
|---|---|---|---|---|
| ASML.O | ASML Holding | ASML Annual Report + SEC 20-F | 20-F / annual report | 2025 annual report 与 SEC 20-F 均可用；币种 EUR。 |
| ASX | ASE Technology | ASE IR + SEC 20-F | 20-F / annual report | 2025 20-F 已提交 SEC；币种 TWD/USD 需按披露口径处理。 |
| AVGO.O | Broadcom | Broadcom IR + SEC 10-K/10-Q | 10-K / 10-Q | IR financial reports 页面列出 2025 10-K 与 2026 10-Q。 |
| BABA.N | Alibaba | Alibaba IR + HKEX annual report + SEC 20-F | 20-F / HKEX annual report | FY2025 年报公开；币种 RMB。 |
| BB.N | BlackBerry | SEC/SEDAR 或公司 IR | 10-K/10-Q 或 Canadian filings | 需 Codex 确认主要 filings 来源。 |
| CIEN.N | Ciena | Ciena IR + SEC 10-K | 10-K | IR annual reports 列出 2025 Form 10-K。 |
| GFS.O | GlobalFoundries | SEC 20-F + interim 6-K | 20-F / 6-K | CIK 1709048；2025 interim 6-K 有现金流、capex 等。 |
| GOOGL.O | Alphabet | Alphabet IR + SEC 10-K/10-Q | 10-K / 10-Q | 2025 annual filing 可用。 |
| IBM.N | IBM | IBM Annual Report + SEC 10-K | 10-K | IBM annual report 页面提供 2025 10-K。 |
| IFX.DF | Infineon | Infineon annual report | Annual report / IFRS | FY2025 收入约 €14.7bn；币种 EUR。 |
| NBIS.O | Nebius | SEC 20-F + Nebius IR | 20-F | 2025 20-F 可用；CIK 1513845；币种 USD。 |
| NOK.N | Nokia | Nokia annual report + SEC 20-F | 20-F / annual report | 2025 年报显示净销售 +3%、FCF €1.5bn 等；币种 EUR。 |
| QCOM.O | Qualcomm | SEC 10-K/10-Q + Qualcomm IR | 10-K / 10-Q | 2025 10-K 可用；币种 USD。 |
| Samsung / 005930.KS | Samsung Electronics | Samsung IR + Korea DART | K-IFRS financial statements / DART | Samsung IR 提供 2025/2026 季度与全年财报；币种 KRW。 |
| SKM.N | SK Telecom | SK Telecom IR + SEC 20-F + DART | 20-F / DART | SKT IR 提供 Form 20-F 2025/2024/2023；币种 KRW。 |
| TSM.N | TSMC | TSMC annual report + SEC 20-F | 20-F / annual report | 2025 20-F 于 2026-04-16 提交 SEC；币种 TWD。 |
| AAOI | Applied Optoelectronics | SEC 10-K/10-Q + company IR | watchlist candidate | 仅 watchlist，不进入组合财务主表，先建候选档案。 |

---

## 4. 财务历史字段目标

每个 holding 至少抓取：
- 最近 3 个完整财年：FY2023/FY2024/FY2025 或公司对应财年。
- 最近 2 个季度：如 FY2026Q1/FY2026Q2。
- 如有 TTM，则单独列示，不要覆盖 annual/quarter 数据。

核心指标：
- revenue
- gross_profit
- gross_margin
- operating_income
- operating_margin
- net_income
- net_margin
- diluted EPS
- operating_cash_flow
- capex / purchases of property and equipment
- FCF = operating_cash_flow - capex
- cash_and_equivalents
- short_term_investments
- total_debt
- net_cash_or_debt
- shares_outstanding
- segment revenue
- segment operating income

HTML 必须渲染 `display` 字段，例如 `326.7亿欧元`，禁止裸数字。

---

## 5. Codex 执行要点

1. 不要要求用户再手工搜索模型和财务数据。Codex 应写脚本抓官方源。
2. 若网络抓取失败，写入 `data/enrichment/errors.json` 或 `data/financials/errors.json`，并保留缺口，不要硬填。
3. 模型发布时间线必须位于模型发布 tab 顶部，展示最近一年关键模型发布。
4. 公开数据必须进入 `raw -> candidates -> verified -> render` 流程。
5. 所有 HTML 可见模型价格、财务数字必须带来源、日期、单位/币种或价格口径。
6. LLM/Qwen 仅能辅助清洗、翻译、摘要，不能直接写 verified。
