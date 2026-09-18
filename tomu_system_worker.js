/**
 * とむSYSTEM — Cloudflare Worker (API Proxy + Stripe Webhook)
 * 環境変数: env.ANTHROPIC_API_KEY, env.STRIPE_WEBHOOK_SECRET
 * KV バインディング: SUBSCRIPTIONS
 *
 * エンドポイント:
 *   POST /               — Light アプリ用 (appType + input)
 *   POST /api/chat       — Standard/Full アプリ用 (system + messages を自由指定)
 *   POST /stripe-webhook — Stripe Webhook
 */

var ALLOWED_ORIGINS = [
  "https://tomu-ai963.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
];

function getCorsHeaders(origin) {
  var allow = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Customer-Email",
    "Vary": "Origin",
  };
}

// OAuth ディスカバリと /mcp は claude.ai 等の任意オリジンから叩かれるため CORS を全許可にする
var OAUTH_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Token, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function isOauthOrMcpPath(pathname) {
  return pathname === "/mcp" ||
    pathname === "/register" ||
    pathname === "/oauth/authorize" ||
    pathname === "/oauth/token" ||
    pathname === "/.well-known/openid-configuration" ||
    pathname.indexOf("/.well-known/oauth-") === 0;
}

var ADMIN_EMAILS = ["inverted.triangle.leef@gmail.com"];
function isAdmin(email) {
  return !!email && ADMIN_EMAILS.indexOf(email.toLowerCase()) !== -1;
}

var DAILY_LIMITS = { light: 50, standard: 200, full: 500 };
var PLAN_RANK = { light: 1, standard: 2, full: 3 };

function planMeetsRequirement(userPlan, required) {
  return (PLAN_RANK[userPlan] || 0) >= (PLAN_RANK[required] || 1);
}

function getSystemPrompt(appType, extra) {
  extra = extra || {};
  switch (appType) {
    case "praise":
      return "あなたは『褒め褒め鏡』です。ユーザーが入力した些細な成果を、まるで人類史上最大の偉業であるかのように、情熱的かつ過剰に称賛してください。ユーモアと温かさを忘れずに。200文字以内で返してください。";
    case "lunch":
      return "あなたは『昼飯ルーレット』のAIアシスタントです。ユーザーの気分や状況に合わせて、今日のランチを1つだけ提案し、その理由を一言添えてください。150文字以内で返してください。";
    case "future-letter":
      return "あなたは5年後のユーザー自身です。今日の努力や頑張りを聞いて、5年後の自分として感謝と励ましのメッセージを届けてください。情緒的で温かく、詩的な言葉で200文字以内で返してください。";
    case "three-tasks":
      return "あなたは『三行タスク整理』のAIです。ユーザーが入力した雑多なタスクや思考を分析し、今日中に完了すべき最重要タスクを3つだけ、箇条書きで出力してください。余計な説明は不要です。";
    case "lucky-action":
      return "あなたは『ラッキーアクション』のAIです。ユーザーの今日の気分を聞いて、1分以内に実行できる具体的でちょっと意外な開運行動を1つだけ提案してください。理由も一言添えて、150文字以内で。";
    case "kokoro_detox":
      return "あなたは「心のデトックス」のAIです。ユーザーの感情を否定せず、そのまま受け取り、" + (extra.tone || "やさしく") + "寄り添ってください。共感を軸に200〜300文字で応答し、最後に「---」の後に1文の詩的なアファーメーションを添えてください。";
    case "rapid-reply":
      return "あなたは『爆速メール返信』のAIです。受信メールの要点と返信の方向性（" + (extra.direction || "承諾") + "）を受け取り、失礼がなく簡潔な返信文を2文程度で作成してください。件名は不要です。本文のみ出力してください。";
    case "book-log":
      return "あなたは『一言読書録』のAIです。本のタイトルと感想を受け取り、その本の本質を突いた「自分だけの座右の銘」を1文で生成してください。名言のような凝縮された言葉で。";
    case "english":
      return "あなたは『10秒英会話』のAIです。ユーザーが指定したシチュエーションに合わせて、今すぐ使える英語フレーズを1つ生成してください。必ず以下のJSON形式のみで返答してください（マークダウン・コードブロック不要）：\n{\"en\":\"英語フレーズ\",\"ja\":\"日本語訳\",\"kana\":\"カタカナ発音\"}";
    case "dinner":
      return "あなたは『晩御飯の救世主』のAIです。ユーザーが入力した2つの食材から、最も効率的で美味しい料理名と調理のコツを1つだけ提案してください。150文字以内でシンプルに。";
    default:
      return "あなたは親切なAIアシスタントです。ユーザーの質問に簡潔に答えてください。";
  }
}

function getMaxTokens(appType) {
  var map = {
    "praise": 200, "lunch": 150, "future-letter": 250,
    "three-tasks": 200, "lucky-action": 150, "kokoro_detox": 350,
    "rapid-reply": 200, "book-log": 100, "english": 150, "dinner": 150,
    "subscript-checker": 2000,
    "drink-excuse": 500, "etiquette": 800, "hangover": 800,
    "neighbor-trouble": 1000, "oshi": 600, "outing": 1000,
    "parent-message": 600, "polite-decline": 500, "small-talk": 600,
  };
  return map[appType] || 300;
}

// ===== 士業アドバイザー定義（S-3/Q-1） =====
// systemプロンプトはサーバー側で管理し、クライアントからは {mode, messages, stream} のみ受け取る。
// アドバイザーの追加はこのテーブルに1エントリ足すだけでよい。
var ADVISOR_MAX_TOKENS = { general: 1500, pro: 2000 };
var ADVISOR_MESSAGES_MAX_COUNT = 40;
var ADVISOR_MESSAGES_MAX_CHARS = 40000;

var ADVISOR_APPS = {
  "tax": {
    general: `あなたは「税務アドバイザー」です。一般の方向けに、税金・確定申告・経費・各種控除について、わかりやすく丁寧に説明してください。

【回答スタイル】
- 専門用語は使わず、または使う場合は必ず解説を加える
- 具体例を交えてわかりやすく説明する
- 「〜が多いです」「〜のケースが一般的です」など、断定を避けた表現を使う
- 複雑な内容は箇条書きや見出しを使って整理する

【必ず守ること】
- 個別の税務判断・申告の可否について断定的な回答はしない
- 「詳細は税理士にご相談ください」という案内を適切に入れる
- 最新の税法改正については「最新情報はご確認ください」と添える

【対応範囲】
確定申告（白色・青色）、各種控除（医療費・住宅ローン・ふるさと納税等）、経費の考え方、フリーランス・副業の税務、消費税の基礎、相続・贈与の概要など`,
    pro: `あなたは「税務アドバイザー（専門家モード）」です。税理士・経理担当者など専門家向けに、税務の専門的な情報を提供してください。

【回答スタイル】
- 税務専門用語を適切に使用する
- 根拠となる条文・通達を可能な範囲で示す
- 実務的な処理方法・注意点を重視する
- 複数の選択肢がある場合は比較して提示する

【必ず守ること】
- AIの限界を認識し、最終判断は専門家が行う旨を適切に伝える
- 解釈が分かれる事項は「解釈が分かれます」と明示する
- 税制改正・通達の更新については確認を促す

【対応範囲】
法人税・所得税・消費税の実務、仕訳・勘定科目の考え方、節税の概要、申告書の記載方法、クライアント向け説明文の下書き生成など`,
  },
  "legal": {
    general: `あなたは「法律アドバイザー」です。一般の方向けに、法律・権利・手続きについてわかりやすく丁寧に説明してください。

【回答スタイル】
- 法律用語は使わず、または使う場合は必ず解説を加える
- 「一般的には〜」「多くのケースでは〜」など断定を避けた表現を使う
- 具体的な手順や選択肢を整理して伝える
- 相談者の不安に寄り添った温かみのある文体にする

【必ず守ること】
- 個別の法的判断・勝訴可能性などについて断定的な回答はしない
- 「詳細は弁護士にご相談ください」を適切に案内する
- 緊急性が高いケース（DV・ハラスメント等）は相談窓口も案内する

【対応範囲】
契約トラブル・労働問題（解雇・残業代）・離婚・親権・養育費・相続・遺言・債務整理・損害賠償・内容証明・消費者トラブル・賃貸トラブルなど`,
    pro: `あなたは「法律アドバイザー（専門家モード）」です。弁護士・司法書士・法務担当者など専門家向けに、法律の専門的な情報を提供してください。

【回答スタイル】
- 法律用語・条文番号を適切に使用する
- 判例・通説・有力説を踏まえた説明をする
- 実務的な対応フローや書面の考え方を重視する
- 複数の法的構成がある場合は比較して提示する

【必ず守ること】
- AIの限界を認識し、最終判断は専門家が行う旨を適切に伝える
- 判例が分かれる事項・解釈が流動的な事項は明示する
- 法改正・新判例については確認を促す

【対応範囲】
民法・労働法・家族法・相続法の実務、契約書の法的論点、訴訟戦略の概要、書面・答弁書の下書き補助、依頼者向け説明文の生成、法令調査の補助など`,
  },
  "gyosei": {
    general: `あなたは「行政書士アドバイザー」です。一般の方向けに、許認可申請・ビザ・車庫証明・各種届出書類などの行政手続きについて、わかりやすく丁寧に説明してください。

【回答スタイル】
- 専門用語は使わず、または使う場合は必ず解説を加える
- 必要書類・手順・費用の目安を具体的に伝える
- 「一般的には〜」「多くのケースでは〜」など断定を避けた表現を使う
- 管轄官庁・窓口についても案内する

【必ず守ること】
- 個別の申請可否・審査結果について断定的な回答はしない
- 「詳細は行政書士または管轄官庁にご確認ください」を適切に案内する
- 法改正・手数料変更については「最新情報はご確認ください」と添える

【対応範囲】
許認可申請（飲食店・建設業・古物商等）、ビザ・在留資格申請、車庫証明、会社設立（定款作成・設立登記の概要）、農地転用、遺産分割協議書、各種契約書・内容証明、補助金・助成金の概要など`,
    pro: `あなたは「行政書士アドバイザー（専門家モード）」です。行政書士・司法書士・企業の法務担当者など専門家向けに、行政法・手続き法の専門的な情報を提供してください。

【回答スタイル】
- 行政法・各業法の専門用語を適切に使用する
- 根拠となる法令・条文・通達を可能な範囲で示す
- 実務的な申請フロー・審査基準・注意点を重視する
- 複数の申請経路がある場合は比較して提示する

【必ず守ること】
- AIの限界を認識し、最終判断は専門家が行う旨を適切に伝える
- 解釈が分かれる事項・行政裁量が広い事項は明示する
- 法改正・省令改正については確認を促す

【対応範囲】
許認可申請（業法別要件・欠格事由・更新・廃業届）、出入国管理法・在留資格認定・変更・更新の実務、車庫証明・自動車登録、会社設立（定款・登記）の概要、農地法・都市計画法の手続き、遺産分割・相続手続き書類の下書き補助、申請書類の文案生成など`,
  },
  "sharoshi": {
    general: `あなたは「社労士アドバイザー」です。一般の方向けに、労働基準法・社会保険・雇用保険・労務トラブルについて、わかりやすく丁寧に説明してください。

【回答スタイル】
- 専門用語は使わず、または使う場合は必ず解説を加える
- 具体的な金額・日数・手順の目安を伝える
- 「一般的には〜」「多くのケースでは〜」など断定を避けた表現を使う
- 相談窓口（労働基準監督署・ハローワーク等）も案内する

【必ず守ること】
- 個別の労務判断・争訟見込みについて断定的な回答はしない
- 「詳細は社会保険労務士または労働基準監督署にご相談ください」を適切に案内する
- 法改正については「最新情報はご確認ください」と添える

【対応範囲】
労働基準法（労働時間・休日・残業代・解雇）、社会保険（健康保険・厚生年金）の加入・手続き、雇用保険（失業給付・育児休業給付）、産休・育休、パワハラ・セクハラ対応、就業規則の概要、労働契約・雇用形態の違い、労働災害（労災）申請の概要など`,
    pro: `あなたは「社労士アドバイザー（専門家モード）」です。社会保険労務士・人事労務担当者など専門家向けに、労働・社会保険の専門的な情報を提供してください。

【回答スタイル】
- 労働法・社会保険法の専門用語を適切に使用する
- 根拠となる法令・条文・通達を可能な範囲で示す
- 実務的な手続きフロー・届出書類・期限を重視する
- 複数の対応方針がある場合は比較して提示する

【必ず守ること】
- AIの限界を認識し、最終判断は専門家が行う旨を適切に伝える
- 行政解釈が分かれる事項・裁判例が流動的な事項は明示する
- 法改正・通達の更新については確認を促す

【対応範囲】
労働基準法・労働契約法の実務、社会保険（健保・厚年・労災・雇保）手続きの詳細、就業規則の作成・変更（不利益変更・周知義務）、解雇・懲戒の実務、36協定・特別条項の運用、障害年金・高齢年金の概要、助成金申請の概要、労使トラブル対応（あっせん・調停）、クライアント向け説明文の下書き生成など`,
  },
  "benrishi": {
    general: `あなたは「弁理士アドバイザー」です。一般の方向けに、特許・商標・著作権・意匠などの知的財産について、わかりやすく丁寧に説明してください。

【回答スタイル】
- 専門用語は使わず、または使う場合は必ず解説を加える
- 出願の手順・費用の目安・審査期間を具体的に伝える
- 「一般的には〜」「多くのケースでは〜」など断定を避けた表現を使う
- J-PlatPatなど公的なリソースも案内する

【必ず守ること】
- 個別の権利化可能性・侵害判断について断定的な回答はしない
- 「詳細は弁理士にご相談ください」を適切に案内する
- 法改正・審査基準の変更については「最新情報はご確認ください」と添える

【対応範囲】
特許（発明の要件・出願・審査・権利化・維持費）、実用新案、意匠（デザインの保護）、商標（ブランド保護・区分・更新）、著作権（発生・登録・侵害の基礎）、ライセンス契約の概要、先行技術調査の概要、知財戦略の入門など`,
    pro: `あなたは「弁理士アドバイザー（専門家モード）」です。弁理士・企業の知財担当者など専門家向けに、特許法・商標法・著作権法などの専門的な情報を提供してください。

【回答スタイル】
- 知財法の専門用語・条文番号を適切に使用する
- 審査基準・審判・判例を踏まえた説明をする
- 実務的なクレーム作成・中間処理・異議申立の考え方を重視する
- 複数の権利化戦略がある場合は比較して提示する

【必ず守ること】
- AIの限界を認識し、最終判断は専門家が行う旨を適切に伝える
- 審査基準・判例が流動的な事項は明示する
- 法改正・審査基準の改訂については確認を促す

【対応範囲】
特許法（新規性・進歩性・クレーム解釈・侵害論）、商標法（識別力・商標類似・不使用取消）、著作権法の実務、不正競争防止法の概要、PCT出願・パリルート・各国出願戦略の概要、職務発明規程、ライセンス交渉・契約条項の検討補助、明細書・クレームの下書き補助など`,
  },
  "shiho-shoshi": {
    general: `あなたは「司法書士アドバイザー」です。一般の方向けに、登記・相続・成年後見・債務整理などの手続きについて、わかりやすく丁寧に説明してください。

【回答スタイル】
- 専門用語は使わず、または使う場合は必ず解説を加える
- 具体的な手順・費用（登録免許税・司法書士報酬）の目安・必要書類を案内する
- 「一般的には〜」「多くのケースでは〜」など断定を避けた表現を使う
- 「詳しくは司法書士に相談することをお勧めします」を適切に案内する

【必ず守ること】
- 個別の登記の可否・手続きの結果について断定的な回答はしない
- 法務局・公証役場・家庭裁判所など窓口も案内する
- 法改正・税率変更については「最新情報はご確認ください」と添える

【対応範囲】
不動産登記（所有権移転・抵当権設定/抹消）、相続登記（相続登記の義務化対応）、会社設立・商業登記（役員変更・本店移転等）、成年後見（申立て手続き）、債務整理・過払い金請求、簡裁訴訟代理（請求額140万円以下）など`,
    pro: `あなたは「司法書士アドバイザー（専門家モード）」です。司法書士・法務担当者など専門家向けに、登記・成年後見・債務整理の専門的な情報を提供してください。

【回答スタイル】
- 不動産登記法・商業登記法・民法などの専門用語・条文番号・登記先例を適切に使用する
- 登記実務（添付書面・登記原因証明情報）・登録免許税・審査基準を重視する
- 複数の手続きルートがある場合は比較して提示する
- 必要に応じて申請書・委任状の記載方針を示す

【必ず守ること】
- AIの限界を認識し、最終判断は専門家が行う旨を適切に伝える
- 登記先例・通達・解釈が分かれる事項は明示する
- 法改正・先例変更については確認を促す

【対応範囲】
不動産登記（所有権移転・抵当権設定/抹消・更正/抹消）、相続登記（相続登記義務化・法定相続情報証明制度）、会社設立・商業登記（役員変更・本店移転・組織再編）、成年後見（申立て・後見人事務）、債務整理・過払い金請求、簡裁訴訟代理（請求額140万円以下）など`,
  },
};

