# 公开模型发布数据源

生成日期：2026-06-06

## 数据流

模型数据遵循 raw -> candidate -> verified -> rejected -> render。官方页面抓取失败不会让 build 失败，会写入 data/enrichment/errors.json。

## 官方源优先级

- 厂商官方模型文档、pricing 文档、changelog、announcement。
- 已解析官方价格写入 api_pricing；官方价格页存在但尚未解析时显示 `待解析官方价格`。
- LLM/Qwen 只能生成 candidate 或 parsing hint，不能直接写 verified。

## 时间线生成规则

- 主轴时间范围固定为 2025-06-06 至 2026-06-06，只取 high / medium 置信度，最多 12 条，按日期倒序展示。
- 字段固定为：日期、厂商、模型、类型、核心变化、API定价、数据状态。
- 类型使用枚举：旗舰模型、推理模型、速度模型、多模态模型、编码模型、开源/开放权重模型、价格调整、生命周期变更。
- 数据状态使用枚举：verified、candidate、date_estimated、pricing_missing、source_unparsed；缺精确日时显示 `约 YYYY-MM`，不写 raw English。
- 官方价格页存在但未解析时只显示 `待解析官方价格`，不显示 `见官方定价页`。

## 模型表质量规则

- HTML 模型表只展示 high / medium 且来源明确的 verified/candidate 行。
- 每行至少具备 5 个有效字段，空 provider 分组不渲染。
- 重复模型按 provider + model 合并，低质量发布时间、raw English 描述和后续待确认句子进入 rejected 或缺口文档。

## Provider 覆盖

- Alibaba/通义千问：timeline verified 1 条；candidate 0 条。
- Anthropic：timeline verified 3 条；candidate 0 条。
- DeepSeek：timeline verified 0 条；candidate 1 条。
- Google：timeline verified 1 条；candidate 0 条。
- Moonshot：timeline verified 1 条；candidate 2 条。
- OpenAI：timeline verified 1 条；candidate 0 条。
- xAI：timeline verified 0 条；candidate 1 条。

## 时间线主轴

| 日期 | 厂商 | 模型 | 类型 | API定价 | 数据状态 |
|---|---|---|---|---|---|
| 2026-05-31 | Alibaba/通义千问 | Qwen3.7-Plus | 推理模型 | 输入 ¥2 / 1M tokens；输出 ¥8 / 1M tokens；截至 2026-06-15 | verified |
| 2026-05 | Anthropic | Claude Opus 4.8 | 旗舰模型 | 输入 $5.00 / 1M tokens；缓存 $0.50 / 1M tokens；输出 $25.00 / 1M tokens；截至 2026-06-06 | date_estimated |
| 2026-04-23 | OpenAI | GPT-5.5 / GPT-5.5 Pro | 旗舰模型 | 输入 $5.00 / 1M tokens；缓存 $0.50 / 1M tokens；输出 $30.00 / 1M tokens；截至 2026-06-06 | verified |
| 2026-02 | Anthropic | Claude Sonnet 4.6 | 推理模型 | 输入 $3.00 / 1M tokens；缓存 $0.30 / 1M tokens；输出 $15.00 / 1M tokens；截至 2026-06-06 | date_estimated |
| 约 2026-01 | Google | Gemini 3 Flash Preview | 速度模型 | 输入 $0.50 / 1M tokens；缓存 $0.05 / 1M tokens；输出 $3.00 / 1M tokens；截至 2026-06-06 | date_estimated |
| 2025-11-08 | Moonshot | Kimi K2 Thinking / Turbo | 推理模型 | 待解析官方价格 | source_unparsed |
| 2025-10-01 | Anthropic | Claude Haiku 4.5 | 速度模型 | 输入 $1.00 / 1M tokens；缓存 $0.10 / 1M tokens；输出 $5.00 / 1M tokens；截至 2026-06-06 | verified |

