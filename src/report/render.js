import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PALETTE = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#dc2626', '#0891b2'];

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function fmtTick(v) {
  if (Math.abs(v) >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  return `${+v.toFixed(1)}`;
}

/**
 * Self-contained SVG line chart.
 * series: [{ name, points: [[xSeconds, y], ...], color?, dash?, step? }]
 * markers: [{ x, label }] vertical lines (e.g. limit changes)
 */
export function lineChart({
  title, series, markers = [], xLabel = 'seconds since start', yLabel = '', width = 900, height = 300,
}) {
  const padL = 64; const padR = 16; const padT = 34; const padB = 42;
  const W = width - padL - padR; const H = height - padT - padB;
  let xmax = 1; let ymax = 0;
  for (const s of series) {
    for (const [x, y] of s.points) {
      if (x > xmax) xmax = x;
      if (Number.isFinite(y) && y > ymax) ymax = y;
    }
  }
  ymax = niceMax(ymax * 1.05);
  const X = (x) => padL + (x / xmax) * W;
  const Y = (y) => padT + H - (y / ymax) * H;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px;font:12px system-ui,sans-serif">`;
  out += `<text x="${padL}" y="18" font-weight="600" font-size="14">${esc(title)}</text>`;
  for (let i = 0; i <= 5; i++) {
    const yv = (ymax * i) / 5;
    const y = Y(yv);
    out += `<line x1="${padL}" x2="${padL + W}" y1="${y}" y2="${y}" stroke="#e5e7eb"/>`;
    out += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" fill="#6b7280">${fmtTick(yv)}</text>`;
  }
  const xstep = niceMax(xmax / 8);
  for (let xv = 0; xv <= xmax; xv += xstep) {
    out += `<text x="${X(xv)}" y="${padT + H + 16}" text-anchor="middle" fill="#6b7280">${Math.round(xv)}</text>`;
  }
  out += `<text x="${padL + W / 2}" y="${height - 6}" text-anchor="middle" fill="#6b7280">${esc(xLabel)}</text>`;
  if (yLabel) out += `<text x="14" y="${padT + H / 2}" transform="rotate(-90 14 ${padT + H / 2})" text-anchor="middle" fill="#6b7280">${esc(yLabel)}</text>`;
  for (const mk of markers) {
    out += `<line x1="${X(mk.x)}" x2="${X(mk.x)}" y1="${padT}" y2="${padT + H}" stroke="#9ca3af" stroke-dasharray="3 3"/>`;
    out += `<text x="${X(mk.x) + 4}" y="${padT + 12}" fill="#4b5563">${esc(mk.label)}</text>`;
  }
  series.forEach((s, si) => {
    const color = s.color || PALETTE[si % PALETTE.length];
    const pts = s.points.filter(([, y]) => Number.isFinite(y));
    if (pts.length === 0) return;
    let d = '';
    pts.forEach(([x, y], i) => {
      if (s.step && i > 0) d += `L${X(x).toFixed(1)},${Y(pts[i - 1][1]).toFixed(1)}`;
      d += `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`;
    });
    out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${s.width || 1.6}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`;
  });
  let lx = padL + 8;
  series.forEach((s, si) => {
    const color = s.color || PALETTE[si % PALETTE.length];
    out += `<line x1="${lx}" x2="${lx + 18}" y1="${padT + 6}" y2="${padT + 6}" stroke="${color}" stroke-width="2"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`;
    out += `<text x="${lx + 22}" y="${padT + 10}" fill="#111827">${esc(s.name)}</text>`;
    lx += 30 + s.name.length * 6.5;
  });
  out += '</svg>';
  return out;
}

export function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.map((c) => String(c ?? '')).join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

export function environment() {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: `${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
    cpu: cpus[0]?.model?.trim(),
    logical_cpus: cpus.length,
    memory_gb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
  };
}

/** Writes report.md, report.json and report.html (markdown text + inline SVG charts). */
export function writeReport(dir, { title, markdown, charts = [], json }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(json, null, 2));
  for (const [i, c] of charts.entries()) fs.writeFileSync(path.join(dir, `chart-${i + 1}.svg`), c.svg);
  const md = `${markdown}\n\n${charts.map((c, i) => `![${c.title}](chart-${i + 1}.svg)`).join('\n\n')}\n`;
  fs.writeFileSync(path.join(dir, 'report.md'), md);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#111827;background:#fff}pre{white-space:pre-wrap;background:#f9fafb;padding:12px;border-radius:6px}</style></head>
<body><pre>${esc(markdown)}</pre>${charts.map((c) => `<div>${c.svg}</div>`).join('\n')}</body></html>`;
  fs.writeFileSync(path.join(dir, 'report.html'), html);
}