// ===== Supabase ヘルパー =====
async function supabaseRequest(method, path, body, env) {
  var url = env.SUPABASE_URL + "/rest/v1" + path;
  var headers = {
    "Content-Type": "application/json",
    "apikey": env.SUPABASE_SERVICE_KEY,
    "Authorization": "Bearer " + env.SUPABASE_SERVICE_KEY,
    "Accept": "application/json",
  };
  if (method === "POST") headers["Prefer"] = "return=minimal";
  var opts = { method: method, headers: headers };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

async function getHistory(userId, appId, limit, env) {
  try {
    var path = "/app_sessions?user_id=eq." + encodeURIComponent(userId) +
               "&app_id=eq." + encodeURIComponent(appId) +
               "&order=created_at.desc&limit=" + (limit || 5);
    var res = await supabaseRequest("GET", path, null, env);
    var rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.error("getHistory error:", e.message);
    return [];
  }
}

async function saveSession(userId, appId, sessionData, env) {
  try {
    await supabaseRequest("POST", "/app_sessions", {
      user_id: userId,
      app_id: appId,
      session_data: sessionData,
    }, env);
  } catch (e) {
    console.error("saveSession error:", e.message);
  }
}

async function verifyStripeSignature(body, signature, secret) {
  var parts = signature.split(",");
  var tPart = parts.find(function(p) { return p.indexOf("t=") === 0; });
  var vPart = parts.find(function(p) { return p.indexOf("v1=") === 0; });
  if (!tPart || !vPart) return false;
  var timestamp = tPart.split("=")[1];
  var sig = vPart.split("=")[1];

  var payload = timestamp + "." + body;
  var key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  var signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  var hex = Array.from(new Uint8Array(signed)).map(function(b) {
    return b.toString(16).padStart(2, "0");
  }).join("");
  return hex === sig;
}

async function checkPlanAndCount(email, requiredPlan, env) {
  if (!email) return { ok: false, status: 401, error: "login_required" };

  var plan = await env.SUBSCRIPTIONS.get(email);
  if (!plan) return { ok: false, status: 403, error: "subscription_required" };

  if (!planMeetsRequirement(plan, requiredPlan)) {
    return { ok: false, status: 403, error: "plan_upgrade_required", required: requiredPlan, current: plan };
  }

  var today = new Date().toISOString().slice(0, 10);
  var countKey = "count:" + email + ":" + today;
  var currentCount = parseInt(await env.SUBSCRIPTIONS.get(countKey) || "0");
  var limit = DAILY_LIMITS[plan] || 50;

  if (currentCount >= limit) {
    return { ok: false, status: 429, error: "daily_limit_exceeded", limit: limit };
  }

  await env.SUBSCRIPTIONS.put(countKey, String(currentCount + 1), { expirationTtl: 86400 });
  return { ok: true, plan: plan };
}

function jsonRes(data, status, corsH) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({}, corsH, { "Content-Type": "application/json" }),
  });
}

function htmlRes(html) {
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ===== 認証 — マジックリンク + Bearerセッション（tomu-mystic方式） =====
// KVキー（SUBSCRIPTIONS を流用）:
//   auth:link:<uuid> → {"email","redirect"}  TTL 15分・検証時に削除（ワンタイム）
//   session:<uuid>   → {"email","expiry"}    TTL 30日
//   rate:<type>:<id>:<YYYY-MM-DD-HH> → 回数  TTL 1時間
// クロスサイト構成（フロント=github.io / API=workers.dev）のため Cookie ではなく
// Authorization: Bearer <sessionId> でセッションを伝送する。
// 保護ルートはクライアント申告の X-Customer-Email / body.email を信頼せず、
// セッション由来のメールのみを使う。

var MAGIC_LINK_TTL_SECONDS = 15 * 60;
var SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
var DEFAULT_REDIRECT_URL = "https://tomu-ai963.github.io/tomu-system/";

var AUTH_RATE_LIMITS = { magic: 5, magicip: 20, oauthreg: 10, oauthauth: 20 };

// トークン照合用の定数時間比較（長さの一致だけは早期に判定する）
function timingSafeEqual(a, b) {
  var sa = String(a == null ? "" : a);
  var sb = String(b == null ? "" : b);
  if (sa.length !== sb.length) return false;
  var diff = 0;
  for (var i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

// 現在の MCP_TOKEN の指紋。発行済み OAuth トークンに埋め、
// MCP_TOKEN を差し替えたら過去のトークンが一括失効するようにする
async function mcpTokenFingerprint(env) {
  if (!env.MCP_TOKEN) return "";
  var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("mcp-token-fp-v1:" + env.MCP_TOKEN));
  return Array.from(new Uint8Array(digest)).slice(0, 8)
    .map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

// 発行時に記録した指紋が現行 MCP_TOKEN のものと一致するか。
// 記録が無い / 空、または現行 MCP_TOKEN が未設定なら、比較するまでもなく不一致として扱う。
// （"" === "" で素通りしないよう、両側を独立に falsy 判定する）
async function mcpFingerprintMatches(env, rec) {
  var recorded = rec && rec.mcp_fp;
  if (!recorded) return false;
  var current = await mcpTokenFingerprint(env);
  if (!current) return false;
  return recorded === current;
}

function rateBucket() {
  // "2026-07-02T07:23:45.000Z" → "2026-07-02-07"（UTC時単位のバケット）
  return new Date().toISOString().slice(0, 13).replace("T", "-");
}

async function checkAuthRateLimit(env, type, identifier) {
  var limit = AUTH_RATE_LIMITS[type];
  if (!limit || !identifier) return true;
  var key = "rate:" + type + ":" + identifier + ":" + rateBucket();
  try {
    var current = parseInt(await env.SUBSCRIPTIONS.get(key), 10) || 0;
    if (current >= limit) return false;
    await env.SUBSCRIPTIONS.put(key, String(current + 1), { expirationTtl: 3600 });
    return true;
  } catch (e) {
    return true; // KV障害時は可用性優先で通過
  }
}

// リダイレクト先を許可originに限定（オープンリダイレクト＋セッション漏洩の防止）
function sanitizeRedirect(raw) {
  try {
    if (!raw) return DEFAULT_REDIRECT_URL;
    var u = new URL(raw);
    if (ALLOWED_ORIGINS.indexOf(u.origin) !== -1) return u.origin + u.pathname;
  } catch (e) { /* ignore */ }
  return DEFAULT_REDIRECT_URL;
}

function getBearer(request) {
  var auth = request.headers.get("Authorization") || "";
  var m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Bearerセッション → 認証済みメール（小文字）。無効なら null。
async function getSessionEmail(request, env) {
  var sessionId = getBearer(request);
  if (!sessionId) return null;
  try {
    var raw = await env.SUBSCRIPTIONS.get("session:" + sessionId);
    if (!raw) return null;
    var session = JSON.parse(raw);
    if (session.expiry && session.expiry < Date.now()) {
      await env.SUBSCRIPTIONS.delete("session:" + sessionId);
      return null;
    }
    return session.email || null;
  } catch (e) {
    return null;
  }
}

async function sendMagicLinkEmail(env, to, link) {
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "とむSYSTEM <noreply@tomu-ai.dev>",
      to: [to],
      subject: "とむSYSTEM ログインリンク",
      html: magicLinkEmailHtml(link),
    }),
  });
  if (!res.ok) {
    console.error("マジックリンク送信失敗 (" + to + "): " + (await res.text()));
    throw new Error("メール送信に失敗しました");
  }
}

function magicLinkEmailHtml(link) {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f7f3ee;font-family:'Hiragino Sans','Noto Sans JP',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f3ee;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr><td style="padding:0 28px 24px;text-align:center;">
          <p style="margin:0;font-size:15px;letter-spacing:.12em;color:#1a1612;">とむ<span style="color:#b87333;">SYSTEM</span></p>
        </td></tr>
        <tr><td style="padding:0 28px 24px;">
          <div style="background:#ffffff;border:1px solid #ddd5c8;border-radius:14px;padding:28px;text-align:center;">
            <p style="margin:0 0 20px;font-size:14px;line-height:1.9;color:#1a1612;">下のボタンから、とむSYSTEMにログインできます。<br/>このリンクの有効期限は15分・1回限り有効です。</p>
            <a href="${link}" style="display:inline-block;background:#1a1612;color:#f7f3ee;text-decoration:none;font-size:14px;letter-spacing:.08em;padding:14px 32px;border-radius:40px;">ログインする</a>
            <p style="margin:20px 0 0;font-size:11px;line-height:1.8;color:#8a7e72;">このメールに心当たりがない場合は、破棄してください。</p>
          </div>
        </td></tr>
        <tr><td style="padding:4px 28px 0;text-align:center;">
          <p style="margin:0;font-size:10px;letter-spacing:.15em;color:#8a7e72;">© 2026 とむSYSTEM</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function authResultPage(message) {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>とむSYSTEM</title></head>
<body style="margin:0;background:#f7f3ee;color:#1a1612;font-family:'Hiragino Sans','Noto Sans JP',sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;">
  <div style="max-width:420px;padding:2rem;text-align:center;">
    <p style="font-size:14px;letter-spacing:.12em;margin:0 0 1.5rem;">とむ<span style="color:#b87333;">SYSTEM</span></p>
    <p style="font-size:14px;line-height:1.9;color:#c0392b;">${escapeHtml(message)}</p>
    <p style="margin-top:2rem;"><a href="${DEFAULT_REDIRECT_URL}" style="color:#b87333;font-size:13px;">トップへ戻る</a></p>
  </div>
</body></html>`;
}

// POST /api/auth/request-link { email, redirect }
async function handleAuthRequestLink(request, env, corsH) {
  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY が未設定のため認証を実行できません");
    return jsonRes({ error: "auth_not_configured" }, 500, corsH);
  }
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonRes({ error: "Invalid JSON" }, 400, corsH);
  }
  var email = (typeof body.email === "string" ? body.email : "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonRes({ error: "invalid_email" }, 400, corsH);
  }
  var ip = request.headers.get("CF-Connecting-IP") || "";
  if (!(await checkAuthRateLimit(env, "magic", email)) ||
      !(await checkAuthRateLimit(env, "magicip", ip))) {
    return jsonRes({ error: "rate_limited" }, 429, corsH);
  }
  var token = crypto.randomUUID();
  await env.SUBSCRIPTIONS.put("auth:link:" + token, JSON.stringify({
    email: email,
    redirect: sanitizeRedirect(body.redirect),
  }), { expirationTtl: MAGIC_LINK_TTL_SECONDS });
  var link = new URL(request.url).origin + "/api/auth/verify?token=" + encodeURIComponent(token);
  try {
    await sendMagicLinkEmail(env, email, link);
  } catch (e) {
    return jsonRes({ error: "send_failed" }, 502, corsH);
  }
  // 登録有無に関わらず success を返す（メールアドレスの存在を漏らさない）
  return jsonRes({ success: true }, 200, corsH);
}

// GET /api/auth/verify?token=xxx → セッション発行 & 元のページへリダイレクト
async function handleAuthVerify(request, env) {
  var token = new URL(request.url).searchParams.get("token") || "";
  if (!/^[0-9a-f-]{36}$/.test(token)) {
    return htmlRes(authResultPage("リンクが無効です。お手数ですが、もう一度ログインしてください。"));
  }
  var key = "auth:link:" + token;
  var raw = await env.SUBSCRIPTIONS.get(key);
  if (!raw) {
    return htmlRes(authResultPage("リンクが無効か、有効期限（15分）が切れています。お手数ですが、もう一度ログインしてください。"));
  }
  await env.SUBSCRIPTIONS.delete(key); // ワンタイム使用
  var data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return htmlRes(authResultPage("エラーが発生しました。もう一度ログインしてください。"));
  }
  var sessionId = crypto.randomUUID();
  await env.SUBSCRIPTIONS.put("session:" + sessionId, JSON.stringify({
    email: data.email,
    expiry: Date.now() + SESSION_TTL_SECONDS * 1000,
  }), { expirationTtl: SESSION_TTL_SECONDS });
  var dest = sanitizeRedirect(data.redirect) + "#tomu_sid=" + encodeURIComponent(sessionId);
  return new Response(null, { status: 302, headers: { "Location": dest } });
}

// GET /api/auth/me（Bearer）→ ログイン状態とプラン
async function handleAuthMe(request, env, corsH) {
  var meEmail = await getSessionEmail(request, env);
  if (!meEmail) return jsonRes({ error: "login_required" }, 401, corsH);
  var mePlan = await env.SUBSCRIPTIONS.get(meEmail);
  return jsonRes({ email: meEmail, plan: mePlan || null, admin: isAdmin(meEmail) }, 200, corsH);
}

// POST /api/auth/logout（Bearer）→ セッション削除
async function handleAuthLogout(request, env, corsH) {
  var sessionId = getBearer(request);
  if (sessionId) {
    try { await env.SUBSCRIPTIONS.delete("session:" + sessionId); } catch (e) { /* ignore */ }
  }
  return jsonRes({ success: true }, 200, corsH);
}

// A-6: Anthropic /v1/messages へのプロキシ。opts.stream === true のとき SSE をそのままフォワードする。
// stream を指定しない既存の呼び出し元は従来通り JSON を受け取る（挙動不変）。
async function anthropicChat(env, corsH, opts) {
  var wantStream = opts.stream === true;
  var aiRes;
  try {
    aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: opts.model || "claude-sonnet-5",
        max_tokens: opts.max_tokens,
        system: opts.system,
        messages: opts.messages,
        stream: wantStream,
      }),
    });
  } catch (err) {
    return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
  }
  if (!aiRes.ok) {
    return jsonRes({ error: "Anthropic API error", detail: await aiRes.text() }, aiRes.status, corsH);
  }
  if (wantStream) {
    return new Response(aiRes.body, {
      status: 200,
      headers: Object.assign({}, corsH, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      }),
    });
  }
  return new Response(await aiRes.text(), {
    status: 200,
    headers: Object.assign({}, corsH, { "Content-Type": "application/json" }),
  });
}

var LEGAL_NAV_LOGO = `<nav>
  <a href="https://tomu-ai963.github.io/tomu-system/" class="nav-logo">とむ<span>SYSTEM</span></a>
</nav>`;

var LEGAL_STYLE = `<style>
:root {
  --ink: #1a1612;
  --paper: #f7f3ee;
  --warm: #f0e8dc;
  --accent: #b87333;
  --accent2: #7a9e7e;
  --muted: #8a7e72;
  --border: #ddd5c8;
  --surface: #ffffff;
}
*, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
html { scroll-behavior: smooth; }
body {
  background: var(--paper);
  color: var(--ink);
  font-family: 'Noto Sans JP', sans-serif;
  font-weight: 300;
  line-height: 1.8;
  min-height: 100vh;
}
nav {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 100;
  padding: 20px 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(247,243,238,0.88);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}
.nav-logo {
  font-family: 'Cormorant Garamond', serif;
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--ink);
  text-decoration: none;
}
.nav-logo span { color: var(--accent); }
@media(max-width:640px){ nav { padding: 16px 20px; } }
main {
  max-width: 760px;
  margin: 0 auto;
  padding: 120px 1.5rem 5rem;
}
h1 {
  font-family: 'Cormorant Garamond', serif;
  font-size: 2rem;
  font-weight: 600;
  color: var(--ink);
  letter-spacing: 0.06em;
  margin-bottom: 2rem;
  padding-bottom: 1rem;
  border-bottom: 2px solid var(--accent);
}
h2 {
  font-family: 'Cormorant Garamond', serif;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--ink);
  letter-spacing: 0.04em;
  margin: 2.5rem 0 0.75rem;
}
p { margin-bottom: 1rem; font-size: 0.875rem; }
ul { margin: 0.5rem 0 1rem 1.4rem; font-size: 0.875rem; }
ul li { padding: 0.15rem 0; }
table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 3rem;
  font-size: 0.875rem;
}
th, td {
  padding: 1rem 1.2rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
th {
  width: 34%;
  background: var(--warm);
  font-weight: 400;
  color: var(--muted);
  letter-spacing: 0.04em;
}
td { background: var(--surface); }
.price-list { margin: 0; padding: 0; list-style: none; }
.price-list li { padding: 0.25rem 0; display: flex; align-items: baseline; gap: 0.6rem; }
.price-badge {
  display: inline-block;
  background: var(--accent);
  color: var(--paper);
  font-size: 0.65rem;
  padding: 0.1rem 0.55rem;
  border-radius: 3px;
  letter-spacing: 0.06em;
  white-space: nowrap;
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--accent);
  text-decoration: none;
  font-size: 0.85rem;
  letter-spacing: 0.04em;
  border-bottom: 1px solid transparent;
  transition: border-color .2s;
}
.back-link:hover { border-color: var(--accent); }
.effective-date {
  font-size: 0.8rem;
  color: var(--muted);
  margin-bottom: 2.5rem;
}
footer {
  background: var(--ink);
  border-top: 1px solid rgba(255,255,255,.06);
  padding: 40px 48px;
  text-align: center;
}
.footer-copy {
  font-size: 0.65rem;
  color: rgba(247,243,238,.25);
  letter-spacing: 0.15em;
  text-transform: uppercase;
}
@media(max-width:640px){
  main { padding-top: 90px; }
  footer { padding: 32px 20px; }
  th { width: 40%; }
}
</style>`;

var LEGAL_HEAD_LINKS = `<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Noto+Sans+JP:wght@200;300;400;500&display=swap" rel="stylesheet"/>`;

