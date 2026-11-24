# 指标可信范围分析台 / Credible Range Studio

一个零第三方运行时依赖的中文网页与 Node 后台：为带误差范围的输入指标建立有限的
`+ - * / ^整数幂`、括号以及 `log`、`exp`、`sqrt`、`abs` 表达式，计算考虑**共同原始来源**
和**同一误差符号重复出现**的严格/保守结果界。

> 结论来自区间算术、仿射包络和自适应细分盒的并集。确定性采样只提供已知可行点，
> **采样最大值/最小值永远不被当作严格界**。

## 运行与测试

```bash
npm start
# 默认 http://127.0.0.1:4173 ；可用 PORT=8080 npm start
npm test
npm run verify:examples
```

要求 Node.js >= 20。无需 `npm install`。

## 网页工作流

1. 在“共同原始来源”中修改某个来源的区间。
2. 在“输入指标”中维护：
   - 来源式，例如 `2*r + 0.1`，表示该字段由共同来源导出；
   - 或留空公式并填写独立误差区间。
3. 输入目标表达式，例如 `y - 2*x`、`a*b/a`、`log(x)*x + sqrt(x)`。
4. 设置并锁定细分叶盒预算，点击“锁定配置并对比两种求界”。
5. 查看：
   - 普通区间与相关区间的同一数轴对比；
   - 已证实外包络、可行采样 bracket、下界/上界证书间隙；
   - 完整来源 → 指标 → AST 运算 → 目标依赖图；
   - 每个运算节点的区间、宽度增量和放大倍数；
   - 自适应细分盒明细；
   - 全量任务 JSON、运算 CSV、细分盒 CSV、Markdown 证明报告。
6. 可从任务历史重新打开旧任务；旧任务不会被新配置覆盖。

## 两种计算方式

### 1. 普通区间

每个输入指标按各自 `[lo, hi]` 独立处理，使用外向舍入的区间四则运算与单调函数包络。
重复出现的 `x` 被当作多个独立区间出现，因此：

```text
x ∈ [0.95, 1.05]
x - x  =>  [-0.10, 0.10]   # 普通区间
```

### 2. 保留相关依赖

所有字段先投影到统一的原始来源/独立误差盒。每个来源表示为仿射符号：

```text
s = midpoint + radius * ε_s,  ε_s ∈ [-1, 1]
```

加减和线性缩放保留同一符号系数，因此同一依赖会自动合并/抵消：

```text
x - x          => [0, 0]
y = 2r         ┐
目标 y - 2x    ├─ 同一 r 依赖抵消 => [0, 0]
x = r          ┘
```

乘除法中的非线性项使用保守残差：

- 乘法：`|δa δb| ≤ radiusA * radiusB`；
- 倒数、`exp`、`log`、`sqrt`：使用割线/切点构造的线性包络加残差半径；
- 当根盒残差过宽时，按候选来源做确定性二分，优先分割能最大降低子盒宽度的维度；
- 所有叶盒严格区间的并集给出最终外包络。

此外，计算前会在**原始 AST** 上做代数消去，避免化简掩盖域问题：

- 加减同类项：`a + b - a → b`；
- 乘除同因子：`a*b/a → b`、`x/x → 1`。

## 已证实范围与松弛

每个完成的模式都输出：

```text
certified = [L, U]                       # 所有可行值必在其中
observed raw = [p_min, p_max]             # 确定性采样的 Float64 显示值，仅为可行观察
每个采样点另有单点子区间外向保护 [p_i^-, p_i^+]
minimumUpper = min_i p_i^+                # 真实最小值的已知可行上界
maximumLower = max_i p_i^-                # 真实最大值的已知可行下界
真实最小值 ∈ [L, minimumUpper]
真实最大值 ∈ [maximumLower, U]
lowerCertificateGap = minimumUpper - L    # 下界松弛的可证明上界
upperCertificateGap = U - maximumLower    # 上界松弛的可证明上界
```

采样会在消去后的规范化 AST 上执行，并通过单点区间求值累积外向舍入保护；
即便原始运算结合顺序产生约 1–2 ulp 差异，bracket 仍保持有序。若没有采到内部
极值，间隙会如实显示为尚未收紧，而不是把 `p_max` 宣布成严格上界。

所有仿射范围（包括总噪声半径恰为零的常数形式）都会经过同一外向 ulp 扩宽，
避免 `0.7^4` 这类重复乘法与采样点的运算结合顺序不同而越过端点。对于
`1e-200 * 1e-200` 这种数学值为正、Float64 却下溢成零的运算，区间乘法和仿射
乘法会按可证明符号加入 `Number.MIN_VALUE` 量级的 subnormal 保护；因此零仍可
作为下界，但不会被误当成正乘积的严格上界。该保护是保守包络，不声称恢复了
下溢前的精确值。

## 计算前阻断

以下问题在创建严格界之前阻断，并返回错误码与依赖图：

