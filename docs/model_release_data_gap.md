# 模型发布数据缺口

生成日期：2026-06-06

## Verified / Candidate 数量

| Provider | verified timeline | candidate |
|---|---:|---:|
| Alibaba/通义千问 | 1 | 0 |
| Anthropic | 3 | 0 |
| DeepSeek | 0 | 1 |
| Google | 1 | 0 |
| Moonshot | 1 | 2 |
| OpenAI | 1 | 0 |
| xAI | 0 | 1 |

## 字段缺口

- xAI Grok 4.3：缺 official exact/month 发布时间。
- Kimi K2.5/K2.6：已有官方价格与上下文，缺 official exact/month 发布时间。
- DeepSeek V3/R1/V3.2：需要解析官方 docs/news 的发布时间；pricing table 可作为价格解析入口。
- Qwen pricing：DashScope pricing 表需要脚本继续解析具体模型价格、缓存折扣和阶梯区间。
- OpenAI GPT-5.5：官方 seed 已补价格，context window 仍需以模型文档解析结果补齐。

## 本轮质量规则

- 时间线范围：2025-06-06 至 2026-06-06；最多 12 条；日期倒序；只收 high / medium。
- 模型表字段完整度必须达到 5 个有效字段；重复、raw English、坏日期和低置信行不会进入 HTML。
- API 定价缺解析时统一显示 `待解析官方价格`；缺口在本文档保留，不把定价页链接当作价格。

## 下一步

- 用 provider fetch 脚本抓官方页面 raw text。
- 让 LLM 只生成 parsing hint 或 candidate JSON。
- 人工或脚本确认 source_url/source_title/date 后再进入 verified。

