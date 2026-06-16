# 公开财务历史数据源

生成日期：2026-06-06

## 数据流

财务历史遵循 raw -> candidate -> verified -> rejected -> render。HTML 只读取 data/financials/financial_history_verified.json 的 display 字段。

## 公开源优先级

- SEC companyfacts / submissions：美国公司、ADR、20-F/10-K/10-Q 的首选入口。
- 公司 IR 年报、季度报、earnings release：用于非 SEC filer、segment 与管理层口径。
- 台湾 MOPS 与韩国 DART：用于 TSMC、Samsung、SK Telecom 等本地披露。
- LLM/Qwen 只允许把 PDF/HTML raw text 转为 candidate，不允许直接写 verified 财务数字。

## Profile Candidate 与 Coverage

- `initial/*_profile.md` 中 period、metric、unit、source_file 清楚的财务表先进入 `data/financials/candidates/from_profiles.json`。
- 只有 display、来源、期间、单位都合格的 profile 行才合并到 `data/financials/financial_history_verified.json`，并标记 `source_form=profile_candidate`。
- `data/financials/financial_coverage_summary.json` 按标的输出年度覆盖、季度覆盖、核心字段 verified 百分比、缺失字段和 source_mix。
- HTML 财务表上方展示 `财务覆盖：年度 X/3，季度 Y/2，核心字段 Z% verified`；低于 50% 会追加覆盖不足提示。
- 非美/ADR 标的缺口必须明确写出 MOPS、DART、IR PDF、20-F 等 adapter，不用空白或泛化缺失替代。

## 展示质量规则

- 业务拆分的收入/占比必须带币种、单位和百分比，例如 `150.1亿美元 / 约68%`，不允许裸数字。
- 估值缺口文本以 `financial_history_verified.display` 和 verified 估值字段为准；Forward PE、EV/EBITDA、FCF Yield 已验证时不能再提示缺失。
- 页面中的 `-` 统一展示为 `—`，财务与估值上下文不展示裸 financial value。

## Source Registry

| Ticker | 公司 | 首选币种 | Adapter | 下一步 |
|---|---|---|---|---|
| ASML.O | ASML Holding N.V. | EUR | sec_companyfacts_plus_ir_pdf | 继续解析 annual report PDF 中 segment 与季度口径。 |
| ASX | ASE Technology Holding Co., Ltd. | TWD | sec_companyfacts_plus_ir | ASX：SEC 20-F / 公司 IR / ASE annual report；确认 TWD/USD 披露口径。 |
| AVGO.O | Broadcom Inc. | USD | sec_companyfacts | 补充 FY2026 最近季度与 segment 信息。 |
| BABA.N | Alibaba Group Holding Limited | CNY | sec_companyfacts_plus_ir | 补 FY2025 年报人民币口径与最近季度。 |
| BB.N | BlackBerry Limited | USD | sec_companyfacts_plus_sedar | 确认主要 filing 来源并补软件 ARR/IoT segment。 |
| CIEN.N | Ciena Corporation | USD | sec_companyfacts | 补最近两个季度与 backlog/segment。 |
| GFS.O | GLOBALFOUNDRIES Inc. | USD | sec_companyfacts_plus_6k | 补 2025 interim 6-K 的现金流与 Capex。 |
| GOOGL.O | Alphabet Inc. | USD | sec_companyfacts | 补 cloud/other bets segment 与最近季度。 |
| IBM.N | International Business Machines Corporation | USD | sec_companyfacts | 补 consulting/software segment 与最近季度。 |
| IFX.DF | Infineon Technologies AG | EUR | company_ir_pdf | IFX：Infineon annual report / quarterly report；接入 IR PDF 解析，补 IFRS 年度与季度。 |
| NBIS.O | Nebius Group N.V. | USD | sec_companyfacts_plus_ir | 补 20-F 与最近季度经营指标。 |
| NOK.N | Nokia Oyj | EUR | sec_companyfacts_plus_ir_pdf | NOK：Nokia annual report / quarterly report；补净销售、FCF 与 segment。 |
| QCOM.O | Qualcomm Incorporated | USD | sec_companyfacts | 补最近季度和 handset/auto/IoT segment。 |
| Samsung | Samsung Electronics Co., Ltd. | KRW | korea_dart_plus_ir | Samsung：DART / Samsung IR audited financial statements；接入 DART/IR PDF，补 2025/2026 财报。 |
| SKM.N | SK Telecom Co., Ltd. | KRW | sec_20f_plus_korea_dart | SKM：SEC 20-F / DART / SK Telecom annual report；补年度与季度。 |
| TSM.N | Taiwan Semiconductor Manufacturing Company Limited | TWD | sec_companyfacts_plus_taiwan_mops | TSM：MOPS / TSMC annual report / earnings release；确认 TWD 披露口径。 |
| AAOI | Applied Optoelectronics, Inc. | USD | sec_companyfacts_watchlist_candidate | 保持 watching/pending，仅进入候选数据，不进入组合财务主表。 |

