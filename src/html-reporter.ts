import type { ComparisonReport, PageComparison, Difference, Severity } from './types.js';

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function b64png(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function renderDiff(d: Difference): string {
  const cls = d.severity;
  const label = SEVERITY_LABEL[d.severity];
  const before = d.before
    ? `<div class="diff-before"><span class="diff-label">before</span><code>${esc(d.before)}</code></div>`
    : '';
  const after = d.after
    ? `<div class="diff-after"><span class="diff-label">after</span><code>${esc(d.after)}</code></div>`
    : '';
  return `
    <div class="diff-item ${cls}">
      <div class="diff-header">
        <span class="badge ${cls}">${label}</span>
        <span class="diff-field">${esc(d.field)}</span>
        <span class="diff-desc">${esc(d.description)}</span>
      </div>
      ${before}${after}
    </div>`;
}

function renderScreenshots(comp: PageComparison): string {
  if (!comp.screenshots) return '';
  const { a, b, diff } = comp.screenshots;
  const pct = comp.visualDiffPercent;
  const pctLabel = pct != null ? `${pct.toFixed(1)}% difference` : '';

  return `
    <div class="screenshots">
      <div class="screenshot-tabs">
        <button class="stab active" data-target="slider-${comp.path.replace(/\W/g, '_')}">A ↔ B</button>
        ${diff ? `<button class="stab" data-target="diff-${comp.path.replace(/\W/g, '_')}">Diff ${pctLabel ? `<span class="pct">${pctLabel}</span>` : ''}</button>` : ''}
      </div>

      <div class="sview active" id="slider-${comp.path.replace(/\W/g, '_')}">
        <div class="compare-slider" id="cs-${comp.path.replace(/\W/g, '_')}">
          <img class="cs-img-a" src="${b64png(a)}" alt="Site A" loading="lazy">
          <div class="cs-b-clip">
            <img class="cs-img-b" src="${b64png(b)}" alt="Site B" loading="lazy">
          </div>
          <div class="cs-handle"></div>
          <input class="cs-range" type="range" min="0" max="100" value="50"
            oninput="updateSlider(this,'cs-${comp.path.replace(/\W/g, '_')}')" aria-label="Comparison">
        </div>
        <div class="cs-labels">
          <span>Site A</span>
          <span>Site B</span>
        </div>
      </div>

      ${diff ? `
      <div class="sview" id="diff-${comp.path.replace(/\W/g, '_')}">
        <img class="diff-img" src="${b64png(diff)}" alt="Visual diff" loading="lazy">
      </div>` : ''}
    </div>`;
}

function maxSeverity(comp: PageComparison): Severity | 'none' {
  if (comp.status === 'only_in_a' || comp.status === 'only_in_b') return 'critical';
  if (comp.differences.some((d) => d.severity === 'critical')) return 'critical';
  if (comp.differences.some((d) => d.severity === 'warning')) return 'warning';
  if (comp.differences.length > 0) return 'info';
  return 'none';
}

function renderPage(comp: PageComparison, idx: number): string {
  const sev = maxSeverity(comp);
  const id = `p${idx}`;

  const statusLabel =
    comp.status === 'only_in_a' ? 'Missing in B' :
    comp.status === 'only_in_b' ? 'New in B' :
    comp.status === 'identical' ? 'Identical' : 'Changed';

  const urlLine = comp.urlA || comp.urlB
    ? `<div class="page-urls">
        ${comp.urlA ? `<a href="${esc(comp.urlA)}" target="_blank" rel="noopener">A: ${esc(comp.urlA)}</a>` : ''}
        ${comp.urlB ? `<a href="${esc(comp.urlB)}" target="_blank" rel="noopener">B: ${esc(comp.urlB)}</a>` : ''}
       </div>`
    : '';

  const diffCount = comp.differences.length;
  const visualPct =
    typeof comp.visualDiffPercent === 'number'
      ? comp.visualDiffPercent.toFixed(comp.visualDiffPercent < 1 ? 2 : 1)
      : null;
  // Auto-expand pages whose only signal is visual (text identical, screenshots
  // attached). Those exist solely so the user can scan the side-by-side images.
  const autoOpen = comp.status === 'identical' && !!comp.screenshots;

  return `
  <article class="page-card ${sev}${autoOpen ? ' open' : ''}" data-sev="${sev}" id="${id}">
    <header class="page-head" onclick="toggleCard('${id}')">
      <div class="page-path">
        <span class="page-chevron">▶</span>
        <code>${esc(comp.path)}</code>
      </div>
      <div class="page-meta">
        ${visualPct !== null ? `<span class="visual-pct" title="Visual pixel difference">visual ${visualPct}%</span>` : ''}
        ${diffCount > 0 ? `<span class="diff-count">${diffCount} diff${diffCount > 1 ? 's' : ''}</span>` : ''}
        <span class="badge ${sev}">${statusLabel}</span>
      </div>
    </header>
    <div class="page-body"${autoOpen ? '' : ' hidden'}>
      ${urlLine}
      <div class="diffs">
        ${comp.differences.map(renderDiff).join('')}
      </div>
      ${renderScreenshots(comp)}
    </div>
  </article>`;
}

function countSev(comparisons: PageComparison[], s: Severity): number {
  return comparisons.filter((c) => maxSeverity(c) === s).length;
}

export function generateHtmlReport(report: ComparisonReport): string {
  // Pages with screenshots are always rendered as cards (so the user can see
  // the visual comparison) even if text content was identical. Pages without
  // any visual data and with no text changes go into the compact list.
  const changed = report.comparisons.filter(
    (c) => c.status !== 'identical' || !!c.screenshots,
  );
  const identical = report.comparisons.filter(
    (c) => c.status === 'identical' && !c.screenshots,
  );

  const nCrit = countSev(report.comparisons, 'critical');
  const nWarn = countSev(report.comparisons, 'warning');
  const nInfo = countSev(report.comparisons, 'info');
  const nOk = identical.length;

  const ts = report.timestamp instanceof Date
    ? report.timestamp
    : new Date(report.timestamp);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>drift — ${esc(report.siteA)} vs ${esc(report.siteB)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f0f2f5;--card:#fff;--border:#e2e6ea;--text:#1a1d23;--muted:#6b7280;
  --crit:#dc3545;--crit-bg:#fff5f5;--crit-border:#ffc1c1;
  --warn:#e07800;--warn-bg:#fffbf0;--warn-border:#ffd580;
  --info:#0068d6;--info-bg:#f0f6ff;--info-border:#b3d1ff;
  --ok:#1a7a45;--ok-bg:#f0faf4;--ok-border:#a8e6be;
  --none-bg:#f9fafb;
  --radius:10px;--shadow:0 1px 3px rgba(0,0,0,.08),0 4px 12px rgba(0,0,0,.04);
}
body{font:15px/1.6 system-ui,sans-serif;background:var(--bg);color:var(--text);padding:0 0 60px}

/* Header */
.report-header{background:#1a1d23;color:#fff;padding:28px 32px 24px;border-bottom:3px solid #2d3142}
.report-title{font-size:22px;font-weight:700;letter-spacing:-.3px;margin-bottom:8px}
.report-title span{color:#64b5f6;font-weight:400;font-size:14px;margin-left:8px}
.report-sites{display:flex;gap:24px;flex-wrap:wrap;margin:10px 0 20px;font-size:13px;color:#9ea8b8}
.report-sites a{color:#81c9ff;text-decoration:none}
.report-sites a:hover{text-decoration:underline}
.report-sites span{color:#5a6478}

/* Stat bar */
.stat-bar{display:flex;gap:12px;flex-wrap:wrap}
.stat{display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:20px;font-size:13px;font-weight:600;cursor:pointer;border:2px solid transparent;transition:all .15s}
.stat.active{border-color:currentColor}
.stat-crit{background:rgba(220,53,69,.15);color:#ff8a94}
.stat-warn{background:rgba(224,120,0,.15);color:#ffb74d}
.stat-info{background:rgba(0,104,214,.15);color:#74b3ff}
.stat-ok{background:rgba(26,122,69,.15);color:#6fcf97}
.stat-all{background:rgba(255,255,255,.08);color:#cdd5df}

/* Toolbar */
.toolbar{display:flex;align-items:center;gap:10px;padding:16px 32px;background:#fff;border-bottom:1px solid var(--border);flex-wrap:wrap;position:sticky;top:0;z-index:10;box-shadow:var(--shadow)}
.filter-btn{padding:5px 12px;border:1.5px solid var(--border);background:#fff;border-radius:6px;font-size:13px;cursor:pointer;transition:all .15s;color:var(--muted)}
.filter-btn:hover{border-color:#aaa;color:var(--text)}
.filter-btn.active{border-color:#1a1d23;background:#1a1d23;color:#fff}
.toolbar-right{margin-left:auto;font-size:12px;color:var(--muted)}

/* Main */
.main{max-width:1100px;margin:24px auto;padding:0 24px;display:flex;flex-direction:column;gap:8px}

/* Page card */
.page-card{background:var(--card);border:1.5px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;transition:border-color .15s}
.page-card.critical{border-left:4px solid var(--crit)}
.page-card.warning{border-left:4px solid var(--warn)}
.page-card.info{border-left:4px solid var(--info)}
.page-card.none{border-left:4px solid var(--ok)}

.page-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;cursor:pointer;user-select:none;gap:12px}
.page-head:hover{background:#f8f9fb}
.page-path{display:flex;align-items:center;gap:8px;min-width:0}
.page-chevron{font-size:10px;color:var(--muted);transition:transform .2s;flex-shrink:0}
.page-card.open .page-chevron{transform:rotate(90deg)}
.page-path code{font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.page-meta{display:flex;align-items:center;gap:8px;flex-shrink:0}
.diff-count{font-size:12px;color:var(--muted);background:#f0f2f5;padding:2px 8px;border-radius:10px}
.visual-pct{font-size:12px;color:var(--info);background:var(--info-bg);border:1px solid var(--info-border);padding:2px 8px;border-radius:10px;font-variant-numeric:tabular-nums}

/* Badges */
.badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:.4px}
.badge.critical{background:var(--crit-bg);color:var(--crit);border:1px solid var(--crit-border)}
.badge.warning{background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn-border)}
.badge.info{background:var(--info-bg);color:var(--info);border:1px solid var(--info-border)}
.badge.none{background:var(--ok-bg);color:var(--ok);border:1px solid var(--ok-border)}

/* Page body */
.page-body{padding:0 16px 16px;border-top:1px solid var(--border)}
.page-urls{display:flex;gap:16px;flex-wrap:wrap;padding:10px 0;font-size:12px}
.page-urls a{color:var(--info);text-decoration:none}
.page-urls a:hover{text-decoration:underline}

/* Diffs */
.diffs{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.diff-item{border-radius:7px;overflow:hidden;border:1px solid var(--border)}
.diff-item.critical{border-color:var(--crit-border);background:var(--crit-bg)}
.diff-item.warning{border-color:var(--warn-border);background:var(--warn-bg)}
.diff-item.info{border-color:var(--info-border);background:var(--info-bg)}

.diff-header{display:flex;align-items:baseline;gap:8px;padding:8px 12px;flex-wrap:wrap}
.diff-field{font-size:12px;font-family:monospace;font-weight:600;color:var(--text)}
.diff-desc{font-size:13px;color:var(--text)}
.diff-before,.diff-after{padding:4px 12px 8px;font-size:12px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.diff-label{font-size:10px;text-transform:uppercase;font-weight:700;letter-spacing:.5px;color:var(--muted);flex-shrink:0;width:46px}
.diff-before code{color:#888;text-decoration:line-through;word-break:break-all;font-size:12px}
.diff-after code{color:var(--text);word-break:break-all;white-space:pre-wrap;font-size:12px}

/* Screenshots */
.screenshots{margin-top:16px;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.screenshot-tabs{display:flex;border-bottom:1px solid var(--border);background:#f8f9fb}
.stab{padding:8px 16px;font-size:13px;border:none;background:none;cursor:pointer;color:var(--muted);border-right:1px solid var(--border);font-weight:500;transition:all .15s}
.stab:hover{background:#f0f2f5;color:var(--text)}
.stab.active{background:#fff;color:var(--text);font-weight:600}
.pct{font-size:11px;color:var(--crit);background:var(--crit-bg);padding:1px 5px;border-radius:8px;margin-left:4px}

.sview{display:none;padding:12px}
.sview.active{display:block}

/* Slider */
.compare-slider{position:relative;display:inline-flex;max-width:100%;overflow:hidden;border-radius:6px;cursor:col-resize;user-select:none}
.cs-img-a{display:block;max-width:100%;height:auto}
.cs-b-clip{position:absolute;inset:0;clip-path:inset(0 50% 0 0)}
.cs-img-b{display:block;max-width:100%;height:auto}
.cs-handle{position:absolute;top:0;bottom:0;width:3px;background:#fff;box-shadow:0 0 6px rgba(0,0,0,.4);left:50%;transform:translateX(-50%);pointer-events:none}
.cs-handle::before,.cs-handle::after{content:'';position:absolute;left:50%;transform:translateX(-50%);width:28px;height:28px;background:#fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center}
.cs-handle::before{top:calc(50% - 18px)}
.cs-handle::after{top:calc(50% + 4px);content:'⟺';width:auto;height:auto;font-size:14px;background:none;box-shadow:none;color:#444;top:calc(50%);transform:translate(-50%,-50%)}
.cs-range{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:col-resize;margin:0}
.cs-labels{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:6px;padding:0 4px}
.diff-img{display:block;max-width:100%;border-radius:6px}

/* Identical section */
.identical-section{max-width:1100px;margin:16px auto 0;padding:0 24px}
.identical-toggle{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--card);border:1.5px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);cursor:pointer;font-size:13px;color:var(--muted);font-weight:500}
.identical-toggle:hover{color:var(--text)}
.identical-list{display:none;background:var(--card);border:1.5px solid var(--border);border-top:none;border-radius:0 0 var(--radius) var(--radius);padding:8px 12px;display:none;flex-wrap:wrap;gap:6px}
.identical-list.open{display:flex}
.identical-path{font-size:12px;font-family:monospace;padding:3px 8px;background:var(--ok-bg);color:var(--ok);border-radius:5px;border:1px solid var(--ok-border)}

/* Hidden */
[hidden]{display:none!important}
.page-card.filtered{display:none}
</style>
</head>
<body>

<header class="report-header">
  <div class="report-title">
    drift
    <span>${esc(ts.toLocaleString('en-GB'))}</span>
  </div>
  <div class="report-sites">
    <span>A:</span><a href="${esc(report.siteA)}" target="_blank">${esc(report.siteA)}</a>
    <span>B:</span><a href="${esc(report.siteB)}" target="_blank">${esc(report.siteB)}</a>
  </div>
  <div class="stat-bar">
    <div class="stat stat-all active" onclick="filterBy('all',this)">${report.comparisons.length} pages total</div>
    ${nCrit > 0 ? `<div class="stat stat-crit" onclick="filterBy('critical',this)">✖ ${nCrit} Critical</div>` : ''}
    ${nWarn > 0 ? `<div class="stat stat-warn" onclick="filterBy('warning',this)">⚠ ${nWarn} Warning</div>` : ''}
    ${nInfo > 0 ? `<div class="stat stat-info" onclick="filterBy('info',this)">· ${nInfo} Info</div>` : ''}
    ${nOk > 0 ? `<div class="stat stat-ok" onclick="filterBy('none',this)">✔ ${nOk} Identical</div>` : ''}
  </div>
</header>

<div class="toolbar">
  <button class="filter-btn active" onclick="filterBy('all',this)">All</button>
  <button class="filter-btn" onclick="filterBy('critical',this)">Critical only</button>
  <button class="filter-btn" onclick="filterBy('warning',this)">Warnings</button>
  <button class="filter-btn" onclick="filterBy('changed',this)">All changes</button>
  <span class="toolbar-right" id="visible-count">${changed.length} changes</span>
</div>

<main class="main">
${changed.map((c, i) => renderPage(c, i)).join('\n')}
</main>

${identical.length > 0 ? `
<div class="identical-section">
  <div class="identical-toggle" onclick="toggleIdentical(this)">
    ▶ ${nOk} identical pages
  </div>
  <div class="identical-list" id="identical-list">
    ${identical.map((c) => `<span class="identical-path">${esc(c.path)}</span>`).join('')}
  </div>
</div>` : ''}

<script>
function toggleCard(id) {
  const card = document.getElementById(id);
  const body = card.querySelector('.page-body');
  const open = !body.hidden;
  body.hidden = open;
  card.classList.toggle('open', !open);
}

function updateSlider(input, csId) {
  const cs = document.getElementById(csId);
  if (!cs) return;
  const v = input.value;
  cs.querySelector('.cs-b-clip').style.clipPath = 'inset(0 ' + (100 - v) + '% 0 0)';
  cs.querySelector('.cs-handle').style.left = v + '%';
}

function filterBy(sev, btn) {
  document.querySelectorAll('.filter-btn, .stat').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  // sync both toolbars
  document.querySelectorAll('.filter-btn, .stat').forEach(b => {
    const matches =
      (sev === 'all' && (b.textContent.includes('All') || b.textContent.includes('total'))) ||
      (sev === 'critical' && b.textContent.includes('Critical')) ||
      (sev === 'warning' && b.textContent.includes('Warning')) ||
      (sev === 'none' && b.textContent.includes('Identical')) ||
      (sev === 'changed' && b.textContent.includes('changes'));
    if (matches) b.classList.add('active');
  });
  let visible = 0;
  document.querySelectorAll('.page-card').forEach(card => {
    const cardSev = card.dataset.sev;
    let show = false;
    if (sev === 'all') show = true;
    else if (sev === 'changed') show = cardSev !== 'none';
    else show = cardSev === sev;
    card.classList.toggle('filtered', !show);
    if (show) visible++;
  });
  document.getElementById('visible-count').textContent = visible + ' pages';
}

// Screenshot tab switching
document.addEventListener('click', function(e) {
  const btn = e.target.closest('.stab');
  if (!btn) return;
  const screenshots = btn.closest('.screenshots');
  screenshots.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
  screenshots.querySelectorAll('.sview').forEach(v => v.classList.remove('active'));
  btn.classList.add('active');
  const target = document.getElementById(btn.dataset.target);
  if (target) target.classList.add('active');
});

function toggleIdentical(btn) {
  const list = document.getElementById('identical-list');
  const open = list.classList.toggle('open');
  btn.querySelector('svg,span,div') || (btn.firstChild.textContent = (open ? '▼' : '▶') + btn.firstChild.textContent.slice(1));
  btn.childNodes[0].textContent = (open ? '▼' : '▶') + btn.childNodes[0].textContent.slice(1);
}

// Auto-open first critical card
const firstCrit = document.querySelector('.page-card.critical');
if (firstCrit) toggleCard(firstCrit.id);
</script>
</body>
</html>`;
}