var TOKUSHOHO_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>特定商取引法に基づく表記 — とむSYSTEM</title>
${LEGAL_HEAD_LINKS}
${LEGAL_STYLE}
</head>
<body>
${LEGAL_NAV_LOGO}
<main>
  <h1>特定商取引法に基づく表記</h1>
  <table>
    <tr>
      <th>運営者・運営責任者</th>
      <td>藤山　博史</td>
    </tr>
    <tr>
      <th>所在地・電話番号</th>
      <td>請求があった場合には速やかに開示いたします</td>
    </tr>
    <tr>
      <th>メールアドレス</th>
      <td>Inverted.triangle.leef@gmail.com</td>
    </tr>
    <tr>
      <th>販売価格</th>
      <td>
        <ul class="price-list">
          <li><span class="price-badge">ライト</span>月額 480円（税込）</li>
          <li><span class="price-badge">スタンダード</span>月額 980円（税込）</li>
          <li><span class="price-badge">フル</span>月額 1,480円（税込）</li>
        </ul>
      </td>
    </tr>
    <tr>
      <th>支払方法</th>
      <td>クレジットカード（Stripe決済）</td>
    </tr>
    <tr>
      <th>サービス提供時期</th>
      <td>決済完了後即時</td>
    </tr>
    <tr>
      <th>返金・キャンセル</th>
      <td>月途中のキャンセルによる返金は行いません</td>
    </tr>
  </table>
  <a href="https://tomu-ai963.github.io/tomu-system/" class="back-link">← トップページに戻る</a>
</main>
<footer>
  <div class="footer-copy">© 2026 とむSYSTEM. All rights reserved.</div>
</footer>
</body>
</html>`;

var PRIVACY_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>プライバシーポリシー — とむSYSTEM</title>
${LEGAL_HEAD_LINKS}
${LEGAL_STYLE}
</head>
<body>
${LEGAL_NAV_LOGO}
<main>
  <h1>プライバシーポリシー</h1>
  <p class="effective-date">制定日：2026年1月1日</p>

  <p>とむSYSTEM（以下「本サービス」）は、ユーザーの個人情報の取り扱いについて以下のとおり定めます。</p>

  <h2>1. 収集する個人情報</h2>
  <p>本サービスは、以下の情報を収集する場合があります。</p>
  <ul>
    <li>メールアドレス（ログイン・サブスクリプション管理・お問い合わせ時）</li>
    <li>決済関連情報（Stripe社を通じた処理。カード番号等はStripe社が管理し、本サービスは保持しません）</li>
    <li>サービス利用状況（AI機能の利用回数・プラン情報）</li>
  </ul>

  <h2>2. 利用目的</h2>
  <p>収集した個人情報は、以下の目的で利用します。</p>
  <ul>
    <li>本サービスの提供・運営・改善</li>
    <li>サブスクリプションプランの管理</li>
    <li>利用制限・不正利用の検知</li>
    <li>お問い合わせへの対応</li>
    <li>重要なお知らせの送信</li>
  </ul>

  <h2>3. 第三者への提供</h2>
  <p>本サービスは、以下の場合を除き、個人情報を第三者に提供しません。</p>
  <ul>
    <li>法令に基づき開示が必要な場合</li>
    <li>ユーザーの同意がある場合</li>
  </ul>
  <p>なお、本サービスは以下の外部サービスを利用しています。</p>
  <ul>
    <li>Stripe, Inc.（決済処理）</li>
    <li>Anthropic, PBC（AI機能）</li>
    <li>Cloudflare, Inc.（インフラ・ホスティング）</li>
    <li>Google LLC（フォント配信）</li>
  </ul>

  <h2>4. Cookie・アクセス解析</h2>
  <p>本サービスのページはGoogleフォント等のCDNを利用しており、これらのサービスがCookieを設定する場合があります。本サービス独自のアクセス解析ツールは現時点では導入していません。</p>

  <h2>5. 個人情報の管理</h2>
  <p>収集した個人情報は、Cloudflare Workers KVにて管理し、適切なアクセス制御を実施しています。サービス退会後、不要となった情報は速やかに削除します。</p>

  <h2>6. ポリシーの変更</h2>
  <p>本ポリシーの内容は、法令の改正やサービス変更に応じて予告なく変更する場合があります。変更後の内容は、本ページに掲載した時点から効力を生じます。</p>

  <h2>7. お問い合わせ</h2>
  <p>個人情報の取り扱いに関するお問い合わせは、下記メールアドレスまでご連絡ください。</p>
  <p>Inverted.triangle.leef@gmail.com</p>

  <a href="https://tomu-ai963.github.io/tomu-system/" class="back-link" style="margin-top:2rem;">← トップページに戻る</a>
</main>
<footer>
  <div class="footer-copy">© 2026 とむSYSTEM. All rights reserved.</div>
</footer>
</body>
</html>`;

// ===== Google Calendar OAuth2 =====
async function getGoogleAccessToken(env) {
  var refreshToken = await env.SUBSCRIPTIONS.get("GOOGLE_REFRESH_TOKEN");
  if (!refreshToken) throw new Error("refresh_token not found in KV");

  var res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  var data = await res.json();
  if (!data.access_token) throw new Error("access_token取得失敗: " + JSON.stringify(data));
  return data.access_token;
}

async function getCalendarEvents(accessToken) {
  var now = new Date();
  var timeMin = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  var timeMax = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

  var calUrl = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  calUrl.searchParams.set("timeMin", timeMin);
  calUrl.searchParams.set("timeMax", timeMax);
  calUrl.searchParams.set("singleEvents", "true");
  calUrl.searchParams.set("orderBy", "startTime");
  calUrl.searchParams.set("maxResults", "50");

  var res = await fetch(calUrl.toString(), {
    headers: { "Authorization": "Bearer " + accessToken },
  });
  var data = await res.json();
  if (!data.items) throw new Error("Calendar取得失敗: " + JSON.stringify(data));
  return data.items;
}

function getMoonAge(date) {
  var known = new Date("2000-01-06T18:14:00Z");
  var diff = (date - known) / (1000 * 60 * 60 * 24);
  return ((diff % 29.53058867) + 29.53058867) % 29.53058867;
}

function getMoonPhaseLabel(age) {
  if (age < 1.5)  return "🌑 新月（種まき・始まりの時）";
  if (age < 7.5)  return "🌒 上弦前（地上部の成長に◎）";
  if (age < 8.5)  return "🌓 上弦（収穫・剪定に吉）";
  if (age < 14.5) return "🌔 満月前（実りの準備）";
  if (age < 15.5) return "🌕 満月（収穫・保存作業に◎）";
  if (age < 22.5) return "🌖 下弦前（根の作業に◎）";
  if (age < 23.5) return "🌗 下弦（土壌整備・施肥に吉）";
  return "🌘 晦日前（休息・計画の時）";
}

function getMonthMoonData() {
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();
  var daysInMonth = new Date(year, month + 1, 0).getDate();
  var moonData = [];
  for (var d = 1; d <= daysInMonth; d++) {
    var date = new Date(year, month, d);
    var age = getMoonAge(date);
    moonData.push({
      day: d,
      moonAge: Math.floor(age),
      phase: getMoonPhaseLabel(age),
      isNewMoon: age < 1.5,
      isFullMoon: age >= 14 && age < 16,
      isQuarter: (age >= 7 && age < 9) || (age >= 22 && age < 24),
    });
  }
  return moonData;
}

async function handleYamaCalendar(request, corsH, env, authEmail) {
  var email = authEmail || "";
  var planCheck = await checkPlanAndCount(email, "standard", env);
  if (!planCheck.ok) {
    return jsonRes({ error: planCheck.error, required: planCheck.required, current: planCheck.current, limit: planCheck.limit }, planCheck.status, corsH);
  }
  try {
    var accessToken = await getGoogleAccessToken(env);
    var events = await getCalendarEvents(accessToken);
    var moonData = getMonthMoonData();
    var now = new Date();
    var monthLabel = now.getFullYear() + "年" + (now.getMonth() + 1) + "月";
    var keyDays = moonData.filter(function(d) { return d.isNewMoon || d.isFullMoon || d.isQuarter; });

    var eventSummary = events.map(function(e) {
      var start = (e.start && (e.start.dateTime || e.start.date)) || "";
      return "・" + start.slice(5, 10) + " " + (e.summary || "（無題）");
    }).join("\n") || "（今月の予定なし）";

    var aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        system: "あなたは山暮らしの農作業アドバイザーです。\n月齢・旧暦の吉日と、ユーザーのGoogleカレンダーの予定を組み合わせて、\n今月の農作業タイミングを具体的に提案してください。\n豪雪地帯・高標高の山林環境を考慮し、キノコの原木栽培・山仕事に特化したアドバイスを含めること。\n出力は日本語で、見やすくまとめてください。",
        messages: [{
          role: "user",
          content: "【" + monthLabel + "の情報】\n\n■ 月齢カレンダー（吉日）\n" +
            keyDays.map(function(d) { return d.day + "日: " + d.phase; }).join("\n") +
            "\n\n■ Googleカレンダーの予定\n" + eventSummary +
            "\n\n上記を踏まえ、今月の農作業・山仕事の最適タイミングを提案してください。",
        }],
      }),
    });
    var aiData = await aiRes.json();
    var advice = (aiData.content && aiData.content[0] && aiData.content[0].text) || "AI提案を取得できませんでした";

    return jsonRes({
      success: true,
      month: monthLabel,
      events: events.map(function(e) {
        return {
          title: e.summary,
          start: (e.start && (e.start.dateTime || e.start.date)) || "",
        };
      }),
      moonData: moonData,
      keyDays: keyDays,
      advice: advice,
    }, 200, corsH);
  } catch (err) {
    return jsonRes({ success: false, error: err.message }, 500, corsH);
  }
}

// ===== MCP サーバー (POST /mcp) =====

var MCP_TOOLS_LIST = [
  {
    name: "summarize_and_reply",
    description: "長文メール・資料を3行で要約し、返信案を生成します",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要約・返信したいメール・資料のテキスト" },
        direction: { type: "string", description: "返信の方向性（例：承諾、断り、確認依頼）。省略可" }
      },
      required: ["text"]
    }
  },
  {
    name: "task_to_action",
    description: "議事録のテキストをアクションプラン（担当者・期限付き）に変換します",
    inputSchema: {
      type: "object",
      properties: {
        minutes: { type: "string", description: "議事録のテキスト" }
      },
      required: ["minutes"]
    }
  },
  {
    name: "resume_rewrite",
    description: "職務経歴書をリライトし、成果・数値・能動的な表現に強化します",
    inputSchema: {
      type: "object",
      properties: {
        resume: { type: "string", description: "現在の職務経歴書のテキスト" },
        target_job: { type: "string", description: "応募先・希望職種の説明。省略可" }
      },
      required: ["resume"]
    }
  },
  {
    name: "weekly_coach",
    description: "週次の振り返りをもとに承認・深掘り質問・来週の実験を提案します",
    inputSchema: {
      type: "object",
      properties: {
        reflection: { type: "string", description: "今週の振り返り・できごと・感じたこと" }
      },
      required: ["reflection"]
    }
  },
  {
    name: "lucky_action",
    description: "今の気分・状況に合わせて1分でできるラッキーアクションを提案します",
    inputSchema: {
      type: "object",
      properties: {
        mood: { type: "string", description: "今日の気分・状況・やりたいこと" }
      },
      required: ["mood"]
    }
  }
];

