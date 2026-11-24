// Parseable reference cases used by the UI, tests and examples/ files.

export const DEFAULT_CONFIG = {
  sources: [
    { id: 'r', name: '共同原始读数 r', lo: 0.95, hi: 1.05, unit: 'mm' },
  ],
  inputs: [
    { name: 'x', label: '字段 X（读数 r）', formula: 'r', unit: 'mm' },
    { name: 'y', label: '字段 Y（2r）', formula: '2*r', unit: 'mm' },
  ],
  expression: 'y - 2*x',
};

export const SAMPLES = [
  {
    id: 'common-source-cancellation',
    name: '共同来源消去：y − 2x',
    description: 'x 与 y 来自同一读数 r；相关模式应得到常数 0，普通区间会重复放大误差。',
    config: DEFAULT_CONFIG,
    expected: { correlated: [0, 0], ordinaryWidthPositive: true },
  },
  {
    id: 'same-symbol-cancellation',
    name: '同一读数：x − x',
    description: '同一误差符号重复出现，仿射依赖使其立即消去。',
    config: {
      sources: [],
      inputs: [{ name: 'x', label: '同一读数', lo: 0.95, hi: 1.05 }],
      expression: 'x - x',
    },
    expected: { correlated: [0, 0] },
  },
  {
    id: 'mul-div-correlation',
    name: '乘除相关：a*b/a',
    description: '可解析乘除消去；普通区间给出过宽包络，相关模式回到 b=3r。',
    config: {
      sources: [{ id: 'r', name: '正读数 r', lo: 1, hi: 2 }],
      inputs: [
        { name: 'a', label: 'a=r', formula: 'r' },
        { name: 'b', label: 'b=3r', formula: '3*r' },
      ],
      expression: 'a*b/a',
    },
    expected: { correlated: [3, 6], normalized: 'b' },
  },
  {
    id: 'nonlinear-subdivision',
    name: '非线性包络与细分：x² − x',
    description: '真实范围为 [−0.25, 0]；增大叶盒预算可收紧保守包络。',
    config: {
      sources: [],
      inputs: [{ name: 'x', label: '非线性输入', lo: 0, hi: 1 }],
      expression: 'x*x - x',
    },
    expected: { trueRange: [-0.25, 0] },
  },
  {
    id: 'divisor-zero-conflict',
    name: '域冲突：除数跨零',
    description: 'x∈[0,2] 时 x−1 跨零，必须在求界前阻断。',
    config: {
      sources: [],
      inputs: [{ name: 'x', label: '跨零输入', lo: 0, hi: 2 }],
      expression: '1/(x - 1)',
    },
    expectedError: 'DOMAIN_DIV_ZERO',
  },
  {
    id: 'log-domain-conflict',
    name: '域冲突：log 参数非法',
    description: 'x∈[−0.2,1] 包含非正 log 域，必须在计算前阻断。',
    config: {
      sources: [],
      inputs: [{ name: 'x', label: '含非正区间', lo: -0.2, hi: 1 }],
      expression: 'log(x)',
    },
    expectedError: 'DOMAIN_LOG',
  },
  {
    id: 'cycle-conflict',
    name: '表达式循环：a ↔ b',
    description: '指标公式相互引用形成循环，依赖图检查阶段阻断。',
    config: {
      sources: [],
      inputs: [
        { name: 'a', label: 'a', formula: 'b + 1' },
        { name: 'b', label: 'b', formula: 'a * 2' },
      ],
      expression: 'a',
    },
    expectedError: 'CYCLE',
  },
];

export function getSample(id) {
  return SAMPLES.find((s) => s.id === id) || null;
}