- `DOMAIN_DIV_ZERO`：除数的严格/保守区间包含 `0`；
- `DOMAIN_LOG`：`log` 参数下界 `<= 0`；
- `DOMAIN_SQRT`：`sqrt` 参数下界严格小于 `0`；精确零边界可正常通过；
- `CYCLE`：指标公式相互引用，错误详情含 `a → b → a`；
- `PARSE_ERROR` / `UNKNOWN_VARIABLE` / `INVALID_MODEL`。

域检查针对原始表达式执行；`x/x → 1` 这类化简发生在域预检之后，因此不能用化简隐藏跨零除数。

普通区间会丢弃依赖，可能对 `sqrt(x*x)`（`x ∈ [-1,1]`）给出“参数为负”的假日志/平方根域冲突；此时普通模式标记为 `domain-blocked`，而保留同一符号依赖的相关域预检可证明参数非负并继续求界。只有相关预检同样证实存在非法域时，任务才会在生成严格界前整体阻断。

## 不可变版本与后台任务

`ProjectStore` 保存：

- `expressionVersions`：不可变表达式版本；
- `inputVersions`：不可变来源/输入版本；
- `jobs`：每个任务冻结自己的 `expressionVersion`、`inputVersion`、`options.budget` 和
  `configSnapshot`，并保存 `result` 或 `error`。

`POST /api/jobs` 中的临时配置只写入该任务快照，**不会更新当前草稿或当前版本指针**。
显式 `PUT /api/project` 才会保存新草稿并创建新版本。

### API

```text
GET  /api/health
GET  /api/bootstrap
GET  /api/project
PUT  /api/project
POST /api/analyze           # 无任务封装的一次性分析
POST /api/jobs              # 创建不可变求界任务
GET  /api/jobs
GET  /api/jobs/:id
GET  /api/jobs/:id/dependency-graph
GET  /api/jobs/:id/export?format=json
GET  /api/jobs/:id/export?format=ledger.csv
GET  /api/jobs/:id/export?format=boxes.csv
GET  /api/jobs/:id/export?format=md
```

创建任务示例：

```bash
curl -s -X POST http://127.0.0.1:4173/api/jobs \
  -H 'content-type: application/json' \
  -d @examples/cancellation-payload.json
```

`examples/` 同时包含可直接 POST 的 payload（如 `cancellation-payload.json`）、单个
`{ "config": ..., "expect": ... }` 核对文件，以及 `{ "cases": [...] }` 多场景文件。
运行 `npm run verify:examples` 可统一核对这些样例。

## 核对样例

| 样例 | 表达式/配置 | 期望 |
|---|---|---|
| 消去式 | `x - x`，`x∈[.95,1.05]` | 普通区间放宽；相关模式 `[0,0]` |
| 共同来源 | `y - 2*x`，`x=r`, `y=2r` | 相关模式 `[0,0]` |
| 乘除相关 | `a*b/a`，`a=r`, `b=3r`, `r∈[1,2]` | 化简为 `b`，相关界约 `[3,6]` |
| 非线性细分 | `x*x-x`, `x∈[0,1]` | 真值 `[-.25,0]`，预算越大包络越紧 |
| 除数冲突 | `1/(x-1)`, `x∈[0,2]` | `DOMAIN_DIV_ZERO` |
| 对数冲突 | `log(x)`, `x∈[-.2,1]` | `DOMAIN_LOG` |
| 循环 | `a=b+1`, `b=a*2` | `CYCLE` |

可解析样例文件位于 `examples/`，自动化核对位于 `test/`。

## 目录

```text
server.js                  # 零依赖 HTTP 启动入口
src/core/parser.js         # 词法/递归下降解析器
src/core/intervals.js      # 外向舍入区间运算与域错误
src/core/affine.js         # 依赖保持仿射形式和非线性包络
src/core/simplify.js       # 加减/乘除相关消去
src/core/graph.js          # 完整依赖图与环检测
src/core/model.js          # 模型校验、版本无关编译
src/core/evaluator.js      # 区间/仿射/点值求值与运算台账
src/core/analyzer.js       # 自适应细分、证明间隙、对比结果
src/core/exporters.js      # JSON/CSV/Markdown 导出
src/server/app.js          # 静态资源与 HTTP API
src/server/store.js        # 不可变版本和任务仓储
web/                       # 中文原生 JS 网页
examples/                  # 可解析核对样例
test/                      # Node 内置测试套件
```

## 严谨性边界

- 区间端点使用相邻 Float64 外向扩宽和额外 ulp guard；但它不是带机器证明的任意精度区间库。
- 仿射乘法残差是保守上界，函数包络使用割线/切点最大偏差并加数值 guard。
- 自适应细分返回的是**外包络**；预算有限时通常仍有松弛，报告中明确展示。
- 采样 bracket 只用于定位证书间隙，不用于证明全局最大值或最小值。