var MCP_SYSTEM_PROMPTS = {
  summarize_and_reply:
    "あなたは優秀なビジネスアシスタントです。受け取った長文メール・資料を分析し、" +
    "以下の形式で出力してください。返信の方向性が指定されている場合はそれに従ってください。\n" +
    "## 要約\n（3行で核心のみ）\n\n## 返信案\n（本文のみ、件名不要）",
  task_to_action:
    "あなたは優秀なプロジェクトマネージャーです。議事録を分析し、以下の形式で出力してください。\n" +
    "## アクションプラン\n- [ ] タスク名（担当者）期限\n\n## 決定事項\n- 内容",
  resume_rewrite:
    "あなたは採用コンサルタントです。職務経歴書を読み、成果・数値・能動的な動詞を使って" +
    "説得力のある表現にリライトしてください。" +
    "応募先・希望職種が指定されている場合はその観点でキーワードを強調してください。",
  weekly_coach:
    "あなたは内省コーチです。ユーザーの週次振り返りを受け取り、" +
    "①今週のよかった点を承認し、②気づきを深掘りする質問を2つ投げ、" +
    "③来週への小さな実験を1つ提案してください。温かく前向きなトーンで。",
  lucky_action:
    "あなたは『ラッキーアクション』のAIです。ユーザーの今日の気分を聞いて、" +
    "1分以内に実行できる具体的でちょっと意外な開運行動を1つだけ提案してください。" +
    "理由も一言添えて、150文字以内で。"
};

var MCP_MAX_TOKENS = {
  summarize_and_reply: 1000,
  task_to_action: 1000,
  resume_rewrite: 2000,
  weekly_coach: 800,
  lucky_action: 200
};

async function callMcpTool(name, args, env) {
  var systemPrompt = MCP_SYSTEM_PROMPTS[name];
  if (!systemPrompt) {
    return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  }

  var userContent;
  if (name === "summarize_and_reply") {
    userContent = (args.direction ? "【返信の方向性】" + args.direction + "\n\n" : "") + "【本文】\n" + (args.text || "");
  } else if (name === "task_to_action") {
    userContent = args.minutes || "";
  } else if (name === "resume_rewrite") {
    userContent = (args.target_job ? "【応募先・希望職種】" + args.target_job + "\n\n" : "") + "【職務経歴書】\n" + (args.resume || "");
  } else if (name === "weekly_coach") {
    userContent = args.reflection || "";
  } else if (name === "lucky_action") {
    userContent = args.mood || "";
  }

  try {
    var res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: MCP_MAX_TOKENS[name] || 800,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    var data = await res.json();
    if (data.error) {
      return { content: [{ type: "text", text: "AI error: " + data.error.message }], isError: true };
    }
    var text = (data.content && data.content[0]) ? data.content[0].text : "";
    return { content: [{ type: "text", text: text }] };
  } catch (err) {
    return { content: [{ type: "text", text: "Worker error: " + err.message }], isError: true };
  }
}

async function handleMcp(request, env) {
  // Streamable HTTP: GET リクエストにはサーバー情報を返す
  if (request.method === "GET") {
    return new Response(JSON.stringify({
      name: "tomu-system",
      version: "1.0.0",
      protocolVersion: "2024-11-05",
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  var mcpUrl = new URL(request.url);
  var authHeader = request.headers.get("Authorization") || "";
  var bearerToken = /^Bearer\s+/i.test(authHeader) ? authHeader.replace(/^Bearer\s+/i, "") : "";
  var token = request.headers.get("MCP-Token") || mcpUrl.searchParams.get("token") || bearerToken || "";

  var authorized = !!env.MCP_TOKEN && timingSafeEqual(token, env.MCP_TOKEN);
  if (!authorized && bearerToken) {
    var granted = await oauthGetJson(env, "oauth:token:" + bearerToken);
    authorized = await mcpFingerprintMatches(env, granted);
  }
  if (!authorized) {
    var prm = oauthIssuer(request) + "/.well-known/oauth-protected-resource";
    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: null,
      error: { code: -32001, message: "Unauthorized" }
    }), {
      status: 401,
      headers: Object.assign({}, OAUTH_CORS, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer resource_metadata="' + prm + '"',
      }),
    });
  }

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: null,
      error: { code: -32700, message: "Parse error" }
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  var rpcId = body.id !== undefined ? body.id : null;
  var method = body.method;
  var params = body.params || {};
  var h = Object.assign({}, OAUTH_CORS, { "Content-Type": "application/json" });

  function ok(result) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpcId, result: result }), { status: 200, headers: h });
  }
  function rpcErr(code, message) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpcId, error: { code: code, message: message } }), { status: 200, headers: h });
  }

  if (method === "initialize") {
    return ok({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "tomu-system", version: "1.0.0" }
    });
  }

  if (method === "tools/list") {
    return ok({ tools: MCP_TOOLS_LIST });
  }

  if (method === "tools/call") {
    var toolName = params.name;
    var toolArgs = params.arguments || {};
    var result = await callMcpTool(toolName, toolArgs, env);
    return ok(result);
  }

  return rpcErr(-32601, "Method not found: " + method);
}

// ===== OAuth2 / PKCE (Claude.ai Webコネクタ向け、既存の ?token= 認証と並存) =====

function oauthIssuer(request) {
  return new URL(request.url).origin;
}

function randomToken(bytes) {
  var arr = new Uint8Array(bytes || 32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

async function sha256Base64Url(input) {
  var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  var bytes = new Uint8Array(digest);
  var bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function oauthGetJson(env, key) {
  var raw = await env.SUBSCRIPTIONS.get(key);
  return raw ? JSON.parse(raw) : null;
}

function handleOauthMetadata(request, env, corsH) {
  var issuer = oauthIssuer(request);
  return jsonRes({
    issuer: issuer,
    authorization_endpoint: issuer + "/oauth/authorize",
    token_endpoint: issuer + "/oauth/token",
    registration_endpoint: issuer + "/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["mcp"],
  }, 200, corsH);
}

function handleOauthProtectedResource(request, env, corsH) {
  var issuer = oauthIssuer(request);
  return jsonRes({
    resource: issuer + "/mcp",
    authorization_servers: [issuer],
  }, 200, corsH);
}

// 認可コードの送り先。https と loopback のみ許可し、平文 http や javascript:/data: を弾く
function isAllowedRedirectUri(raw) {
  if (typeof raw !== "string" || raw.length > 512) return false;
  var u;
  try { u = new URL(raw); } catch (e) { return false; }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" &&
    (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]");
}

async function handleOauthRegister(request, env, corsH) {
  // 未認証で叩けるので IP 単位で登録数を絞る（KV への無制限書き込み防止）
  if (!(await checkAuthRateLimit(env, "oauthreg", request.headers.get("CF-Connecting-IP") || ""))) {
    return jsonRes({ error: "rate_limited" }, 429, corsH);
  }

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonRes({ error: "invalid_client_metadata", error_description: "Invalid JSON" }, 400, corsH);
  }

  var redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0 || redirectUris.length > 5) {
    return jsonRes({ error: "invalid_redirect_uri", error_description: "redirect_uris is required (max 5)" }, 400, corsH);
  }
  if (!redirectUris.every(isAllowedRedirectUri)) {
    return jsonRes({ error: "invalid_redirect_uri", error_description: "redirect_uri must be https or loopback, without fragment" }, 400, corsH);
  }

  var clientId = randomToken(16);
  var client = {
    client_id: clientId,
    client_name: body.client_name || "MCP Client",
    redirect_uris: redirectUris,
    created_at: Date.now(),
  };
  await env.SUBSCRIPTIONS.put("oauth:client:" + clientId, JSON.stringify(client), { expirationTtl: 60 * 60 * 24 * 365 });

  return jsonRes({
    client_id: clientId,
    client_name: client.client_name,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }, 201, corsH);
}

var OAUTH_PARAM_KEYS = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "scope"];

