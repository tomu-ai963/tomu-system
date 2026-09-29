// 士業アドバイザーのモデル比較スクリプト
//
// 本番と同じ systemプロンプト・max_tokens（tomu_system_worker.js から読み込み）で、
// 各質問を4つの設定に投げ、回答をブラインド（A〜D）で並べた Markdown を出力する。
//
// 使い方:
//   cd scripts/advisor-compare && npm install
//   node compare.mjs --dry-run          # API を呼ばずに計画と最悪コストだけ表示
//   node compare.mjs                    # 実行（ANTHROPIC_API_KEY を環境変数で渡す）
//   node compare.mjs --budget 1.5       # 予算上限を変更（既定 $1.80）
//
// 安全策:
//   - 各呼び出しの前に「使用済み + その呼び出しの最悪コスト」が予算を超えるなら中止する
//   - 自動リトライなし（maxRetries: 0）。失敗は結果に記録して次へ進む
//   - 本番と条件を揃えるため refusal 時のフォールバックは付けない（refusal は結果に記録）

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(here, "..", "..", "tomu_system_worker.js");
let OUT_DIR = path.join(here, "results");

const CONFIGS = [
  // 現行の本番と同一（thinking・effort 指定なし）
  { id: "opus-4-8", model: "claude-opus-4-8", extra: {} },
  { id: "sonnet-5-5-low", model: "claude-sonnet-5-5", extra: { output_config: { effort: "low" } } },
  { id: "sonnet-5-5-medium", model: "claude-sonnet-5-5", extra: { output_config: { effort: "medium" } } },
  { id: "opus-5-5-low", model: "claude-opus-5-5", extra: { output_config: { effort: "low" } } },
];

// USD / 100万トークン（入力, 出力）。キャッシュ書き込みは入力の1.25倍、読み込みは0.1倍
const PRICES = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

// 事前見積もり用。日本語は1文字あたり概ね1トークン前後なので、1.5倍で安全側に見積もる
const TOKENS_PER_CHAR_UPPER = 1.5;

function parseArgs(argv) {
  const args = { dryRun: false, budget: 1.8, configs: null, maxGeneral: null, maxPro: null, out: "results" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--budget") args.budget = Number(argv[++i]);
    else if (argv[i] === "--configs") args.configs = argv[++i].split(",");
    else if (argv[i] === "--max-general") args.maxGeneral = Number(argv[++i]);
    else if (argv[i] === "--max-pro") args.maxPro = Number(argv[++i]);
    else if (argv[i] === "--out") args.out = argv[++i];
    else throw new Error(`不明なオプション: ${argv[i]}`);
  }
  if (!(args.budget > 0)) throw new Error("--budget には正の数を指定してください");
  if (args.configs) {
    const unknown = args.configs.filter((id) => !CONFIGS.some((c) => c.id === id));
    if (unknown.length) throw new Error(`不明な設定: ${unknown.join(", ")}（${CONFIGS.map((c) => c.id).join(", ")}）`);
  }
  return args;
}

// 本番の systemプロンプトと max_tokens を Worker のソースから読む（二重管理しない）
function loadAdvisorDefs() {
  const src = fs.readFileSync(WORKER_PATH, "utf8");
  const apps = src.match(/var ADVISOR_APPS = (\{[\s\S]*?\n\});/);
  const maxTokens = src.match(/var ADVISOR_MAX_TOKENS = (\{[^}]*\});/);
  if (!apps || !maxTokens) throw new Error("tomu_system_worker.js から ADVISOR_APPS / ADVISOR_MAX_TOKENS を読めませんでした");
  return {
    apps: new Function(`return (${apps[1]});`)(),
    maxTokens: new Function(`return (${maxTokens[1]});`)(),
  };
}

function costOf(model, usage) {
  const p = PRICES[model];
  const input = (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0) * 1.25
    + (usage.cache_read_input_tokens || 0) * 0.1;
  return (input * p.input + (usage.output_tokens || 0) * p.output) / 1e6;
}

