// Deterministic detail exporters. These run in Node or browser and never infer
// strict extrema from samples.

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const header = columns.map(csvCell).join(',');
  const lines = rows.map((row) => columns.map((col) => csvCell(row[col])).join(','));
  return [header, ...lines].join('\n');
}

export function jobToJson(job) {
  return JSON.stringify(job, jsonReplacer, 2);
}

function jsonReplacer(key, value) {
  if (value instanceof Set) return [...value];
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function ledgerCsv(job) {
  const result = job.result || job.analysis || null;
  const rows = [];
  for (const mode of ['ordinary', 'correlated']) {
    const modeResult = result?.[mode];
    if (!modeResult?.ledger) continue;
    for (const row of modeResult.ledger) {
      rows.push({
        mode,
        nodeId: row.nodeId,
        expansionRank: row.expansionRank || '',
        isTopExpander: row.isTopExpander ? 'yes' : '',
        kind: row.kind,
        operator: row.op || row.name || '',
        expression: row.expression,
        lo: row.interval?.lo,
        hi: row.interval?.hi,
        width: row.width,
        maxChildWidth: row.maxChildWidth ?? '',
        widthGrowth: row.widthGrowth ?? '',
        amplificationRatio: row.amplificationRatio ?? '',
        affineConstant: row.affine?.c ?? '',
        affineResidual: row.affine?.e ?? '',
        affineTerms: row.affine?.terms?.map((t) => `${t.key}:${t.coefficient}`).join('; ') || '',
      });
    }
  }
  return toCsv(rows, [
    'mode', 'nodeId', 'expansionRank', 'isTopExpander', 'kind', 'operator', 'expression',
    'lo', 'hi', 'width', 'maxChildWidth', 'widthGrowth', 'amplificationRatio',
    'affineConstant', 'affineResidual', 'affineTerms',
  ]);
}

export function boxesCsv(job) {
  const leaves = job.result?.correlated?.leaves || job.analysis?.correlated?.leaves || [];
  const rows = leaves.map((leaf) => ({
    leafId: leaf.id,
    parentId: leaf.parentId || '',
    depth: leaf.depth,
    splitDimension: leaf.splitDimension || '',
    lo: leaf.lo,
    hi: leaf.hi,
    width: leaf.width,
    box: leaf.box.map((b) => `${b.symbol}[${b.lo},${b.hi}]`).join('; '),
    boxJson: JSON.stringify(leaf.box),
  }));
  return toCsv(rows, ['leafId', 'parentId', 'depth', 'splitDimension', 'lo', 'hi', 'width', 'box', 'boxJson']);
}

export function markdownReport(job) {
  const r = job.result || job.analysis || {};
  const lines = [];
  lines.push(`# 指标可信范围分析任务 ${job.id}`);
  lines.push('');
  lines.push(`- 状态：${job.status}`);
  lines.push(`- 创建时间：${job.createdAt}`);
  lines.push(`- 表达式版本：${job.expressionVersion?.id || '—'}（内容已冻结）`);
  lines.push(`- 输入版本：${job.inputVersion?.id || '—'}（内容已冻结）`);
  lines.push(`- 细分预算：${job.options?.budget ?? r.options?.budget ?? '—'} 个叶盒；锁定：${job.options?.budgetLocked === false ? '否' : '是'}`);
  lines.push('');

  if (job.status === 'blocked' || job.error) {
    lines.push('## 计算前阻断');
    lines.push('');
    lines.push(`- 错误码：${job.error?.code || 'UNKNOWN'}`);
    lines.push(`- 原因：${job.error?.message || job.error}`);
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## 表达式与消去');
  lines.push('');
  lines.push(`- 原始表达式：\`${r.expression?.original}\``);
  lines.push(`- 相关式化简：\`${r.expression?.normalized}\``);
  for (const c of r.expression?.cancellations || []) {
    lines.push(`- 已消去${c.type === 'additive' ? '加减相关项' : '乘除相关因子'}：\`${c.expression}\``);
  }
  lines.push('');

  for (const [key, title] of [['ordinary', '普通区间'], ['correlated', '保留相关依赖']]) {
    const m = r[key];
    lines.push(`## ${title}`);
    lines.push('');
    if (!m || m.status !== 'ok') {
      lines.push(`状态：${m?.status || 'unavailable'}`);
      if (m?.error) lines.push(`原因：${m.error.message}`);
      lines.push('');
      continue;
    }
    lines.push(`- 已证实外包络：\`[${m.certified.lo}, ${m.certified.hi}]\``);
    lines.push(`- 区间宽度：${m.width}`);
    if (m.subdivision?.adaptive) {
      lines.push(`- 自适应细分：${m.subdivision.leaves} 个叶盒，${m.subdivision.splits} 次分割，约 ${m.subdivision.evaluations} 次包络计算`);
    }
    if (m.proof) lines.push(`- 证明/松弛说明：${m.proof.statement}`);
    lines.push('');
  }

  if (r.comparison) {
    lines.push('## 对比');
    lines.push('');
    lines.push(`- 普通区间宽度：${r.comparison.ordinaryWidth}`);
    lines.push(`- 相关区间宽度：${r.comparison.correlatedWidth}`);
    lines.push(`- 相对收紧：${(r.comparison.relativeReduction * 100).toFixed(2)}%`);
    lines.push('');
  }

  lines.push('## 扩界运算 Top 10');
  lines.push('');
  lines.push('| 模式 | 排名 | 运算 | 表达式 | 区间 | 宽度增量 |');
  lines.push('|---|---:|---|---|---:|---:|');
  for (const mode of ['ordinary', 'correlated']) {
    const rows = (r[mode]?.ledger || []).slice().sort((a, b) => a.expansionRank - b.expansionRank).slice(0, 10);
    for (const row of rows) {
      lines.push(`| ${mode} | ${row.expansionRank} | ${row.op || row.name || row.kind} | \`${row.expression}\` | [${row.interval.lo}, ${row.interval.hi}] | ${row.widthGrowth} |`);
    }
  }
  lines.push('');
  lines.push('> 采样最大值不是严格上界；严格结论只来自区间/仿射包络和细分盒并集。');
  return lines.join('\n');
}
