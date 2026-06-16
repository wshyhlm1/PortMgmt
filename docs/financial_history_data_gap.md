# 财务历史数据缺口

生成日期：2026-06-06

| Ticker | 已验证年度数量 | 已验证季度数量 | 缺失指标 | 缺失原因 | 下一步 |
|---|---:|---:|---|---|---|
| ASML.O | 4 | 1 | — | IR PDF 未解析；segment data 缺失 | 继续解析 annual report PDF 中 segment 与季度口径。 |
| ASX | 1 | 1 | 毛利率、净利润、EPS diluted、OCF、FCF、现金、净现金/净债务 | segment data 缺失 | ASX：SEC 20-F / 公司 IR / ASE annual report；确认 TWD/USD 披露口径。 |
| AVGO.O | 4 | 5 | 毛利率、营业利润、营业利润率 | segment data 缺失 | 补充 FY2026 最近季度与 segment 信息。 |
| BABA.N | 4 | 0 | 毛利率、营业利润、营业利润率、Capex、FCF、债务、净现金/净债务 | segment data 缺失 | 补 FY2025 年报人民币口径与最近季度。 |
| BB.N | 3 | 3 | 营业利润、营业利润率、债务、净现金/净债务 | segment data 缺失 | 确认主要 filing 来源并补软件 ARR/IoT segment。 |
| CIEN.N | 3 | 4 | — | segment data 缺失 | 补最近两个季度与 backlog/segment。 |
| GFS.O | 3 | 1 | OCF、现金、债务、净现金/净债务 | segment data 缺失 | 补 2025 interim 6-K 的现金流与 Capex。 |
| GOOGL.O | 4 | 3 | 毛利率、营业利润、营业利润率 | segment data 缺失 | 补 cloud/other bets segment 与最近季度。 |
| IBM.N | 3 | 6 | — | segment data 缺失 | 补 consulting/software segment 与最近季度。 |
| IFX.DF | 3 | 1 | 营业利润、营业利润率、OCF、Capex、FCF、现金、债务、净现金/净债务 | IR PDF 未解析；segment data 缺失 | IFX：Infineon annual report / quarterly report；接入 IR PDF 解析，补 IFRS 年度与季度。 |
| NBIS.O | 3 | 1 | OCF、债务、净现金/净债务 | segment data 缺失 | 补 20-F 与最近季度经营指标。 |
| NOK.N | 3 | 1 | 毛利率、营业利润、营业利润率、净利润、EPS diluted、债务 | IR PDF 未解析；segment data 缺失 | NOK：Nokia annual report / quarterly report；补净销售、FCF 与 segment。 |
| QCOM.O | 3 | 5 | 毛利率、营业利润、营业利润率、Capex、FCF、净现金/净债务 | segment data 缺失 | 补最近季度和 handset/auto/IoT segment。 |
| Samsung | 3 | 1 | — | DART 未接入；segment data 缺失 | Samsung：DART / Samsung IR audited financial statements；接入 DART/IR PDF，补 2025/2026 财报。 |
| SKM.N | 3 | 1 | — | DART 未接入；segment data 缺失 | SKM：SEC 20-F / DART / SK Telecom annual report；补年度与季度。 |
| TSM.N | 3 | 1 | 毛利率、营业利润、营业利润率、净利润、EPS diluted、债务 | MOPS 未接入；segment data 缺失 | TSM：MOPS / TSMC annual report / earnings release；确认 TWD 披露口径。 |
| AAOI | 0 | 0 | 收入、毛利率、营业利润、营业利润率、净利润、EPS diluted、OCF、Capex、FCF、现金、债务、净现金/净债务 | SEC companyfacts 无可用 verified 行或公司非 SEC filer；segment data 缺失 | 保持 watching/pending，仅进入候选数据，不进入组合财务主表。 |

## 说明

- SEC companyfacts 中不存在的 concept 会保留为缺口，不用 profile 或 LLM 猜测。
- IR PDF、MOPS、DART 尚未解析的公司显示 `—`，并在本缺口文档中列出 adapter。
- 单位、币种或来源不明确的字段进入 rejected，不进入 HTML。
- Profile 表格只作为 candidate 入口；通过期间、指标、单位和来源校验后才进入 verified。
- Coverage summary 写入 `data/financials/financial_coverage_summary.json`，供 HTML 财务覆盖提示和 validate 使用。
- 非美公司继续按 adapter 明确补齐路径：TSM/ASX -> MOPS/20-F，Samsung/SKM -> DART/20-F，IFX/NOK/ASML -> IR PDF/20-F。