function worstCaseCost(model, system, question, maxTokens) {
  const inputTokens = Math.ceil((system.length + question.length) * TOKENS_PER_CHAR_UPPER);
  return costOf(model, { input_tokens: inputTokens, output_tokens: maxTokens });
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function extractText(response) {
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function writeReports(results) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "raw.json"), JSON.stringify(results, null, 2));

  const labels = ["A", "B", "C", "D"];
  let answers = "# 士業アドバイザー モデル比較（ブラインド）\n\n"
    + "各質問の回答 A〜D がどのモデルかは key.md に記載。先に answers.md だけ読んで評価してください。\n\n";
  let key = "# 対応表と実測値\n\n";
  const totals = {};

  results.questions.forEach((q, qi) => {
    answers += `---\n\n## Q${qi + 1}. [${q.advisor} / ${q.mode}]\n\n> ${q.question}\n\n`;
    key += `## Q${qi + 1}. [${q.advisor} / ${q.mode}]\n\n| ラベル | 設定 | stop_reason | 入力tok | 出力tok | 時間(秒) | コスト($) |\n|---|---|---|---|---|---|---|\n`;
    q.runs.forEach((r, ri) => {
      const label = labels[ri];
      const body = r.error ? `（エラー: ${r.error}）` : (r.text || "（テキストなし）");
      answers += `### 回答 ${label}\n\n${body}\n\n`;
      key += `| ${label} | ${r.config} | ${r.stop_reason || "-"} | ${r.usage?.input_tokens ?? "-"} | ${r.usage?.output_tokens ?? "-"} | ${r.seconds ?? "-"} | ${r.cost?.toFixed(4) ?? "-"} |\n`;
      const t = (totals[r.config] ||= { cost: 0, seconds: 0, outTokens: 0, n: 0, errors: 0, truncated: 0 });
      if (r.error) { t.errors++; return; }
      t.cost += r.cost; t.seconds += r.seconds; t.outTokens += r.usage.output_tokens; t.n++;
      if (r.stop_reason === "max_tokens") t.truncated++;
    });
    key += "\n";
  });

  key += `## 設定ごとの集計\n\n条件: max_tokens 一般 ${results.maxTokens.general} / 専門家 ${results.maxTokens.pro}\n\n| 設定 | 成功数 | エラー | 上限到達(max_tokens) | 平均出力tok | 平均時間(秒) | 合計コスト($) |\n|---|---|---|---|---|---|---|\n`;
  for (const c of CONFIGS) {
    const t = totals[c.id];
    if (!t) continue;
    const avg = (v) => (t.n ? (v / t.n).toFixed(1) : "-");
    key += `| ${c.id} | ${t.n} | ${t.errors} | ${t.truncated} | ${avg(t.outTokens)} | ${avg(t.seconds)} | ${t.cost.toFixed(4)} |\n`;
  }
  key += `\n**総コスト（実測）: $${results.spent.toFixed(4)}** / 予算 $${results.budget.toFixed(2)}${results.stoppedEarly ? "（予算到達のため途中で中止）" : ""}\n`;

  fs.writeFileSync(path.join(OUT_DIR, "answers.md"), answers);
  fs.writeFileSync(path.join(OUT_DIR, "key.md"), key);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { apps, maxTokens: prodMaxTokens } = loadAdvisorDefs();
  // 上限の上書きはこのスクリプト内だけ（本番の ADVISOR_MAX_TOKENS は変更しない）
  const maxTokens = {
    general: args.maxGeneral || prodMaxTokens.general,
    pro: args.maxPro || prodMaxTokens.pro,
  };
  const configs = args.configs ? CONFIGS.filter((c) => args.configs.includes(c.id)) : CONFIGS;
  OUT_DIR = path.join(here, args.out);
  const questions = JSON.parse(fs.readFileSync(path.join(here, "questions.json"), "utf8"));

  // 計画と最悪コスト
  let worstTotal = 0;
  for (const q of questions) {
    const system = apps[q.advisor]?.[q.mode];
    if (!system) throw new Error(`未定義のアドバイザー/モード: ${q.advisor}/${q.mode}`);
    for (const c of configs) worstTotal += worstCaseCost(c.model, system, q.question, maxTokens[q.mode]);
  }
  console.log(`質問 ${questions.length} 問 × 設定 ${configs.length} 通り（${configs.map((c) => c.id).join(", ")}） = ${questions.length * configs.length} 回`);
  console.log(`max_tokens: 一般 ${maxTokens.general} / 専門家 ${maxTokens.pro}  出力先: ${OUT_DIR}`);
  console.log(`全回答が上限まで出た場合のコスト: $${worstTotal.toFixed(3)} / 予算 $${args.budget.toFixed(2)}（実費ベースで判定）`);
  if (args.dryRun) {
    console.log("--dry-run のため API は呼びません。");
    return;
  }

  const client = new Anthropic({ maxRetries: 0 });
  const results = { startedAt: new Date().toISOString(), budget: args.budget, maxTokens, spent: 0, stoppedEarly: false, questions: [] };

  outer:
  for (const [qi, q] of questions.entries()) {
    const system = apps[q.advisor][q.mode];
    const entry = { ...q, runs: [] };
    results.questions.push(entry);

    for (const c of shuffled(configs)) {
      const worst = worstCaseCost(c.model, system, q.question, maxTokens[q.mode]);
      if (results.spent + worst > args.budget) {
        console.log(`予算上限に達するため中止（使用済み $${results.spent.toFixed(4)} + 最悪 $${worst.toFixed(4)} > $${args.budget}）`);
        results.stoppedEarly = true;
        break outer;
      }

      const started = Date.now();
      const run = { config: c.id, model: c.model };
      try {
        const response = await client.messages.create({
          model: c.model,
          max_tokens: maxTokens[q.mode],
          system,
          messages: [{ role: "user", content: q.question }],
          ...c.extra,
        });
        run.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
        run.stop_reason = response.stop_reason;
        if (response.stop_reason === "refusal") run.stop_details = response.stop_details;
        run.usage = response.usage;
        run.cost = costOf(c.model, response.usage);
        run.text = extractText(response);
        results.spent += run.cost;
      } catch (err) {
        run.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
        run.error = err instanceof Anthropic.APIError ? `${err.status ?? "network"} ${err.message}` : String(err);
      }
      entry.runs.push(run);
      console.log(`Q${qi + 1} ${c.id}: ${run.error ? "ERROR " + run.error : `${run.stop_reason} ${run.usage.output_tokens}tok ${run.seconds}s $${run.cost.toFixed(4)}`}  (累計 $${results.spent.toFixed(4)})`);
      writeReports(results); // 途中で止まっても結果が残るよう毎回書き出す
    }
  }

  results.finishedAt = new Date().toISOString();
  writeReports(results);
  console.log(`\n完了。総コスト（実測）: $${results.spent.toFixed(4)}`);
  console.log(`結果: ${path.join(OUT_DIR, "answers.md")}（ブラインド） / key.md（対応表・実測値）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
