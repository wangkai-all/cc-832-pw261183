import { SAMPLES } from '/src/core/samples.js';
import { formatInterval, formatNumber } from '/src/core/intervals.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  config: { sources: [], inputs: [], expression: '' },
  samples: SAMPLES,
  currentJob: null,
  jobs: [],
  activeTab: 'graph',
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmt(x, digits = 5) {
  return formatNumber(x, digits);
}

function fmtIv(iv) {
  return iv ? formatInterval(iv, 5) : '—';
}

function clone(value) {
  return structuredClone(value);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function showAlert(message, kind = 'error') {
  const alert = $('#configAlert');
  if (!message) {
    alert.hidden = true;
    alert.textContent = '';
    alert.className = 'alert';
    return;
  }
  alert.hidden = false;
  alert.className = `alert ${kind === 'success' ? 'success' : ''}`;
  alert.textContent = message;
}

function renderSampleBar() {
  const select = $('#sampleSelect');
  select.innerHTML = SAMPLES.map(
    (s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`,
  ).join('');

  const wrap = $('#sampleButtons');
  wrap.innerHTML = '';
  const runSample = document.createElement('button');
  runSample.className = 'btn btn-secondary btn-sm';
  runSample.type = 'button';
  runSample.textContent = '载入并核对';
  runSample.addEventListener('click', () => {
    const sample = SAMPLES.find((s) => s.id === select.value) || SAMPLES[0];
    loadConfig(sample.config);
    runAnalysis();
  });
  wrap.appendChild(runSample);

  select.addEventListener('change', () => {
    const sample = SAMPLES.find((s) => s.id === select.value);
    if (sample) loadConfig(sample.config);
  });
}

function loadConfig(config) {
  state.config = clone(config);
  showAlert('');
  renderEditors();
}

function renderEditors() {
  renderSources();
  renderInputs();
  $('#expressionInput').value = state.config.expression || '';
}

function renderSources() {
  const tbody = $('#sourceTable tbody');
  tbody.innerHTML = state.config.sources.map((s, index) => `
    <tr data-index="${index}">
      <td><input class="symbol-input" data-field="id" value="${esc(s.id)}" aria-label="来源符号"></td>
      <td><input data-field="name" value="${esc(s.name)}" aria-label="来源名称"></td>
      <td><input data-field="lo" type="number" step="any" value="${esc(s.lo)}" aria-label="下界"></td>
      <td><input data-field="hi" type="number" step="any" value="${esc(s.hi)}" aria-label="上界"></td>
      <td><button class="icon-btn" data-action="delete-source" title="删除来源" type="button">×</button></td>
    </tr>
  `).join('');
}

function renderInputs() {
  const root = $('#inputEditorList');
  root.innerHTML = state.config.inputs.map((input, index) => {
    const hasFormula = Boolean(input.formula && input.formula.trim());
    return `
      <article class="input-card" data-index="${index}">
        <div class="input-card-head">
          <input data-field="name" class="mono" value="${esc(input.name)}" aria-label="指标符号" placeholder="变量名">
          <input data-field="label" value="${esc(input.label || '')}" aria-label="显示名" placeholder="显示名">
          <button class="icon-btn" data-action="delete-input" title="删除指标" type="button">删除</button>
        </div>
        <div class="formula-row">
          <label class="field-label">来源式（可引用来源或其他指标；留空则为独立误差区间）</label>
          <input data-field="formula" class="mono" value="${esc(input.formula || '')}" placeholder="例如 2*r + 0.1">
        </div>
        <div class="range-row" style="margin-top:8px">
          <div>
            <label class="field-label">下界 ${hasFormula ? '（公式导出，编辑时忽略）' : ''}</label>
            <input data-field="lo" type="number" step="any" value="${input.lo ?? ''}" ?disabled="${hasFormula}" ${hasFormula ? 'disabled' : ''}>
          </div>
          <div>
            <label class="field-label">上界 ${hasFormula ? '（公式导出，编辑时忽略）' : ''}</label>
            <input data-field="hi" type="number" step="any" value="${input.hi ?? ''}" ?disabled="${hasFormula}" ${hasFormula ? 'disabled' : ''}>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function bindEditorEvents() {
  $('#addSourceBtn').addEventListener('click', () => {
    const i = state.config.sources.length + 1;
    state.config.sources.push({ id: `s${i}`, name: `来源 ${i}`, lo: -1, hi: 1 });
    renderSources();
  });

  $('#addInputBtn').addEventListener('click', () => {
    const i = state.config.inputs.length + 1;
    state.config.inputs.push({ name: `m${i}`, label: `指标 ${i}`, formula: '', lo: -1, hi: 1 });
    renderInputs();
  });

  $('#sourceTable').addEventListener('input', (event) => {
    const input = event.target.closest('input[data-field]');
    if (!input) return;
    const row = event.target.closest('tr[data-index]');
    const index = Number(row.dataset.index);
    const field = input.dataset.field;
    state.config.sources[index][field] = field === 'lo' || field === 'hi' ? input.valueAsNumber : input.value;
  });

  $('#sourceTable').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="delete-source"]');
    if (!button) return;
    const index = Number(button.closest('tr[data-index]').dataset.index);
    state.config.sources.splice(index, 1);
    renderSources();
  });

  $('#inputEditorList').addEventListener('input', (event) => {
    const input = event.target.closest('input[data-field]');
    if (!input) return;
    const card = event.target.closest('.input-card[data-index]');
    const index = Number(card.dataset.index);
    const field = input.dataset.field;
    state.config.inputs[index][field] = field === 'lo' || field === 'hi' ? input.valueAsNumber : input.value;
    if (field === 'formula') {
      const hasFormula = Boolean(input.value.trim());
      $$('input[data-field="lo"], input[data-field="hi"]', card).forEach((rangeInput) => {
        rangeInput.disabled = hasFormula;
      });
    }
  });

  $('#inputEditorList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="delete-input"]');
    if (!button) return;
    const index = Number(button.closest('.input-card[data-index]').dataset.index);
    state.config.inputs.splice(index, 1);
    renderInputs();
  });

  $('#expressionInput').addEventListener('input', (event) => {
    state.config.expression = event.target.value;
  });

  $$('.operator-pad button').forEach((button) => {
    button.addEventListener('click', () => {
      const textarea = $('#expressionInput');
      const insert = button.dataset.insert;
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      textarea.value = textarea.value.slice(0, start) + insert + textarea.value.slice(end);
      state.config.expression = textarea.value;
      textarea.focus();
      const cursor = insert === '()' ? start + 1 : start + insert.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  });

  $('#runBtn').addEventListener('click', runAnalysis);
  $('#saveDraftBtn').addEventListener('click', saveDraft);
  $('#refreshJobsBtn').addEventListener('click', loadJobs);

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === state.activeTab));
    });
  });

  document.addEventListener('click', (event) => {
    const exportButton = event.target.closest('[data-export]');
    if (exportButton) {
      if (!state.currentJob) return;
      window.open(`/api/jobs/${state.currentJob.id}/export?format=${encodeURIComponent(exportButton.dataset.export)}`, '_blank');
    }
    const jobButton = event.target.closest('[data-view-job]');
    if (jobButton) viewJob(jobButton.dataset.viewJob);
  });

  $('#themeToggle').addEventListener('click', toggleTheme);
}