function oauthAuthorizeForm(params, error, client) {
  var hidden = OAUTH_PARAM_KEYS.map(function (k) {
    return params[k] ? '<input type="hidden" name="' + k + '" value="' + escapeHtml(params[k]) + '">' : "";
  }).join("\n");
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>とむSYSTEM - 連携の許可</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f5f2;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border-radius:16px;padding:32px;max-width:380px;width:90%;box-shadow:0 4px 24px rgba(0,0,0,.08);}
h1{font-size:18px;margin:0 0 8px;}
p{font-size:14px;color:#555;line-height:1.6;}
input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;margin:12px 0;}
button{width:100%;padding:12px;border:none;border-radius:8px;background:#2d2a26;color:#fff;font-size:15px;cursor:pointer;}
.err{color:#c0392b;font-size:13px;}
.meta{font-size:13px;color:#333;background:#f2efe9;border-radius:8px;padding:8px 10px;word-break:break-all;}
</style></head><body>
<div class="card">
<h1>とむSYSTEM への連携を許可しますか?</h1>
<p><strong>${escapeHtml((client && client.client_name) || "不明なクライアント")}</strong> が、あなたのとむSYSTEMへの接続をリクエストしています。</p>
<p class="meta">認可コードの送信先: <code>${escapeHtml((function () { try { return new URL(params.redirect_uri).origin; } catch (e) { return params.redirect_uri || "(不明)"; } })())}</code></p>
<p>心当たりのないアプリ名・送信先であれば、<strong>トークンを入力せずにこのページを閉じてください。</strong>入力するとこのアプリにあなたのとむSYSTEMへのアクセスを許可することになります。</p>
${error ? '<p class="err">' + escapeHtml(error) + '</p>' : ""}
<form method="POST">
${hidden}
<input type="password" name="mcp_token" placeholder="アクセストークン" required autofocus>
<button type="submit">許可する</button>
</form>
</div>
</body></html>`;
}

async function handleOauthAuthorize(request, env) {
  var url = new URL(request.url);
  var isPost = request.method === "POST";
  var params = {};
  var enteredToken = "";

  if (isPost) {
    var form = await request.formData();
    OAUTH_PARAM_KEYS.forEach(function (k) { params[k] = form.get(k) || ""; });
    enteredToken = form.get("mcp_token") || "";
  } else {
    OAUTH_PARAM_KEYS.forEach(function (k) { params[k] = url.searchParams.get(k) || ""; });
  }

  if (params.response_type && params.response_type !== "code") {
    return jsonRes({ error: "unsupported_response_type" }, 400, {});
  }
  if (!params.client_id || !params.redirect_uri) {
    return jsonRes({ error: "invalid_request", error_description: "client_id and redirect_uri are required" }, 400, {});
  }

  var client = await oauthGetJson(env, "oauth:client:" + params.client_id);
  if (!client || client.redirect_uris.indexOf(params.redirect_uri) === -1) {
    return jsonRes({ error: "invalid_client", error_description: "Unknown client_id or redirect_uri" }, 400, {});
  }

  // メタデータで S256 のみ広告しているので、plain や PKCE 無しへの格下げを拒否する
  if (!params.code_challenge || params.code_challenge_method !== "S256") {
    return jsonRes({ error: "invalid_request", error_description: "code_challenge with code_challenge_method=S256 is required" }, 400, {});
  }

  if (!isPost) {
    return htmlRes(oauthAuthorizeForm(params, null, client));
  }

  // 同意画面は MCP_TOKEN を外部から試せる唯一の口なので、IP 単位で試行を絞る
  if (!(await checkAuthRateLimit(env, "oauthauth", request.headers.get("CF-Connecting-IP") || ""))) {
    return htmlRes(oauthAuthorizeForm(params, "試行回数が上限に達しました。しばらく待ってからやり直してください。", client));
  }

  if (!env.MCP_TOKEN || !timingSafeEqual(enteredToken, env.MCP_TOKEN)) {
    return htmlRes(oauthAuthorizeForm(params, "トークンが正しくありません。もう一度お試しください。", client));
  }

  var code = randomToken(32);
  await env.SUBSCRIPTIONS.put("oauth:code:" + code, JSON.stringify({
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    code_challenge_method: "S256",
  }), { expirationTtl: 600 });

  var redirect = new URL(params.redirect_uri);
  redirect.searchParams.set("code", code);
  if (params.state) redirect.searchParams.set("state", params.state);
  return new Response(null, { status: 302, headers: { "Location": redirect.toString() } });
}

var OAUTH_ACCESS_TTL = 60 * 60 * 24 * 90;
var OAUTH_REFRESH_TTL = 60 * 60 * 24 * 365;

async function oauthIssueTokens(env, clientId) {
  // MCP_TOKEN 未設定のまま発行すると mcp_fp が空のレコードができるので、その手前で止める
  var fp = await mcpTokenFingerprint(env);
  if (!fp) return null;
  var accessToken = randomToken(32);
  var refreshToken = randomToken(32);
  var rec = JSON.stringify({ client_id: clientId, issued_at: Date.now(), mcp_fp: fp });
  await env.SUBSCRIPTIONS.put("oauth:token:" + accessToken, rec, { expirationTtl: OAUTH_ACCESS_TTL });
  await env.SUBSCRIPTIONS.put("oauth:refresh:" + refreshToken, rec, { expirationTtl: OAUTH_REFRESH_TTL });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_TTL,
    refresh_token: refreshToken,
    scope: "mcp",
  };
}

async function handleOauthToken(request, env, corsH) {
  var contentType = request.headers.get("Content-Type") || "";
  var data = {};
  try {
    if (contentType.indexOf("application/json") !== -1) {
      data = await request.json();
    } else {
      var form = await request.formData();
      form.forEach(function (v, k) { data[k] = v; });
    }
  } catch (e) {
    return jsonRes({ error: "invalid_request", error_description: "Invalid request body" }, 400, corsH);
  }

  if (data.grant_type === "refresh_token") {
    var refreshKey = "oauth:refresh:" + (data.refresh_token || "");
    var refreshRec = await oauthGetJson(env, refreshKey);
    if (!refreshRec) {
      return jsonRes({ error: "invalid_grant", error_description: "Unknown or expired refresh_token" }, 400, corsH);
    }
    if (data.client_id && data.client_id !== refreshRec.client_id) {
      return jsonRes({ error: "invalid_grant", error_description: "client_id mismatch" }, 400, corsH);
    }
    if (!(await mcpFingerprintMatches(env, refreshRec))) {
      await env.SUBSCRIPTIONS.delete(refreshKey);
      return jsonRes({ error: "invalid_grant", error_description: "Token revoked" }, 400, corsH);
    }
    await env.SUBSCRIPTIONS.delete(refreshKey);
    var refreshed = await oauthIssueTokens(env, refreshRec.client_id);
    if (!refreshed) {
      return jsonRes({ error: "temporarily_unavailable", error_description: "Server is not configured for MCP access" }, 503, corsH);
    }
    return jsonRes(refreshed, 200, corsH);
  }

  if (data.grant_type !== "authorization_code") {
    return jsonRes({ error: "unsupported_grant_type" }, 400, corsH);
  }

  var codeKey = "oauth:code:" + (data.code || "");
  var stored = await oauthGetJson(env, codeKey);
  if (!stored) {
    return jsonRes({ error: "invalid_grant", error_description: "Unknown or expired code" }, 400, corsH);
  }
  await env.SUBSCRIPTIONS.delete(codeKey);

  if (data.client_id !== stored.client_id || data.redirect_uri !== stored.redirect_uri) {
    return jsonRes({ error: "invalid_grant", error_description: "client_id/redirect_uri mismatch" }, 400, corsH);
  }

  if (!stored.code_challenge || (await sha256Base64Url(data.code_verifier || "")) !== stored.code_challenge) {
    return jsonRes({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400, corsH);
  }

  var issued = await oauthIssueTokens(env, stored.client_id);
  if (!issued) {
    return jsonRes({ error: "temporarily_unavailable", error_description: "Server is not configured for MCP access" }, 503, corsH);
  }
  return jsonRes(issued, 200, corsH);
}

// =========================================================
// マーケット時価チェッカー（貴金属／為替／暗号資産／エネルギー）
// KVキャッシュ: market:metals / market:forex / market:crypto / market:energy
// 各キーに {data, fetched_at} をJSON文字列で保存する。
// ジャンルごとに独立して取得・キャッシュするため、1ジャンルの失敗が全体に波及しない。
// 外部APIは fetchMarket* のアダプタ1枚で吸収しているので、後から差し替え可能。
// =========================================================

var TROY_OUNCE_G = 31.1034768;

// 鮮度（秒）。これを過ぎたら再取得を試みる。
// metals は GoldAPI.io の無料枠（月100リクエスト・1コール1金属）に合わせて30時間。
// 4金属 × 24h/30h × 30日 = 月96リクエストで枠内に収まる。
var MARKET_TTL = { metals: 108000, forex: 600, crypto: 300, energy: 3600 };

// KVに残しておく期間（秒）。鮮度切れ後もフォールバック用に保持する。
var MARKET_KV_TTL = 60 * 60 * 24 * 7;

var MARKET_GENRES = ["metals", "forex", "crypto", "energy"];

function marketRound(v, digits) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  var p = Math.pow(10, digits);
  return Math.round(v * p) / p;
}

// 前日比（%）。前日値が無い／0のときは null（フロントは「—」表示）
function marketPct(latest, prev) {
  if (typeof latest !== "number" || typeof prev !== "number") return null;
  if (!isFinite(latest) || !isFinite(prev) || prev === 0) return null;
  return marketRound(((latest - prev) / prev) * 100, 2);
}

function marketYmd(d) {
  return d.toISOString().slice(0, 10);
}

// Workers の fetch は User-Agent を自動付与しない。CoinGecko は UA 無しのリクエストを
// 403「Please add a descriptive User-Agent to your request.」で弾くため、
// market 系の外部呼び出しでは必ず明示する。
var MARKET_UA = "tomu-system-worker/1.0 (+https://tomu-ai963.github.io/tomu-system/)";

async function marketFetchJson(url, label, headers) {
  var res = await fetch(url, {
    headers: Object.assign({
      "Accept": "application/json",
      "User-Agent": MARKET_UA,
    }, headers || {}),
  });
  if (!res.ok) {
    // URLはAPIキーを含みうるのでエラー文にURLは載せない。
    // 代わりに上流レスポンスの本文先頭だけ添えて、レート制限かUA拒否かを切り分けられるようにする。
    var detail = "";
    try {
      detail = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 160);
    } catch (e) {
      // 本文が読めなくてもHTTPコードだけは返す
    }
    throw new Error(label + ": HTTP " + res.status + (detail ? " — " + detail : ""));
  }
  return await res.json();
}

async function readMarketCache(genre, env) {
  try {
    var raw = await env.SUBSCRIPTIONS.get("market:" + genre);
    if (!raw) return null;
    var rec = JSON.parse(raw);
    if (!rec || !rec.data || !rec.fetched_at) return null;
    return rec;
  } catch (e) {
    return null; // 壊れたキャッシュは無いものとして扱う
  }
}

async function writeMarketCache(genre, data, env) {
  var rec = { data: data, fetched_at: new Date().toISOString() };
  try {
    await env.SUBSCRIPTIONS.put("market:" + genre, JSON.stringify(rec), { expirationTtl: MARKET_KV_TTL });
  } catch (e) {
    // KV書き込み失敗でもレスポンスは返す（次回また取りに行くだけ）
  }
  return rec;
}

function isMarketFresh(rec, genre) {
  if (!rec || !rec.fetched_at) return false;
  var t = Date.parse(rec.fetched_at);
  if (!isFinite(t)) return false;
  return (Date.now() - t) / 1000 < (MARKET_TTL[genre] || 600);
}

// 鮮度内ならKVをそのまま返す。切れていればAPIを叩き直してKVを更新。
// API失敗時は期限切れのキャッシュを stale:true で返す（真っ白な画面を避ける）。
async function resolveMarketGenre(genre, fetcher, env) {
  var cached = await readMarketCache(genre, env);
  if (isMarketFresh(cached, genre)) {
    return { data: cached.data, fetched_at: cached.fetched_at, stale: false, cache: "hit" };
  }
  try {
    var fresh = await fetcher();
    var rec = await writeMarketCache(genre, fresh, env);
    return { data: rec.data, fetched_at: rec.fetched_at, stale: false, cache: "miss" };
  } catch (err) {
    // wrangler tail で原因を追えるように、全ジャンル共通の形式でログに残す
    // （レスポンスの sources[genre].error と同じ文面）
    console.error("[market] " + genre + " fetch failed: " + err.message);
    if (cached) {
      return { data: cached.data, fetched_at: cached.fetched_at, stale: true, cache: "stale", error: err.message };
    }
    return { data: null, fetched_at: null, stale: true, cache: "empty", error: err.message };
  }
}

// ---- 為替: Frankfurter（ECB基準・無料・登録不要） -------------------------
// 直近10日分を1回で取り、最新と1つ前の営業日を比べて前日比を出す。
async function fetchMarketForex() {
  var end = new Date();
  var start = new Date(end.getTime() - 10 * 86400000);
  var url = "https://api.frankfurter.app/" + marketYmd(start) + ".." + marketYmd(end) +
            "?base=JPY&symbols=USD,EUR,CNY";
  var j = await marketFetchJson(url, "frankfurter");
  var dates = Object.keys((j && j.rates) || {}).sort();
  if (!dates.length) throw new Error("frankfurter: no rates");
  var last = j.rates[dates[dates.length - 1]];
  var prev = dates.length > 1 ? j.rates[dates[dates.length - 2]] : null;

  var pairs = [["USDJPY", "USD"], ["EURJPY", "EUR"], ["CNYJPY", "CNY"]];
  var out = {};
  for (var i = 0; i < pairs.length; i++) {
    var name = pairs[i][0], sym = pairs[i][1];
    // base=JPY なので rates[sym] は「1円あたりの外貨」。逆数が円建てレート。
    var rate = last && last[sym] ? 1 / last[sym] : null;
    var prevRate = prev && prev[sym] ? 1 / prev[sym] : null;
    out[name] = {
      rate: marketRound(rate, 4),
      change_pct_1d: marketPct(rate, prevRate),
      as_of: dates[dates.length - 1],
    };
  }
  if (out.USDJPY.rate === null) throw new Error("frankfurter: USDJPY missing");
  return out;
}

// ---- 貴金属: GoldAPI.io ----------------------------------------------------
// GET https://www.goldapi.io/api/{symbol}/USD、認証はヘッダ x-access-token。
// 1コール=1金属なので、1回の更新で XAU/XAG/XPT/XPD の計4リクエストを消費する。
// 無料枠が月100リクエストしかないため MARKET_TTL.metals を30時間に設定してあり、
// 4金属 × 24h/30h × 30日 = 月96リクエストで枠内に収まる。
// 枠を使い切ると429が返るが、その場合は下の throw で genre 全体を失敗させ、
// resolveMarketGenre の「直前キャッシュを stale:true で返す」経路にそのまま乗る。
// 部分成功を採らないのは、4金属を同一時点のスナップショットとして揃えるため。
// 前日比は GoldAPI.io の chp（前営業日終値比・%）をそのまま使う。
// 1g/1oz の切り替えはフロントで計算させず、ここで4通りとも埋めて返す。
var METAL_SYMBOLS = { gold: "XAU", silver: "XAG", platinum: "XPT", palladium: "XPD" };

async function fetchMarketMetals(env, usdJpy) {
  if (!env.GOLDAPI_KEY) throw new Error("GOLDAPI_KEY is not configured");
  var out = {};
  var names = Object.keys(METAL_SYMBOLS);
  for (var i = 0; i < names.length; i++) {
    var name = names[i], sym = METAL_SYMBOLS[name];
    // 429で枠切れしているときは残りを叩いても無駄なので、1本落ちた時点で中断する
    var j = await marketFetchJson(
      "https://www.goldapi.io/api/" + sym + "/USD",
      "goldapi:" + sym,
      { "x-access-token": env.GOLDAPI_KEY }
    );
    var usdOz = (j && typeof j.price === "number" && isFinite(j.price) && j.price > 0) ? j.price : null;
    if (usdOz === null) throw new Error("goldapi:" + sym + ": price missing");
    var usdG = usdOz / TROY_OUNCE_G;
    out[name] = {
      usd_per_oz: marketRound(usdOz, 2),
      usd_per_g: marketRound(usdG, 3),
      jpy_per_oz: usdJpy ? marketRound(usdOz * usdJpy, 0) : null,
      jpy_per_g: usdJpy ? marketRound(usdG * usdJpy, 1) : null,
      change_pct_1d: marketRound(j.chp, 2),
    };
  }
  return out;
}

// ---- 暗号資産: CoinGecko（無料・登録不要） --------------------------------
var CRYPTO_IDS = { BTC: "bitcoin", ETH: "ethereum" };

async function fetchMarketCrypto() {
  var url = "https://api.coingecko.com/api/v3/simple/price" +
            "?ids=bitcoin,ethereum&vs_currencies=jpy&include_24hr_change=true";
  var j = await marketFetchJson(url, "coingecko");
  var out = {};
  var syms = Object.keys(CRYPTO_IDS);
  for (var i = 0; i < syms.length; i++) {
    var sym = syms[i], row = j && j[CRYPTO_IDS[sym]];
    if (!row || typeof row.jpy !== "number") throw new Error("coingecko: " + sym + " missing");
    out[sym] = {
      jpy: marketRound(row.jpy, 0),
      change_pct_1d: marketRound(row.jpy_24h_change, 2),
    };
  }
  return out;
}

// ---- エネルギー: EIA API（WTI原油スポット RWTC） ---------------------------
// ガソリン価格は無料で自動取得できるAPIが乏しいため、このバージョンでは原油のみ。
async function fetchMarketEnergy(env) {
  if (!env.EIA_API_KEY) throw new Error("EIA_API_KEY is not configured");
  var url = "https://api.eia.gov/v2/petroleum/pri/spt/data/" +
            "?api_key=" + encodeURIComponent(env.EIA_API_KEY) +
            "&frequency=daily&data[0]=value&facets[series][]=RWTC" +
            "&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=2";
  var j = await marketFetchJson(url, "eia");
  var rows = (j && j.response && j.response.data) || [];
  if (!rows.length) throw new Error("eia: no data");
  var latest = Number(rows[0].value);
  var prev = rows.length > 1 ? Number(rows[1].value) : null;
  if (!isFinite(latest)) throw new Error("eia: invalid value");
  return {
    wti_usd_per_barrel: {
      value: marketRound(latest, 2),
      change_pct_1d: marketPct(latest, prev),
      as_of: rows[0].period || null,
    },
  };
}

// GET /market/prices — 4ジャンルをまとめて返す（フロントは1回のfetchで済む）
async function handleMarketPrices(env, corsH) {
  // 貴金属の円建て換算に USDJPY が要るので、為替だけ先に解決する
  var forex = await resolveMarketGenre("forex", fetchMarketForex, env);
  var usdJpy = forex.data && forex.data.USDJPY ? forex.data.USDJPY.rate : null;

  var rest = await Promise.all([
    resolveMarketGenre("metals", function () { return fetchMarketMetals(env, usdJpy); }, env),
    resolveMarketGenre("crypto", fetchMarketCrypto, env),
    resolveMarketGenre("energy", function () { return fetchMarketEnergy(env); }, env),
  ]);

  var resolved = { forex: forex, metals: rest[0], crypto: rest[1], energy: rest[2] };
  var body = { sources: {} };
  var anyStale = false;
  var newest = 0;

  for (var i = 0; i < MARKET_GENRES.length; i++) {
    var g = MARKET_GENRES[i], r = resolved[g];
    body[g] = r.data;
    body.sources[g] = { stale: r.stale, fetched_at: r.fetched_at, cache: r.cache };
    if (r.error) body.sources[g].error = r.error;
    if (r.stale) anyStale = true;
    var t = r.fetched_at ? Date.parse(r.fetched_at) : 0;
    if (isFinite(t) && t > newest) newest = t;
  }

  body.stale = anyStale;
  body.updated_at = new Date(newest || Date.now()).toISOString();
  return jsonRes(body, 200, corsH);
}

// ===== メインハンドラー =====
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },
};

async function handleRequest(request, env) {
  var url = new URL(request.url);
  var origin = request.headers.get("Origin") || "";
  var corsH = getCorsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: isOauthOrMcpPath(url.pathname) ? OAUTH_CORS : corsH });
  }

  // ===== 認証（マジックリンク + Bearerセッション） =====
  if (url.pathname === "/api/auth/request-link" && request.method === "POST") {
    return handleAuthRequestLink(request, env, corsH);
  }
  if (url.pathname === "/api/auth/verify" && request.method === "GET") {
    return handleAuthVerify(request, env);
  }
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    return handleAuthMe(request, env, corsH);
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    return handleAuthLogout(request, env, corsH);
  }

  // 以降の保護ルートはこの authEmail のみを信頼する
  // （クライアント申告の X-Customer-Email / body.email は使わない）
  var authEmail = await getSessionEmail(request, env);

  // ===== Stripe Webhook =====
  if (url.pathname === "/stripe-webhook" && request.method === "POST") {
    var rawBody = await request.text();
    var sig = request.headers.get("stripe-signature") || "";
    var valid = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) return new Response("Invalid signature", { status: 400 });

    try {
      var evt = JSON.parse(rawBody);
      var sub = evt.data.object;
      var whEmail = (sub.metadata && sub.metadata.email) ? sub.metadata.email : (sub.customer_email || "");
      var priceId = (sub.items && sub.items.data && sub.items.data[0]) ? sub.items.data[0].price.id : "";

      var whPlan = "none";
      if (priceId === "price_1TGWRtCr8aAPWdNlgoCuJsYi") whPlan = "light";
      else if (priceId === "price_1TGWU0Cr8aAPWdNlZIKivWfc") whPlan = "standard";
      else if (priceId === "price_1TGWVHCr8aAPWdNlxx2Yg39Q") whPlan = "full";

      if (whEmail) {
        if (evt.type === "customer.subscription.created" || evt.type === "customer.subscription.updated") {
          await env.SUBSCRIPTIONS.put(whEmail, whPlan);
        } else if (evt.type === "customer.subscription.deleted") {
          await env.SUBSCRIPTIONS.delete(whEmail);
        }
      }
    } catch (e) {
      console.error("Webhook parse error:", e.message);
    }
    return new Response("OK", { status: 200 });
  }

  // =========================================================
  // GET /api/vision-board/board — ボードデータ取得
  // =========================================================
  if (url.pathname === "/api/vision-board/board" && request.method === "GET") {
    var vbGetEmail = authEmail || "";
    if (!vbGetEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    var vbGetPlan = await env.SUBSCRIPTIONS.get(vbGetEmail);
    if (!vbGetPlan) return jsonRes({ error: "subscription_required" }, 403, corsH);
    if (!planMeetsRequirement(vbGetPlan, "standard")) {
      return jsonRes({ error: "plan_upgrade_required", required: "standard", current: vbGetPlan }, 403, corsH);
    }
    try {
      var vbBoardStr = await env.SUBSCRIPTIONS.get("vision_board_" + vbGetEmail);
      return jsonRes({ board: vbBoardStr ? JSON.parse(vbBoardStr) : { cards: [] } }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Failed to load board", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // GET /api/board — スレッド一覧取得（認証不要）
  // =========================================================
  if (url.pathname === "/api/board" && request.method === "GET") {
    var bCat = url.searchParams.get("category") || "all";
    try {
      var bIdxStr = await env.SUBSCRIPTIONS.get("board:index");
      var bList = bIdxStr ? JSON.parse(bIdxStr) : [];
      if (bCat !== "all") bList = bList.filter(function(t) { return t.category === bCat; });
      return jsonRes({ threads: bList }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Failed to load board", detail: err.message }, 500, corsH);
    }
  }

  // GET /api/board/:id — スレッド詳細取得（認証不要）
  if (request.method === "GET" && /^\/api\/board\/[^/]+$/.test(url.pathname)) {
    var bgId = url.pathname.split("/")[3];
    try {
      var bgStr = await env.SUBSCRIPTIONS.get("board:thread:" + bgId);
      if (!bgStr) return jsonRes({ error: "not_found" }, 404, corsH);
      return jsonRes({ thread: JSON.parse(bgStr) }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Failed to load thread", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // GET /api/vision-board/image — R2から画像を返す（公開URLなしでWorker経由配信）
  // =========================================================
  if (url.pathname === "/api/vision-board/image" && request.method === "GET") {
    if (!env.VISION_R2) return new Response("R2 not configured", { status: 503, headers: corsH });
    var vbImgKey = url.searchParams.get("key");
    if (!vbImgKey) return new Response("key required", { status: 400, headers: corsH });
    var vbImgObj = await env.VISION_R2.get(vbImgKey);
    if (!vbImgObj) return new Response("Not found", { status: 404, headers: corsH });
    var vbImgType = (vbImgObj.httpMetadata && vbImgObj.httpMetadata.contentType) || "image/png";
    return new Response(vbImgObj.body, {
      headers: Object.assign({}, corsH, {
        "Content-Type": vbImgType,
        "Cache-Control": "public, max-age=31536000, immutable",
      }),
    });
  }

  // =========================================================
  // GET /api/history — セッション履歴取得（Fullプラン専用）
  // =========================================================
  if (url.pathname === "/api/history" && request.method === "GET") {
    var histEmail = authEmail || "";
    var histAppId = url.searchParams.get("app_id") || "plant-doctor";
    var histLimit = parseInt(url.searchParams.get("limit") || "5");
    if (!histEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    var histPlan = await env.SUBSCRIPTIONS.get(histEmail);
    if (!histPlan) return jsonRes({ error: "subscription_required" }, 403, corsH);
    if (!planMeetsRequirement(histPlan, "full")) {
      return jsonRes({ error: "plan_upgrade_required", required: "full", current: histPlan }, 403, corsH);
    }
    try {
      var sessions = await getHistory(histEmail, histAppId, histLimit, env);
      return jsonRes({ sessions: sessions }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Failed to load history", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // DELETE /api/history — セッション履歴削除（Fullプラン専用）
  // =========================================================
  if (url.pathname === "/api/history" && request.method === "DELETE") {
    var delEmail = authEmail || "";
    var delId = url.searchParams.get("id") || "";
    if (!delEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    if (!delId) return jsonRes({ error: "id is required" }, 400, corsH);
    var delPlan = await env.SUBSCRIPTIONS.get(delEmail);
    if (!delPlan) return jsonRes({ error: "subscription_required" }, 403, corsH);
    if (!planMeetsRequirement(delPlan, "full")) {
      return jsonRes({ error: "plan_upgrade_required", required: "full", current: delPlan }, 403, corsH);
    }
    try {
      var delPath = "/app_sessions?id=eq." + encodeURIComponent(delId) +
                   "&user_id=eq." + encodeURIComponent(delEmail);
      var delRes = await supabaseRequest("DELETE", delPath, null, env);
      if (!delRes.ok) {
        return jsonRes({ error: "Failed to delete", detail: await delRes.text() }, delRes.status, corsH);
      }
      return jsonRes({ success: true }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
  }

  // DELETE /api/board/:id — スレッド削除（管理者=全件、ユーザー=自分のみ）
  if (request.method === "DELETE" && /^\/api\/board\/[^/]+$/.test(url.pathname)) {
    var bdEmail = authEmail || "";
    var bdId = url.pathname.split("/")[3];
    if (!bdEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    var bdPlan = await env.SUBSCRIPTIONS.get(bdEmail);
    if (!bdPlan) return jsonRes({ error: "subscription_required" }, 403, corsH);
    try {
      var bdThreadStr = await env.SUBSCRIPTIONS.get("board:thread:" + bdId);
      if (!bdThreadStr) return jsonRes({ error: "not_found" }, 404, corsH);
      var bdThread = JSON.parse(bdThreadStr);
      if (!isAdmin(bdEmail) && bdThread.authorEmail !== bdEmail) {
        return jsonRes({ error: "forbidden" }, 403, corsH);
      }
      await env.SUBSCRIPTIONS.delete("board:thread:" + bdId);
      var bdIdxStr = await env.SUBSCRIPTIONS.get("board:index");
      var bdIdx = bdIdxStr ? JSON.parse(bdIdxStr) : [];
      bdIdx = bdIdx.filter(function(t) { return t.id !== bdId; });
      await env.SUBSCRIPTIONS.put("board:index", JSON.stringify(bdIdx));
      return jsonRes({ success: true }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Failed to delete", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // GET /api/dreams — 夢日記の一覧取得（Standardプラン以上）
  // KVキー: dreams:{email} → JSON配列（新しい順・最大30件）
  // ※ userId=メール。保存キーは認証済みメールから導出し、他人の夢を読めないようにする
  // =========================================================
  if (url.pathname === "/api/dreams" && request.method === "GET") {
    var dreamGetEmail = authEmail || "";
    if (!dreamGetEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    var dreamGetPlan = await env.SUBSCRIPTIONS.get(dreamGetEmail);
    if (!dreamGetPlan) return jsonRes({ error: "subscription_required" }, 403, corsH);
    if (!planMeetsRequirement(dreamGetPlan, "standard")) {
      return jsonRes({ error: "plan_upgrade_required", required: "standard", current: dreamGetPlan }, 403, corsH);
    }
    try {
      var dreamGetRaw = await env.SUBSCRIPTIONS.get("dreams:" + dreamGetEmail);
      var dreamGetList = dreamGetRaw ? JSON.parse(dreamGetRaw) : [];
      return jsonRes({ entries: dreamGetList }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Failed to load dreams", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // DELETE /api/dreams?id=... — 夢日記の1件削除（Standardプラン以上）
  // ※ 仕様書はGET/PUTのみだが、UIの「この夢を消す」を永続化するため追加
  // =========================================================
  if (url.pathname === "/api/dreams" && request.method === "DELETE") {
    var dreamDelEmail = authEmail || "";
    var dreamDelId = url.searchParams.get("id") || "";
    if (!dreamDelEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    if (!dreamDelId) return jsonRes({ error: "id is required" }, 400, corsH);
    var dreamDelPlan = await env.SUBSCRIPTIONS.get(dreamDelEmail);
    if (!dreamDelPlan) return jsonRes({ error: "subscription_required" }, 403, corsH);
    if (!planMeetsRequirement(dreamDelPlan, "standard")) {
      return jsonRes({ error: "plan_upgrade_required", required: "standard", current: dreamDelPlan }, 403, corsH);
    }
    try {
      var dreamDelRaw = await env.SUBSCRIPTIONS.get("dreams:" + dreamDelEmail);
      var dreamDelList = dreamDelRaw ? JSON.parse(dreamDelRaw) : [];
      var dreamDelNext = dreamDelList.filter(function (e) { return String(e.id) !== String(dreamDelId); });
      await env.SUBSCRIPTIONS.put("dreams:" + dreamDelEmail, JSON.stringify(dreamDelNext));
      return jsonRes({ success: true, entries: dreamDelNext }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Failed to delete dream", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // GET /legal/tokushoho — 特定商取引法に基づく表記
  // =========================================================
  if (url.pathname === "/legal/tokushoho" && request.method === "GET") {
    return htmlRes(TOKUSHOHO_HTML);
  }

  // =========================================================
  // GET /legal/privacy — プライバシーポリシー
  // =========================================================
  if (url.pathname === "/legal/privacy" && request.method === "GET") {
    return htmlRes(PRIVACY_HTML);
  }

  // =========================================================
  // GET /market/prices — マーケット時価チェッカー（Standardプラン以上）
  // 4ジャンル（貴金属／為替／暗号資産／エネルギー）をKVキャッシュ経由でまとめて返す
  // =========================================================
  if (url.pathname === "/market/prices" && request.method === "GET") {
    var mktEmail = authEmail || "";
    if (!mktEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    var mktPlan = await env.SUBSCRIPTIONS.get(mktEmail);
    if (!mktPlan) return jsonRes({ error: "subscription_required" }, 403, corsH);
    if (!planMeetsRequirement(mktPlan, "standard")) {
      return jsonRes({ error: "plan_upgrade_required", required: "standard", current: mktPlan }, 403, corsH);
    }
    try {
      return await handleMarketPrices(env, corsH);
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // /mcp — とむSYSTEM MCPサーバー (JSON-RPC 2.0、GETはサーバー情報を返す)
  // =========================================================
  if (url.pathname === "/mcp") {
    return handleMcp(request, env);
  }

  // =========================================================
  // OAuth2 / PKCE — Claude.ai Webコネクタ向け (?token= 認証と並存)
  // =========================================================
  if (url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration") {
    return handleOauthMetadata(request, env, OAUTH_CORS);
  }
  if (url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    return handleOauthProtectedResource(request, env, OAUTH_CORS);
  }
  if (url.pathname === "/register" && request.method === "POST") {
    return handleOauthRegister(request, env, OAUTH_CORS);
  }
  if (url.pathname === "/oauth/authorize" && (request.method === "GET" || request.method === "POST")) {
    return handleOauthAuthorize(request, env);
  }
  if (url.pathname === "/oauth/token" && request.method === "POST") {
    return handleOauthToken(request, env, OAUTH_CORS);
  }

  if (request.method !== "POST") {
    return jsonRes({ error: "Method not allowed" }, 405, corsH);
  }

  // =========================================================
  // POST /hair-sim — ヘアーシミュレーター用（dall-e-2 edits）
  // =========================================================
  if (url.pathname === "/hair-sim") {
    var hairEmail = authEmail || "";
    var hairCheck = await checkPlanAndCount(hairEmail, "standard", env);
    if (!hairCheck.ok) {
      return jsonRes({ error: hairCheck.error, required: hairCheck.required, current: hairCheck.current, limit: hairCheck.limit }, hairCheck.status, corsH);
    }

    if (!env.OPENAI_API_KEY) {
      return jsonRes({ error: "OpenAI API key not configured" }, 500, corsH);
    }

    try {
      var hairForm = await request.formData();
      var hairImage = hairForm.get("image");
      var hairMask  = hairForm.get("mask");
      var hairLength  = hairForm.get("length")  || "";
      var hairTexture = hairForm.get("texture") || "";
      var hairColor   = hairForm.get("color")   || "";
      var hairCustom  = hairForm.get("customPrompt") || "";

      console.log("[hair-sim] image:", hairImage ? hairImage.size + "bytes" : "null");
      console.log("[hair-sim] mask:", hairMask ? hairMask.size + "bytes" : "null");
      console.log("[hair-sim] length:", hairLength || "empty");
      console.log("[hair-sim] texture:", hairTexture || "empty");
      console.log("[hair-sim] color:", hairColor || "empty");

      if (!hairImage || (!hairLength && !hairTexture)) {
        return jsonRes({
          error: "image and at least one of length or texture are required",
          debug: {
            hasImage: !!hairImage,
            imageSize: hairImage ? hairImage.size : null,
            length: hairLength,
            texture: hairTexture,
          }
        }, 400, corsH);
      }

      // プロンプト構築：顔・背景を変えないことを明示
      var hairParts = [];
      if (hairLength)  hairParts.push(hairLength);
      if (hairTexture) hairParts.push(hairTexture);
      if (hairColor)   hairParts.push(hairColor);
      if (hairCustom)  hairParts.push(hairCustom);
      var hairDesc = hairParts.length > 0 ? hairParts.join(", ") : "natural hair";

      var hairPrompt =
        "Portrait photo retouching: change ONLY the hairstyle to " + hairDesc + ". " +
        "Preserve exactly: the person's face shape, eyes, nose, mouth, skin tone, " +
        "facial expression, age appearance, and identity. " +
        "Preserve exactly: background, lighting, clothing, shoulders and below. " +
        "Only the hair region above the forehead should change. " +
        "Output must look like the identical person after a hair salon visit.";

      console.log("[hair-sim] prompt:", hairPrompt);

      var hairBuf = await hairImage.arrayBuffer();
      var hairBlob = new Blob([new Uint8Array(hairBuf)], { type: "image/png" });

      var oaiForm = new FormData();
      oaiForm.append("model", "gpt-image-1.5");
      oaiForm.append("image", hairBlob, "image.png");

      if (hairMask) {
        var maskBuf = await hairMask.arrayBuffer();
        var maskBlob = new Blob([new Uint8Array(maskBuf)], { type: "image/png" });
        oaiForm.append("mask", maskBlob, "mask.png");
      }

      oaiForm.append("prompt", hairPrompt);
      oaiForm.append("n", "1");
      oaiForm.append("size", "1024x1024");

      var oaiRes = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY },
        body: oaiForm,
      });

      var oaiData = await oaiRes.json();
      console.log("[hair-sim] OpenAI status:", oaiRes.status);
      console.log('[hair-sim] oaiData:', JSON.stringify(oaiData));

      if (oaiData.error) {
        return jsonRes({
          error: oaiData.error.message,
          openai_error: oaiData.error,
        }, oaiRes.status, corsH);
      }

      // data[0]の中身を確認
      const imageData = oaiData.data?.[0];
      const imageUrl = imageData?.url;
      const imageB64 = imageData?.b64_json;

      let base64;
      if (imageB64) {
        // b64_jsonで返ってきた場合はそのまま使う
        base64 = imageB64;
      } else if (imageUrl) {
        // urlで返ってきた場合はfetchしてbase64に変換
        const imageRes = await fetch(imageUrl);
        const imageBuffer = await imageRes.arrayBuffer();
        const uint8 = new Uint8Array(imageBuffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < uint8.length; i += chunkSize) {
          binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
        }
        base64 = btoa(binary);
      } else {
        return jsonRes({ error: 'no image data', detail: JSON.stringify(imageData) }, 500, corsH);
      }

      return jsonRes({ image_base64: base64 }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message, stack: err.stack }, 500, corsH);
    }
  }

  // =========================================================
  // POST /api/vision-board/upload-image — 画像アップロード (multipart)
  // =========================================================
  if (url.pathname === "/api/vision-board/upload-image") {
    var vbUpEmail = authEmail || "";
    console.log("[upload-image] email:", vbUpEmail, "origin:", origin);
    var vbUpCheck = await checkPlanAndCount(vbUpEmail, "standard", env);
    if (!vbUpCheck.ok) {
      return jsonRes({ error: vbUpCheck.error, required: vbUpCheck.required, current: vbUpCheck.current, limit: vbUpCheck.limit }, vbUpCheck.status, corsH);
    }
    try {
      var vbUpForm = await request.formData();
      var vbUpFile = vbUpForm.get("file");
      var vbUpCardId = vbUpForm.get("cardId") || ("card_" + Date.now());

      console.log("[upload-image] file:", vbUpFile ? (vbUpFile.name + " " + vbUpFile.size + "bytes type=" + vbUpFile.type) : "null", "cardId:", vbUpCardId);

      if (!vbUpFile) return jsonRes({ error: "file is required", hint: "FormDataのkeyを'file'にしてください" }, 400, corsH);
      if (vbUpFile.size > 5 * 1024 * 1024) return jsonRes({ error: "file too large (max 5MB)", size: vbUpFile.size }, 400, corsH);

      var vbUpType = vbUpFile.type;
      // ファイルタイプ未設定時はファイル名拡張子から推定
      if (!vbUpType && vbUpFile.name) {
        var vbUpNameL = vbUpFile.name.toLowerCase();
        if (vbUpNameL.endsWith(".jpg") || vbUpNameL.endsWith(".jpeg")) vbUpType = "image/jpeg";
        else if (vbUpNameL.endsWith(".png")) vbUpType = "image/png";
        else if (vbUpNameL.endsWith(".webp")) vbUpType = "image/webp";
      }
      var vbUpExt = "png";
      if (vbUpType === "image/jpeg") vbUpExt = "jpg";
      else if (vbUpType === "image/webp") vbUpExt = "webp";
      else if (vbUpType !== "image/png") return jsonRes({ error: "unsupported file type. Use JPEG, PNG, or WebP", received_type: vbUpType, file_name: vbUpFile.name }, 400, corsH);

      var vbUpBuf = await vbUpFile.arrayBuffer();

      if (env.VISION_R2) {
        var vbUpKey = encodeURIComponent(vbUpEmail) + "/" + vbUpCardId + "." + vbUpExt;
        await env.VISION_R2.put(vbUpKey, vbUpBuf, { httpMetadata: { contentType: vbUpType } });
        var vbUpImgUrl = new URL(request.url).origin + "/api/vision-board/image?key=" + encodeURIComponent(vbUpKey);
        return jsonRes({ imageUrl: vbUpImgUrl }, 200, corsH);
      } else {
        // R2未設定時: base64 data URLで返す（ローカルテスト用）
        var vbUpBytes = new Uint8Array(vbUpBuf);
        var vbUpBin = "";
        var vbUpChunk = 8192;
        for (var vi = 0; vi < vbUpBytes.length; vi += vbUpChunk) {
          vbUpBin += String.fromCharCode.apply(null, vbUpBytes.subarray(vi, vi + vbUpChunk));
        }
        return jsonRes({ imageUrl: "data:" + vbUpType + ";base64," + btoa(vbUpBin) }, 200, corsH);
      }
    } catch (err) {
      return jsonRes({ error: "Upload failed", detail: err.message }, 500, corsH);
    }
  }

  if (!env.ANTHROPIC_API_KEY) {
    return jsonRes({ error: "API key not configured" }, 500, corsH);
  }

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonRes({ error: "Invalid JSON" }, 400, corsH);
  }

  // =========================================================
  // POST /api/history — セッション保存（Fullプラン専用）
  // =========================================================
  if (url.pathname === "/api/history" && request.method === "POST") {
    var histSaveEmail = authEmail || "";
    var histSaveAppId = body.app_id || "";
    var histSaveData = body.session_data;
    if (!histSaveEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    if (!histSaveAppId || !histSaveData) return jsonRes({ error: "app_id and session_data are required" }, 400, corsH);
    var histSavePlan = await env.SUBSCRIPTIONS.get(histSaveEmail);
    if (!histSavePlan) return jsonRes({ error: "subscription_required" }, 403, corsH);
    if (!planMeetsRequirement(histSavePlan, "full")) {
      return jsonRes({ error: "plan_upgrade_required", required: "full", current: histSavePlan }, 403, corsH);
    }
    try {
      await saveSession(histSaveEmail, histSaveAppId, histSaveData, env);
      return jsonRes({ success: true }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // PUT /api/dreams — 夢日記を1件保存（Standardプラン以上・直近30件でtrim）
  // body: { userId, entry }  KVキー: dreams:{email}
  // =========================================================
  if (url.pathname === "/api/dreams" && request.method === "PUT") {
    var dreamPutEmail = authEmail || "";
    if (!dreamPutEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    var dreamPutPlan = await env.SUBSCRIPTIONS.get(dreamPutEmail);
    if (!dreamPutPlan) return jsonRes({ error: "subscription_required" }, 403, corsH);
    if (!planMeetsRequirement(dreamPutPlan, "standard")) {
      return jsonRes({ error: "plan_upgrade_required", required: "standard", current: dreamPutPlan }, 403, corsH);
    }
    var dreamEntry = body.entry;
    if (!dreamEntry || typeof dreamEntry !== "object") return jsonRes({ error: "entry is required" }, 400, corsH);
    try {
      if (!dreamEntry.id) dreamEntry.id = Date.now();
      var dreamPutRaw = await env.SUBSCRIPTIONS.get("dreams:" + dreamPutEmail);
      var dreamPutList = dreamPutRaw ? JSON.parse(dreamPutRaw) : [];
      // 同一idは差し替え、新しい順に並べ、直近30件でtrim
      var dreamPutNext = [dreamEntry].concat(
        dreamPutList.filter(function (e) { return String(e.id) !== String(dreamEntry.id); })
      ).slice(0, 30);
      await env.SUBSCRIPTIONS.put("dreams:" + dreamPutEmail, JSON.stringify(dreamPutNext));
      return jsonRes({ success: true, entries: dreamPutNext }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Failed to save dream", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // POST /api/board — スレッド作成（認証必須、お知らせ=管理者のみ）
  // =========================================================
  if (url.pathname === "/api/board") {
    var nbEmail = authEmail || "";
    if (!nbEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    var nbPlan = await env.SUBSCRIPTIONS.get(nbEmail);
    if (!nbPlan) return jsonRes({ error: "subscription_required" }, 403, corsH);

    var nbTitle = (body.title || "").trim();
    var nbBody = (body.body || "").trim();
    var nbCat = body.category || "その他";
    var VALID_CATS = ["お知らせ", "バグ報告", "機能要望", "その他"];

    if (!nbTitle || !nbBody) return jsonRes({ error: "title and body are required" }, 400, corsH);
    if (VALID_CATS.indexOf(nbCat) === -1) return jsonRes({ error: "invalid category" }, 400, corsH);
    if (nbCat === "お知らせ" && !isAdmin(nbEmail)) {
      return jsonRes({ error: "admin_required", message: "お知らせカテゴリは管理者のみ投稿できます" }, 403, corsH);
    }

    var nbId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var nbNow = new Date().toISOString();
    var nbThread = { id: nbId, title: nbTitle, body: nbBody, category: nbCat, authorEmail: nbEmail, createdAt: nbNow, replies: [] };

    await env.SUBSCRIPTIONS.put("board:thread:" + nbId, JSON.stringify(nbThread));

    var nbIdxStr = await env.SUBSCRIPTIONS.get("board:index");
    var nbIdx = nbIdxStr ? JSON.parse(nbIdxStr) : [];
    nbIdx.unshift({ id: nbId, title: nbTitle, category: nbCat, authorEmail: nbEmail, createdAt: nbNow, replyCount: 0 });
    if (nbIdx.length > 200) nbIdx = nbIdx.slice(0, 200);
    await env.SUBSCRIPTIONS.put("board:index", JSON.stringify(nbIdx));

    return jsonRes({ success: true, thread: nbThread }, 200, corsH);
  }

  // =========================================================
  // POST /api/board/:id/reply — 返信投稿（認証必須）
  // =========================================================
  if (/^\/api\/board\/[^/]+\/reply$/.test(url.pathname)) {
    var rpEmail = authEmail || "";
    if (!rpEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    var rpPlan = await env.SUBSCRIPTIONS.get(rpEmail);
    if (!rpPlan) return jsonRes({ error: "subscription_required" }, 403, corsH);

    var rpBody = (body.body || "").trim();
    if (!rpBody) return jsonRes({ error: "body is required" }, 400, corsH);

    var rpThreadId = url.pathname.split("/")[3];
    var rpThreadStr = await env.SUBSCRIPTIONS.get("board:thread:" + rpThreadId);
    if (!rpThreadStr) return jsonRes({ error: "not_found" }, 404, corsH);

    var rpThread = JSON.parse(rpThreadStr);
    var rpReplyId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var rpNow = new Date().toISOString();
    var rpReply = { id: rpReplyId, body: rpBody, authorEmail: rpEmail, createdAt: rpNow };
    rpThread.replies.push(rpReply);

    await env.SUBSCRIPTIONS.put("board:thread:" + rpThreadId, JSON.stringify(rpThread));

    var rpIdxStr = await env.SUBSCRIPTIONS.get("board:index");
    var rpIdx = rpIdxStr ? JSON.parse(rpIdxStr) : [];
    rpIdx = rpIdx.map(function(t) {
      if (t.id === rpThreadId) t.replyCount = rpThread.replies.length;
      return t;
    });
    await env.SUBSCRIPTIONS.put("board:index", JSON.stringify(rpIdx));

    return jsonRes({ success: true, reply: rpReply }, 200, corsH);
  }

  // =========================================================
  // POST /api/vision-board/board — ボードデータ保存
  // =========================================================
  if (url.pathname === "/api/vision-board/board") {
    var vbSaveEmail = authEmail || "";
    if (!vbSaveEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    var vbSavePlan = await env.SUBSCRIPTIONS.get(vbSaveEmail);
    if (!vbSavePlan) return jsonRes({ error: "subscription_required" }, 403, corsH);
    if (!planMeetsRequirement(vbSavePlan, "standard")) {
      return jsonRes({ error: "plan_upgrade_required", required: "standard", current: vbSavePlan }, 403, corsH);
    }
    var vbSaveBoard = body.board;
    if (!vbSaveBoard) return jsonRes({ error: "board data required" }, 400, corsH);
    try {
      await env.SUBSCRIPTIONS.put("vision_board_" + vbSaveEmail, JSON.stringify(vbSaveBoard));
      return jsonRes({ success: true }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Failed to save board", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // POST /api/vision-board/chat — AIチャット（プロンプト生成含む）
  // =========================================================
  if (url.pathname === "/api/vision-board/chat") {
    var vbChatEmail = authEmail || "";
    var vbChatMessages = body.messages;
    var vbChatMode = body.mode || "chat";

    if (!Array.isArray(vbChatMessages) || vbChatMessages.length === 0) {
      return jsonRes({ error: "messages array is required" }, 400, corsH);
    }

    var vbChatCheck = await checkPlanAndCount(vbChatEmail, "standard", env);
    if (!vbChatCheck.ok) {
      return jsonRes({ error: vbChatCheck.error, required: vbChatCheck.required, current: vbChatCheck.current, limit: vbChatCheck.limit }, vbChatCheck.status, corsH);
    }

    var vbChatSystem, vbChatMaxTokens, vbChatMessagesToSend;
    if (vbChatMode === "generate_prompt") {
      vbChatSystem = "あなたは画像生成プロンプト変換AIです。会話の内容を元に gpt-image-1.5 用の英語プロンプトを生成します。必ず {\"prompt\": \"...\"} のJSON形式のみ返してください。他の文字・説明・質問は一切含めないこと。";
      vbChatMaxTokens = 300;
      // 会話履歴の末尾に「今すぐJSON出力」を命令するuserメッセージを追加
      vbChatMessagesToSend = vbChatMessages.concat([{
        role: "user",
        content: "上記の会話を元に、今すぐ画像生成プロンプトをJSON形式で出力してください。{\"prompt\": \"英語プロンプト\"} の形式のみ返すこと。"
      }]);
    } else {
      vbChatSystem = "あなたはビジョンボード用の画像プロンプト生成アシスタントです。ユーザーが「こんな画像が欲しい」と言ったら、どんな雰囲気か（明るい・落ち着いた・神秘的など）、スタイル（リアル・イラスト・水彩など）、色のトーンを会話で引き出してください。日本語で自然に会話してください。150文字以内で応答してください。Markdownを使わず普通のテキストで返答してください。";
      vbChatMaxTokens = 200;
      vbChatMessagesToSend = vbChatMessages;
    }

    try {
      var vbChatApiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: vbChatMaxTokens,
          system: vbChatSystem,
          messages: vbChatMessagesToSend,
        }),
      });
      if (!vbChatApiRes.ok) {
        return jsonRes({ error: "Anthropic API error", detail: await vbChatApiRes.text() }, vbChatApiRes.status, corsH);
      }
      var vbChatData = await vbChatApiRes.json();
      var vbChatText = (vbChatData.content && vbChatData.content[0]) ? vbChatData.content[0].text : "";

      if (vbChatMode === "generate_prompt") {
        try {
          var vbClean = vbChatText.replace(/```json|```/g, "").trim();
          var vbParsed = JSON.parse(vbClean);
          return jsonRes({ prompt: vbParsed.prompt || vbClean }, 200, corsH);
        } catch (e) {
          return jsonRes({ prompt: vbChatText.replace(/```json|```/g, "").trim() }, 200, corsH);
        }
      } else {
        return jsonRes({ reply: vbChatText }, 200, corsH);
      }
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // POST /api/vision-board/generate-image — AI画像生成 → R2保存
  // =========================================================
  if (url.pathname === "/api/vision-board/generate-image") {
    var vbGenEmail = authEmail || "";
    var vbGenPrompt = body.prompt;
    var vbGenCardId = body.cardId || ("card_" + Date.now());

    console.log("[generate-image] email:", vbGenEmail, "promptLen:", vbGenPrompt ? vbGenPrompt.length : 0, "cardId:", vbGenCardId);

    // 認証チェックをpromptチェックより先に実施
    var vbGenCheck = await checkPlanAndCount(vbGenEmail, "standard", env);
    if (!vbGenCheck.ok) {
      return jsonRes({ error: vbGenCheck.error, required: vbGenCheck.required, current: vbGenCheck.current, limit: vbGenCheck.limit }, vbGenCheck.status, corsH);
    }

    if (!vbGenPrompt) return jsonRes({ error: "prompt is required", received_keys: Object.keys(body) }, 400, corsH);

    if (!env.OPENAI_API_KEY) {
      return jsonRes({ error: "OpenAI API key not configured" }, 500, corsH);
    }

    try {
      var vbGenOaiRes = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.OPENAI_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt: vbGenPrompt,
          n: 1,
          size: "1024x1024",
        }),
      });

      var vbGenOaiData = await vbGenOaiRes.json();
      if (vbGenOaiData.error) {
        return jsonRes({ error: vbGenOaiData.error.message, openai_error: vbGenOaiData.error }, vbGenOaiRes.status, corsH);
      }

      var vbGenImgData = vbGenOaiData.data && vbGenOaiData.data[0];
      if (!vbGenImgData) return jsonRes({ error: "No image data returned" }, 500, corsH);

      var vbGenBytes;
      if (vbGenImgData.b64_json) {
        var vbGenBin = atob(vbGenImgData.b64_json);
        vbGenBytes = new Uint8Array(vbGenBin.length);
        for (var vgi = 0; vgi < vbGenBin.length; vgi++) vbGenBytes[vgi] = vbGenBin.charCodeAt(vgi);
      } else if (vbGenImgData.url) {
        var vbGenFetch = await fetch(vbGenImgData.url);
        vbGenBytes = new Uint8Array(await vbGenFetch.arrayBuffer());
      } else {
        return jsonRes({ error: "No image data", detail: JSON.stringify(vbGenImgData) }, 500, corsH);
      }

      if (env.VISION_R2) {
        var vbGenKey = encodeURIComponent(vbGenEmail) + "/" + vbGenCardId + ".png";
        await env.VISION_R2.put(vbGenKey, vbGenBytes.buffer, { httpMetadata: { contentType: "image/png" } });
        var vbGenImgUrl = new URL(request.url).origin + "/api/vision-board/image?key=" + encodeURIComponent(vbGenKey);
        return jsonRes({ imageUrl: vbGenImgUrl }, 200, corsH);
      } else {
        // R2未設定時: base64 data URLで返す（ローカルテスト用）
        var vbGenB64out = "";
        var vbGenChunk = 8192;
        for (var vgj = 0; vgj < vbGenBytes.length; vgj += vbGenChunk) {
          vbGenB64out += String.fromCharCode.apply(null, vbGenBytes.subarray(vgj, vgj + vbGenChunk));
        }
        return jsonRes({ imageUrl: "data:image/png;base64," + btoa(vbGenB64out) }, 200, corsH);
      }
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // POST /api/plant-diagnose — 植物診断アプリ用（Standardプラン以上・履歴機能はFullプラン専用）
  // =========================================================
  if (url.pathname === "/api/plant-diagnose") {
    var plantEmail = authEmail || "";
    var plantCheck = await checkPlanAndCount(plantEmail, "standard", env);
    if (!plantCheck.ok) {
      return jsonRes({ error: plantCheck.error, required: plantCheck.required, current: plantCheck.current, limit: plantCheck.limit }, plantCheck.status, corsH);
    }
    var plantIsFull = planMeetsRequirement(plantCheck.plan, "full");

    try {
      // 過去3件の診断履歴を取得してシステムプロンプトに注入（Fullプランのみ）
      var plantHistory = plantIsFull ? await getHistory(plantEmail, "plant-doctor", 3, env) : [];
      var plantBody = Object.assign({}, body);
      if (plantHistory.length > 0) {
        var historyLines = plantHistory.map(function(h, i) {
          var sd = h.session_data || {};
          return "診断" + (i + 1) + "（" + new Date(h.created_at).toLocaleDateString("ja-JP") + "）: " +
            (sd.plantName || "不明") + " / 状態: " + (sd.overallLabel || sd.overallStatus || "不明") +
            (sd.overallAdvice ? " / " + sd.overallAdvice.slice(0, 60) + "…" : "");
        }).join("\n");
        plantBody.system = (plantBody.system || "") +
          "\n\n【このユーザーの過去の診断履歴】\n" + historyLines +
          "\n継続的なケアの観点から、前回の状態と比較しながらアドバイスしてください。";
      }

      var plantRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(plantBody),
      });
      if (!plantRes.ok) {
        return jsonRes({ error: "Anthropic API error", detail: await plantRes.text() }, plantRes.status, corsH);
      }

      var plantText = await plantRes.text();

      // 診断結果をパースしてSupabaseに保存（Fullプランのみ）
      if (plantIsFull) {
      try {
        var plantData = JSON.parse(plantText);
        var rawResult = (plantData.content || []).map(function(b) { return b.text || ""; }).join("");
        var stripped = rawResult.replace(/```json|```/g, "").trim();
        var jStart = stripped.indexOf("{");
        var jEnd = stripped.lastIndexOf("}");
        if (jStart !== -1 && jEnd !== -1) {
          var parsedDiag = JSON.parse(stripped.slice(jStart, jEnd + 1));
          await saveSession(plantEmail, "plant-doctor", {
            plantName: parsedDiag.plantName,
            overallStatus: parsedDiag.overallStatus,
            overallLabel: parsedDiag.overallLabel,
            overallAdvice: parsedDiag.overallAdvice,
            items: parsedDiag.items,
            diagnosedAt: new Date().toISOString(),
          }, env);
        }
      } catch (saveErr) {
        console.error("Session save error:", saveErr.message);
      }
      }

      return new Response(plantText, {
        status: 200,
        headers: Object.assign({}, corsH, { "Content-Type": "application/json" }),
      });
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // POST /api/yama-calendar — 山の暦（月齢×カレンダー農作業提案）
  // =========================================================
  if (url.pathname === "/api/yama-calendar") {
    return handleYamaCalendar(request, corsH, env, authEmail);
  }

  // =========================================================
  // POST /api/advisor/:name — 士業アドバイザー統合（Fullプラン専用）
  // body: { mode: "general"|"pro", messages, stream }
  // systemプロンプトは ADVISOR_APPS で管理し、クライアントからは受け取らない。
  // 旧 /api/{name}-advisor も互換エイリアスとして受ける（旧フロントの system は無視、
  // mode は旧フロントの唯一の信号である max_tokens>=2000 から専門家モードを推定する）。
  // =========================================================
  var advMatch = url.pathname.match(/^\/api\/advisor\/([a-z-]+)$/) || url.pathname.match(/^\/api\/([a-z-]+)-advisor$/);
  if (advMatch) {
    var advPrompts = ADVISOR_APPS[advMatch[1]];
    if (!advPrompts) {
      return jsonRes({ error: "unknown_advisor" }, 404, corsH);
    }

    var advMode = (body.mode === "pro" || (!body.mode && (body.max_tokens || 0) >= 2000)) ? "pro" : "general";

    var advMessages = body.messages;
    if (!Array.isArray(advMessages) || advMessages.length === 0 || advMessages.length > ADVISOR_MESSAGES_MAX_COUNT) {
      return jsonRes({ error: "invalid_messages" }, 400, corsH);
    }
    var advTotalChars = 0;
    for (var advI = 0; advI < advMessages.length; advI++) {
      var advMsg = advMessages[advI];
      if (!advMsg || (advMsg.role !== "user" && advMsg.role !== "assistant") ||
          typeof advMsg.content !== "string" || advMsg.content.length === 0) {
        return jsonRes({ error: "invalid_messages" }, 400, corsH);
      }
      advTotalChars += advMsg.content.length;
    }
    if (advTotalChars > ADVISOR_MESSAGES_MAX_CHARS) {
      return jsonRes({ error: "messages_too_long", limit: ADVISOR_MESSAGES_MAX_CHARS }, 400, corsH);
    }

    var advCheck = await checkPlanAndCount(authEmail, "full", env);
    if (!advCheck.ok) {
      return jsonRes({ error: advCheck.error, required: advCheck.required, current: advCheck.current, limit: advCheck.limit }, advCheck.status, corsH);
    }

    return await anthropicChat(env, corsH, {
      system: advPrompts[advMode],
      messages: advMessages,
      max_tokens: ADVISOR_MAX_TOKENS[advMode],
      stream: body.stream === true,
      model: "claude-opus-4-8",
    });
  }

  // =========================================================
  // POST /mystic-bridge — MYSTIC MCPサーバーブリッジ
  // =========================================================
  if (url.pathname === "/mystic-bridge") {
    var mysticTool = body.tool;
    var mysticArgs = body.arguments || {};

    var MYSTIC_TOOLS = [
      "star_reading", "tarot_draw", "numerology", "lucky_color", "oracle_message",
      "past_life", "guardian_star", "dream_reading", "compatibility", "soul_mission",
      "moon_journal", "aura_reading", "chakra_check", "power_stone", "angel_number",
      "spirit_animal", "mandala_reading", "rune_reading", "i_ching", "biorhythm",
      "celtic_cross", "yearly_forecast", "monthly_fortune", "love_oracle", "career_reading",
      "health_energy", "wealth_flow", "mercury_retrograde", "numerology_name", "cosmic_timing"
    ];
    if (!mysticTool || MYSTIC_TOOLS.indexOf(mysticTool) === -1) {
      return jsonRes({ error: "invalid tool. allowed: " + MYSTIC_TOOLS.join(", ") }, 400, corsH);
    }

    try {
      var mcpRes = await env.MYSTIC.fetch("https://mystic-system-worker/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: mysticTool,
            arguments: mysticArgs,
          },
        }),
      });

      var mcpText = await mcpRes.text();
      var mcpData;
      try {
        mcpData = JSON.parse(mcpText);
      } catch (e) {
        return jsonRes({ error: "MYSTIC MCP returned non-JSON", status: mcpRes.status, detail: mcpText }, 502, corsH);
      }

      if (mcpData.error) {
        return jsonRes({ error: "MYSTIC MCP error", detail: mcpData.error }, mcpRes.status, corsH);
      }

      return jsonRes(mcpData.result !== undefined ? mcpData.result : mcpData, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // POST /flyer-scan — チラシスキャナー（Standardプラン）
  // =========================================================
  if (url.pathname === "/flyer-scan") {
    var fsEmail = authEmail || "";
    var fsCheck = await checkPlanAndCount(fsEmail, "standard", env);
    if (!fsCheck.ok) {
      return jsonRes({ error: fsCheck.error, required: fsCheck.required, current: fsCheck.current, limit: fsCheck.limit }, fsCheck.status, corsH);
    }

    var fsImage = body.image;
    var fsMediaType = body.media_type || "image/jpeg";
    var fsMode = body.mode || "full";

    if (!fsImage) return jsonRes({ error: "image は必須です" }, 400, corsH);

    var FLYER_PROMPTS = {
      full: "このチラシ画像から以下の情報を抽出して日本語で答えてください：\n\n1. 📅 日付・期間\n2. 🏪 店舗名・場所\n3. 🛒 目玉商品・特売内容（上位5点）\n4. 🍽️ このチラシの特売品を使ったおすすめ献立を1つ提案してください（材料と簡単な作り方も）\n\n情報が読み取れない場合はその旨を教えてください。",
      menu: "このチラシの特売品を使ったおすすめ献立を2〜3つ提案してください。\n材料と簡単な作り方も含めて日本語で答えてください。",
      items: "このチラシ画像から特売品・目玉商品を抽出してください。\n商品名、価格（分かれば）、セール情報を箇条書きで日本語で答えてください。",
    };

    var fsPrompt = FLYER_PROMPTS[fsMode] || FLYER_PROMPTS.full;

    try {
      var fsApiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 1024,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: fsMediaType, data: fsImage },
                },
                { type: "text", text: fsPrompt },
              ],
            },
          ],
        }),
      });
      if (!fsApiRes.ok) {
        var fsErr = await fsApiRes.json().catch(function() { return {}; });
        return jsonRes({ error: (fsErr.error && fsErr.error.message) || ("Anthropic API error: " + fsApiRes.status) }, 502, corsH);
      }
      var fsData = await fsApiRes.json();
      var fsResult = (fsData.content || []).map(function(b) { return b.text || ""; }).join("");
      return jsonRes({ result: fsResult }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Worker error: " + err.message }, 500, corsH);
    }
  }

  // =========================================================
  // POST /api/chat — Standard/Full アプリ用
  // =========================================================
  if (url.pathname === "/api/chat") {
    var system = body.system;
    var messages = body.messages;
    var chatEmail = authEmail || "";
    var maxTokens = Math.min(body.max_tokens || 1000, 2000);

    if (!system || !messages || !Array.isArray(messages) || messages.length === 0) {
      return jsonRes({ error: "system and messages are required" }, 400, corsH);
    }

    var chatCheck = await checkPlanAndCount(chatEmail, "standard", env);
    if (!chatCheck.ok) {
      return jsonRes({ error: chatCheck.error, required: chatCheck.required, current: chatCheck.current, limit: chatCheck.limit }, chatCheck.status, corsH);
    }

    return await anthropicChat(env, corsH, { system: system, messages: messages, max_tokens: maxTokens, stream: body.stream === true });
  }

  // =========================================================
  // POST / — Light アプリ用 (既存・変更なし)
  // =========================================================
  var appType = body.appType;
  var input = body.input;
  var extra = body.extra || {};
  var lightEmail = authEmail || "";

  if (!appType || !input) {
    return jsonRes({ error: "appType and input are required" }, 400, corsH);
  }

  // ping — プラン確認のみ
  if (appType === "ping") {
    if (!lightEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    var pingPlan = await env.SUBSCRIPTIONS.get(lightEmail);
    if (!pingPlan) return jsonRes({ error: "subscription_required" }, 403, corsH);
    return jsonRes({ ok: true, plan: pingPlan }, 200, corsH);
  }

  var lightCheck = await checkPlanAndCount(lightEmail, "light", env);
  if (!lightCheck.ok) {
    return jsonRes({ error: lightCheck.error, limit: lightCheck.limit }, lightCheck.status, corsH);
  }

  try {
    var lightRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: getMaxTokens(appType),
        system: getSystemPrompt(appType, extra),
        messages: [{ role: "user", content: input }],
      }),
    });
    if (!lightRes.ok) {
      return jsonRes({ error: "Anthropic API error", detail: await lightRes.text() }, lightRes.status, corsH);
    }
    var lightData = await lightRes.json();
    var text = (lightData.content && lightData.content[0]) ? lightData.content[0].text : "";
    return jsonRes({ result: text }, 200, corsH);
  } catch (err) {
    return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
  }
}
