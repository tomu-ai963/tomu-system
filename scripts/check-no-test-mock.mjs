#!/usr/bin/env node
// =============================================================================
// check-no-test-mock.mjs
// -----------------------------------------------------------------------------
// デプロイ／コミット前ガード。本番バンドルにテスト用の認証バイパス
// （LOCAL TEST MOCK / TomuAuth 差し替え等）が混入していないかを検査する。
//
//   使い方:  node scripts/check-no-test-mock.mjs
//   終了コード: 0 = クリーン / 1 = 混入検出（デプロイを中断すべき）
//
// 検出したら該当ファイル・行を表示して exit 1。CIやdeployスクリプトから呼ぶ。
// 意図的に許可したい箇所には行末に `mock-allow` を付ける（原則使わない）。
// =============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SCAN_DIRS = ['apps', 'common'];
const EXTS = new Set(['.html', '.js', '.mjs']);

// 本番に絶対に出したくないマーカー
const PATTERNS = [
  { re: /LOCAL\s*TEST\s*MOCK/i,               label: 'LOCAL TEST MOCK ブロック' },
  { re: /\[LOCAL\s*MOCK\]/i,                  label: 'LOCAL MOCK ログ出力' },
  { re: /window\.TomuAuth\s*=\s*\{/,          label: 'TomuAuth のクライアント差し替え（認証バイパス）' },
];

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      walk(p, out);
    } else if (EXTS.has(extname(name))) {
      out.push(p);
    }
  }
}

const files = [];
for (const d of SCAN_DIRS) walk(join(ROOT, d), files);

const hits = [];
for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/mock-allow/.test(line)) return; // 明示的許可
    for (const { re, label } of PATTERNS) {
      if (re.test(line)) {
        hits.push({ file: relative(ROOT, file), line: i + 1, label, text: line.trim().slice(0, 100) });
        break;
      }
    }
  });
}

if (hits.length) {
  console.error('\n\x1b[31m✗ テスト用モック／認証バイパスが本番対象に混入しています:\x1b[0m');
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  [${h.label}]`);
    console.error(`      ${h.text}`);
  }
  console.error(`\n  合計 ${hits.length} 件。デプロイ前に除去してください。`);
  console.error('  （意図的な例外のみ行末に mock-allow を付与）\n');
  process.exit(1);
}

console.log(`✓ テストモック検査 OK — ${files.length} ファイル走査、混入なし`);