async function saveDraft() {
  showAlert('正在保存不可变版本…', 'success');
  const { body } = await api('/api/project', {
    method: 'PUT',
    body: JSON.stringify({ config: state.config }),
  });
  if (body.ok) {
    showAlert(`已保存：表达式版本 ${body.project.currentExpressionVersionId}，输入版本 ${body.project.currentInputVersionId}。计算任务仍冻结各自快照。`, 'success');
  } else {
    showAlert(body.error?.message || '保存失败');
  }
}

async function runAnalysis() {
  const budget = Math.max(1, Math.min(512, Number($('#budgetInput').value) || 64));
  const budgetLocked = $('#budgetLock').checked;
  $('#budgetInput').value = budget;
  const button = $('#runBtn');
  button.disabled = true;
  button.textContent = '正在进行域检查与求界…';
  showAlert('');

  try {
    const { body } = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ ...state.config, budget, budgetLocked }),
    });
    const job = body.job;
    if (!job) throw new Error(body.error?.message || '后台未返回任务');
    state.currentJob = job;
    renderJob(job);
    await loadJobs();
  } catch (error) {
    showAlert(`请求后台失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = '锁定配置并对比两种求界';
  }
}

async function loadJobs() {
  const { body } = await api('/api/jobs');
  state.jobs = body.jobs || [];
  renderJobsTable();
}

async function viewJob(id) {
  const { body } = await api(`/api/jobs/${id}`);
  if (body.job) {
    state.currentJob = body.job;
    renderJob(body.job);
  }
}

function renderJob(job) {
  $('#emptyState').hidden = true;
  $('#resultContent').hidden = false;
  $('#detailsPanel').hidden = false;
  $('#jobMeta').innerHTML = `任务 <code>${esc(job.id)}</code><br>表达式 <code>${esc(job.expressionVersion.id)}</code> · 输入 <code>${esc(job.inputVersion.id)}</code> · 预算 ${esc(job.options.budget)} 叶盒${job.options.budgetLocked ? ' 🔒' : ''}`;

  renderBlocked(job);
  renderBoundCards(job);
  renderChart(job);
  renderProofs(job);
  renderGraph(job);
  renderLedger(job);
  renderBoxes(job);
  $('#jsonView').textContent = JSON.stringify(job, null, 2);
  renderJobsTable();
}

function renderBlocked(job) {
  const banner = $('#blockedBanner');
  if (job.status !== 'blocked') {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  const e = job.error || {};
  const issues = e.details?.issues || [];
  const cycle = e.details?.cycle;
  banner.hidden = false;
  banner.innerHTML = `
    <h3>⛔ 计算前已阻断：${esc(e.code || 'INVALID')}</h3>
    <p>${esc(e.message || '模型未通过检查')}</p>
    ${cycle ? `<pre>${esc(cycle.join(' → '))}</pre>` : ''}
    ${issues.length ? `<ul>${issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <p class="hint">没有生成任何严格界；请修正域、循环或表达式后创建新任务。旧任务与配置仍保留。</p>
  `;
}

function renderBoundCards(job) {
  const r = job.result;
  if (job.status === 'blocked' || !r) {
    $('#ordinaryBound').textContent = '已阻断';
    $('#correlatedBound').textContent = '未计算';
    $('#ordinaryWidth').textContent = '—';
    $('#correlatedWidth').textContent = '—';
    $('#savingsValue').textContent = '—';
    $('#savingsSub').textContent = '—';
    $('#exactNote').textContent = job.error?.message || '请先解除域或循环冲突。';
    return;
  }

  const o = r.ordinary;
  const c = r.correlated;
  if (o.status === 'ok') {
    $('#ordinaryBound').textContent = fmtIv(o.certified);
    $('#ordinaryWidth').textContent = `宽度 ${fmt(o.width)}`;
  } else {
    $('#ordinaryBound').textContent = '普通区间域阻断';
    $('#ordinaryWidth').textContent = o.error?.code || '';
  }
  $('#correlatedBound').textContent = fmtIv(c.certified);
  $('#correlatedWidth').textContent = `宽度 ${fmt(c.width)} · ${c.subdivision.leaves} 叶盒`;

  const cmp = r.comparison;
  if (cmp) {
    $('#savingsValue').textContent = `${(cmp.relativeReduction * 100).toFixed(1)}%`;
    $('#savingsSub').textContent = `宽度缩小 ${fmt(cmp.absoluteReduction)}，比值 ${fmt(cmp.widthRatio, 4)}`;
    $('#exactNote').textContent = cmp.exactDependencyCancellation
      ? '相关模式得到数值零宽度：同一来源/因子依赖已保留或消去。'
      : '百分比为两种严格外包络的宽度差；不是采样最大值之差。';
  }
}

function renderChart(job) {
  const host = $('#boundChart');
  const tooltip = $('#chartTooltip');
  const r = job.result;
  if (!r) {
    host.innerHTML = '<p class="hint">阻断任务没有可绘制的界。</p>';
    return;
  }
  const rows = [];
  if (r.ordinary?.status === 'ok') rows.push({ key: 'ordinary', label: '普通区间', ...r.ordinary.certified, color: 'var(--orange)' });
  if (r.correlated?.status === 'ok') rows.push({ key: 'correlated', label: '相关区间', ...r.correlated.certified, color: 'var(--blue)' });
  if (!rows.length) return;

  let min = Math.min(...rows.map((d) => d.lo));
  let max = Math.max(...rows.map((d) => d.hi));
  const observed = r.samples?.observed;
  if (observed) {
    min = Math.min(min, observed.lo);
    max = Math.max(max, observed.hi);
  }
  if (min === max) {
    min -= Math.max(1, Math.abs(min) * 0.1);
    max += Math.max(1, Math.abs(max) * 0.1);
  } else {
    const pad = (max - min) * 0.12;
    min -= pad; max += pad;
  }

  const W = 920;
  const H = 230;
  const m = { top: 24, right: 42, bottom: 42, left: 150 };
  const plotW = W - m.left - m.right;
  const x = (v) => m.left + ((v - min) / (max - min)) * plotW;
  const ticks = Array.from({ length: 6 }, (_, i) => min + ((max - min) * i) / 5);
  const yPositions = [54, 104];

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="普通区间与相关区间对比图">`;
  ticks.forEach((tick) => {
    const xx = x(tick);
    svg += `<line x1="${xx}" x2="${xx}" y1="24" y2="174" stroke="var(--grid)" stroke-width="1"/>`;
    svg += `<text x="${xx}" y="194" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(fmt(tick, 4))}</text>`;
  });
  if (min < 0 && max > 0) {
    svg += `<line x1="${x(0)}" x2="${x(0)}" y1="24" y2="174" stroke="var(--text-2)" stroke-width="1.4" stroke-dasharray="4 4"/>`;
    svg += `<text x="${x(0) + 5}" y="34" font-size="11" fill="var(--text-2)">0</text>`;
  }

  if (observed) {
    svg += `<rect x="${x(observed.lo)}" y="34" width="${Math.max(2, x(observed.hi) - x(observed.lo))}" height="130" rx="5" fill="var(--observed)" opacity="0.12"/>`;
    [observed.lo, observed.hi].forEach((v) => {
      svg += `<line x1="${x(v)}" x2="${x(v)}" y1="38" y2="166" stroke="var(--observed)" stroke-width="2.4" stroke-dasharray="5 4"/>`;
    });
  }

  rows.forEach((row, i) => {
    const y = yPositions[i] ?? 145;
    const xx = x(row.lo);
    const w = Math.max(3, x(row.hi) - x(row.lo));
    svg += `<text x="${m.left - 12}" y="${y + 15}" text-anchor="end" font-size="13" font-weight="700" fill="var(--text)">${esc(row.label)}</text>`;
    svg += `<g class="chart-mark" data-tip="${esc(`${row.label} 严格外包络：[${row.lo}, ${row.hi}]；宽度 ${row.hi - row.lo}`)}">
      <rect x="${xx}" y="${y}" width="${w}" height="28" rx="8" fill="${row.color}" opacity="0.88"/>
      <rect x="${xx}" y="${y}" width="${w}" height="28" rx="8" fill="none" stroke="var(--surface)" stroke-width="2"/>
      <text x="${xx + w / 2}" y="${y + 18}" text-anchor="middle" font-size="11.5" font-weight="800" fill="white">${esc(fmtIv(row))}</text>
    </g>`;
  });

  if (observed) {
    svg += `<text x="${x(observed.hi) + 8}" y="176" font-size="11.5" fill="var(--observed-text)" font-weight="700">可行采样 ${esc(fmtIv(observed))}（非严格界）</text>`;
  }
  svg += `<line x1="${m.left}" x2="${W - m.right}" y1="174" y2="174" stroke="var(--border-strong)"/>`;
  svg += `</svg>`;
  host.innerHTML = svg;

  $$('.chart-mark', host).forEach((mark) => {
    mark.addEventListener('mousemove', (event) => {
      tooltip.hidden = false;
      tooltip.textContent = mark.dataset.tip;
      tooltip.style.left = `${event.clientX}px`;
      tooltip.style.top = `${event.clientY}px`;
    });
    mark.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  });
}

function renderProofs(job) {
  const root = $('#proofCards');
  const r = job.result;
  if (!r) {
    root.innerHTML = '';
    return;
  }
  root.innerHTML = ['ordinary', 'correlated'].map((mode) => {
    const m = r[mode];
    const title = mode === 'ordinary' ? '普通区间：已证实范围与松弛' : '相关模式：已证实范围与松弛';
    if (m.status !== 'ok') {
      return `<article class="proof-card"><h4>${title}</h4><span class="pill block">不可用</span><p>${esc(m.error?.message || '该模式未完成')}</p></article>`;
    }
    const p = m.proof;
    return `
      <article class="proof-card">
        <h4>${title} <span class="pill ok">外包络可靠</span></h4>
        <p>${esc(p.statement)}</p>
        <dl class="proof-stat">
          <dt>严格外包络</dt><dd>${esc(fmtIv(m.certified))}</dd>
          <dt>证书下界间隙</dt><dd>${p.lowerCertificateGap === null ? '—' : esc(fmt(p.lowerCertificateGap))}</dd>
          <dt>证书上界间隙</dt><dd>${p.upperCertificateGap === null ? '—' : esc(fmt(p.upperCertificateGap))}</dd>
          <dt>细分叶盒 / 预算</dt><dd>${m.subdivision?.leaves ?? 1} / ${esc(job.options.budget)}</dd>
        </dl>
      </article>
    `;
  }).join('');
}

function renderGraph(job) {
  const graph = job.result?.dependencyGraph || job.error?.details?.graph;
  const wrap = $('#graphWrap');
  if (!graph) {
    wrap.innerHTML = '<p style="padding:16px" class="hint">没有可显示的依赖图。</p>';
    return;
  }

  const layerGap = 205;
  const rowGap = 62;
  const nodeW = 184;
  const nodeH = 48;
  const paddingX = 18;
  const paddingY = 24;
  const byLayer = new Map();
  for (const node of graph.nodes) {
    const layer = node.layer || 0;
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer).push(node);
  }
  const maxLayer = Math.max(0, ...graph.nodes.map((n) => n.layer || 0));
  const maxCount = Math.max(...[...byLayer.values()].map((x) => x.length), 1);
  const width = paddingX * 2 + (maxLayer + 1) * layerGap;
  const height = paddingY * 2 + maxCount * rowGap;
  const position = new Map();

  for (const [layer, nodes] of byLayer) {
    nodes.forEach((node, index) => {
      position.set(node.id, {
        x: paddingX + layer * layerGap,
        y: paddingY + index * rowGap,
      });
    });
  }

  let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="完整依赖图">
    <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--border-strong)"/></marker></defs>`;

  for (const edge of graph.edges) {
    const a = position.get(edge.from);
    const b = position.get(edge.to);
    if (!a || !b) continue;
    const x1 = a.x + nodeW;
    const y1 = a.y + nodeH / 2;
    const x2 = b.x;
    const y2 = b.y + nodeH / 2;
    const bend = Math.max(35, (x2 - x1) / 2);
    svg += `<path class="graph-edge ${edge.kind === 'reference' ? 'reference' : ''}" d="M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}" marker-end="url(#arrow)"><title>${esc(edge.from)} → ${esc(edge.to)} (${esc(edge.kind)})</title></path>`;
  }

  for (const node of graph.nodes) {
    const p = position.get(node.id);
    const detail = node.detail || '';
    const sub = detail.length > 25 ? `${detail.slice(0, 24)}…` : detail;
    svg += `
      <g class="graph-node kind-${esc(node.kind)}" transform="translate(${p.x},${p.y})">
        <title>${esc(node.id)}&#10;${esc(detail)}</title>
        <rect width="${nodeW}" height="${nodeH}" rx="10"></rect>
        <text x="10" y="20" font-weight="800">${esc(truncate(node.label || node.id, 24))}</text>
        <text class="sub" x="10" y="38">${esc(truncate(sub, 28))}</text>
      </g>`;
  }
  svg += '</svg>';
  wrap.innerHTML = svg;
}

function truncate(text, n) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function renderLedger(job) {
  const table = $('#ledgerTable');
  const r = job.result;
  if (!r) {
    table.innerHTML = '<tbody><tr><td>阻断任务无运算明细</td></tr></tbody>';
    return;
  }
  const rows = [];
  for (const mode of ['ordinary', 'correlated']) {
    for (const row of r[mode]?.ledger || []) rows.push({ mode, ...row });
  }
  rows.sort((a, b) => (a.mode === b.mode ? a.expansionRank - b.expansionRank : a.mode.localeCompare(b.mode)));

  table.innerHTML = `
    <caption style="text-align:left;padding:8px 0;color:var(--text-2)">
      宽度增量 = 当前节点严格区间宽度 − 最宽直接子节点宽度；正值越大表示该运算越会扩大界。相关模式的消去式：${esc(r.expression.normalized)}
      ${r.expression.cancellations?.length ? `（已消去 ${r.expression.cancellations.map((c) => `<code>${esc(c.expression)}</code>`).join('、')}）` : ''}
    </caption>
    <thead><tr><th>模式</th><th>排名</th><th>运算</th><th>表达式</th><th>严格区间</th><th>宽度</th><th>宽度增量</th><th>放大倍数</th></tr></thead>
    <tbody>
      ${rows.map((row) => `
        <tr>
          <td><span class="mode-tag ${row.mode}">${row.mode === 'ordinary' ? '普通' : '相关'}</span></td>
          <td><span class="rank-badge ${row.isTopExpander ? 'top' : ''}">${row.expansionRank || ''}</span></td>
          <td class="mono">${esc(row.op || row.name || row.kind)}</td>
          <td class="mono">${esc(row.expression)}</td>
          <td class="mono">${esc(fmtIv(row.interval))}</td>
          <td class="mono">${esc(fmt(row.width))}</td>
          <td class="mono ${row.widthGrowth > 1e-10 ? 'growth-positive' : row.widthGrowth < -1e-10 ? 'growth-negative' : ''}">${esc(fmt(row.widthGrowth))}</td>
          <td class="mono">${row.amplificationRatio === null || row.amplificationRatio === undefined ? '—' : esc(fmt(row.amplificationRatio, 3)) + '×'}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

function renderBoxes(job) {
  const r = job.result;
  const summary = $('#boxesSummary');
  const table = $('#boxesTable');
  if (!r) {
    summary.innerHTML = '';
    table.innerHTML = '';
    return;
  }
  const s = r.correlated.subdivision;
  summary.innerHTML = `
    <span><strong>${s.leaves}</strong> 个叶盒</span>
    <span><strong>${s.splits}</strong> 次自适应分割</span>
    <span>约 <strong>${s.evaluations}</strong> 次包络计算（含选维试探）</span>
    <span>预算上限 <strong>${esc(job.options.budget)}</strong> ${job.options.budgetLocked ? '🔒 已锁定' : ''}</span>
    <span>${s.stoppedEarly ? '宽度已接近数值容差，提前停止' : '已用满预算或达到预算叶盒数'}</span>
  `;
  table.innerHTML = `
    <thead><tr><th>叶盒</th><th>父盒</th><th>深度</th><th>分割来源</th><th>严格下界</th><th>严格上界</th><th>宽度</th><th>输入域</th></tr></thead>
    <tbody>
      ${r.correlated.leaves.map((leaf) => `
        <tr>
          <td class="mono">${esc(leaf.id)}</td>
          <td class="mono">${esc(leaf.parentId || '—')}</td>
          <td>${leaf.depth}</td>
          <td class="mono">${esc(leaf.splitDimension || 'root')}</td>
          <td class="mono">${esc(fmt(leaf.lo))}</td>
          <td class="mono">${esc(fmt(leaf.hi))}</td>
          <td class="mono">${esc(fmt(leaf.width))}</td>
          <td class="mono" style="min-width:260px">${esc(leaf.box.map((b) => `${b.symbol}[${fmt(b.lo, 4)},${fmt(b.hi, 4)}]`).join('; '))}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

function renderJobsTable() {
  const tbody = $('#jobsTable tbody');
  if (!tbody) return;
  tbody.innerHTML = state.jobs.map((job) => `
    <tr data-job-row="${esc(job.id)}" class="${state.currentJob?.id === job.id ? 'selected' : ''}">
      <td><div class="job-meta-cell">${esc(job.id)}</div><div class="hint">${esc(job.createdAt)}</div></td>
      <td>${job.status === 'completed' ? '<span class="pill ok">完成</span>' : '<span class="pill block">阻断</span>'}</td>
      <td class="mono">${esc(job.expression)}</td>
      <td class="mono">${job.ordinary ? esc(fmtIv(job.ordinary)) : '—'}</td>
      <td class="mono">${job.correlated ? esc(fmtIv(job.correlated)) : job.errorCode ? esc(job.errorCode) : '—'}</td>
      <td>${job.relativeReduction === null || job.relativeReduction === undefined ? '—' : `${(job.relativeReduction * 100).toFixed(1)}%`}</td>
      <td><button class="btn btn-ghost btn-sm" data-view-job="${esc(job.id)}" type="button">查看</button></td>
    </tr>
  `).join('');
}

function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  localStorage.setItem('crs-theme', next);
  $('#themeToggle').textContent = next === 'dark' ? '切换浅色' : '切换深色';
}

async function init() {
  const savedTheme = localStorage.getItem('crs-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $('#themeToggle').textContent = document.documentElement.dataset.theme === 'dark' ? '切换浅色' : '切换深色';

  bindEditorEvents();
  renderSampleBar();

  try {
    const { body } = await api('/api/bootstrap');
    if (body.project?.draft) {
      state.config = body.project.draft;
      state.jobs = body.jobs || [];
    } else {
      state.config = clone(SAMPLES[0].config);
    }
  } catch {
    state.config = clone(SAMPLES[0].config);
    showAlert('后台 API 暂不可用；请使用 npm start 启动服务后再创建后台任务。');
  }

  $('#budgetInput').value = 64;
  renderEditors();
  renderJobsTable();
}

init();
