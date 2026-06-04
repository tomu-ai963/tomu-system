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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Customer-Email",
    "Vary": "Origin",
  };
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

async function handleYamaCalendar(request, corsH, env) {
  var email = request.headers.get("X-Customer-Email") || request.headers.get("X-User-Email") || "";
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
        model: "claude-sonnet-4-6",
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
        model: "claude-haiku-4-5-20251001",
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
  var mcpUrl = new URL(request.url);
  var token = request.headers.get("MCP-Token") || mcpUrl.searchParams.get("token") || "";
  if (!env.MCP_TOKEN || token !== env.MCP_TOKEN) {
    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: null,
      error: { code: -32001, message: "Unauthorized" }
    }), { status: 401, headers: { "Content-Type": "application/json" } });
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
  var h = { "Content-Type": "application/json" };

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
    return new Response(null, { headers: corsH });
  }

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
    var vbGetEmail = request.headers.get("X-Customer-Email") || url.searchParams.get("email") || "";
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

  // DELETE /api/board/:id — スレッド削除（管理者=全件、ユーザー=自分のみ）
  if (request.method === "DELETE" && /^\/api\/board\/[^/]+$/.test(url.pathname)) {
    var bdEmail = (request.headers.get("X-Customer-Email") || "").toLowerCase();
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

  if (request.method !== "POST") {
    return jsonRes({ error: "Method not allowed" }, 405, corsH);
  }

  // =========================================================
  // POST /hair-sim — ヘアーシミュレーター用（dall-e-2 edits）
  // =========================================================
  if (url.pathname === "/hair-sim") {
    var hairEmail = request.headers.get("X-Customer-Email") || "";
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
  // POST /mcp — とむSYSTEM MCPサーバー (JSON-RPC 2.0)
  // =========================================================
  if (url.pathname === "/mcp") {
    return handleMcp(request, env);
  }

  // =========================================================
  // POST /send-email — Resend メール送信
  // =========================================================
  if (url.pathname === "/send-email") {
    var emailBody;
    try {
      emailBody = await request.json();
    } catch (e) {
      return jsonRes({ error: "Invalid JSON" }, 400, corsH);
    }
    var sendTo = emailBody.to;
    var sendSubject = emailBody.subject;
    var sendHtml = emailBody.html;
    if (!sendTo || !sendSubject || !sendHtml) {
      return jsonRes({ error: "to, subject, html are required" }, 400, corsH);
    }
    if (!env.RESEND_API_KEY) {
      return jsonRes({ error: "RESEND_API_KEY not configured" }, 500, corsH);
    }
    try {
      var resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.RESEND_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "onboarding@resend.dev",
          to: Array.isArray(sendTo) ? sendTo : [sendTo],
          subject: sendSubject,
          html: sendHtml,
        }),
      });
      var resendData = await resendRes.json();
      if (!resendRes.ok) {
        return jsonRes({ error: "Resend API error", detail: resendData }, resendRes.status, corsH);
      }
      return jsonRes({ success: true, id: resendData.id }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // POST /api/vision-board/upload-image — 画像アップロード (multipart)
  // =========================================================
  if (url.pathname === "/api/vision-board/upload-image") {
    var vbUpEmail = request.headers.get("X-Customer-Email") || "";
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

      if (env.VISION_R2 && env.VISION_R2_BASE_URL) {
        var vbUpKey = encodeURIComponent(vbUpEmail) + "/" + vbUpCardId + ".png";
        await env.VISION_R2.put(vbUpKey, vbUpBuf, { httpMetadata: { contentType: vbUpType } });
        return jsonRes({ imageUrl: env.VISION_R2_BASE_URL + "/" + vbUpKey }, 200, corsH);
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
  // POST /api/board — スレッド作成（認証必須、お知らせ=管理者のみ）
  // =========================================================
  if (url.pathname === "/api/board") {
    var nbEmail = (request.headers.get("X-Customer-Email") || body.email || "").toLowerCase();
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
    var rpEmail = (request.headers.get("X-Customer-Email") || body.email || "").toLowerCase();
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
    var vbSaveEmail = body.email;
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
    var vbChatEmail = body.email;
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
          model: "claude-haiku-4-5-20251001",
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
    // emailはJSON bodyまたはX-Customer-Emailヘッダーから取得（upload-imageと同じ認証パターンに対応）
    var vbGenEmail = body.email || request.headers.get("X-Customer-Email") || "";
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

      if (env.VISION_R2 && env.VISION_R2_BASE_URL) {
        var vbGenKey = encodeURIComponent(vbGenEmail) + "/" + vbGenCardId + ".png";
        await env.VISION_R2.put(vbGenKey, vbGenBytes.buffer, { httpMetadata: { contentType: "image/png" } });
        return jsonRes({ imageUrl: env.VISION_R2_BASE_URL + "/" + vbGenKey }, 200, corsH);
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
  // POST /api/plant-diagnose — 植物診断アプリ用（認証スキップ）
  // =========================================================
  if (url.pathname === "/api/plant-diagnose") {
    try {
      var plantRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      if (!plantRes.ok) {
        return jsonRes({ error: "Anthropic API error", detail: await plantRes.text() }, plantRes.status, corsH);
      }
      return new Response(await plantRes.text(), {
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
    return handleYamaCalendar(request, corsH, env);
  }

  // =========================================================
  // POST /api/tax-advisor — 税務アドバイザー（Fullプラン専用）
  // =========================================================
  if (url.pathname === "/api/tax-advisor") {
    var taxEmail = body.email;
    var taxSystem = body.system;
    var taxMessages = body.messages;
    var taxMaxTokens = Math.min(body.max_tokens || 1000, 2000);

    if (!taxSystem || !taxMessages || !Array.isArray(taxMessages) || taxMessages.length === 0) {
      return jsonRes({ error: "system and messages are required" }, 400, corsH);
    }

    var taxCheck = await checkPlanAndCount(taxEmail, "full", env);
    if (!taxCheck.ok) {
      return jsonRes({ error: taxCheck.error, required: taxCheck.required, current: taxCheck.current, limit: taxCheck.limit }, taxCheck.status, corsH);
    }

    try {
      var taxRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: taxMaxTokens,
          system: taxSystem,
          messages: taxMessages,
        }),
      });
      if (!taxRes.ok) {
        return jsonRes({ error: "Anthropic API error", detail: await taxRes.text() }, taxRes.status, corsH);
      }
      return new Response(await taxRes.text(), {
        status: 200,
        headers: Object.assign({}, corsH, { "Content-Type": "application/json" }),
      });
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // POST /api/legal-advisor — 法律アドバイザー（Fullプラン専用）
  // =========================================================
  if (url.pathname === "/api/legal-advisor") {
    var legalEmail = body.email;
    var legalSystem = body.system;
    var legalMessages = body.messages;
    var legalMaxTokens = Math.min(body.max_tokens || 1000, 2000);

    if (!legalSystem || !legalMessages || !Array.isArray(legalMessages) || legalMessages.length === 0) {
      return jsonRes({ error: "system and messages are required" }, 400, corsH);
    }

    var legalCheck = await checkPlanAndCount(legalEmail, "full", env);
    if (!legalCheck.ok) {
      return jsonRes({ error: legalCheck.error, required: legalCheck.required, current: legalCheck.current, limit: legalCheck.limit }, legalCheck.status, corsH);
    }

    try {
      var legalRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: legalMaxTokens,
          system: legalSystem,
          messages: legalMessages,
        }),
      });
      if (!legalRes.ok) {
        return jsonRes({ error: "Anthropic API error", detail: await legalRes.text() }, legalRes.status, corsH);
      }
      return new Response(await legalRes.text(), {
        status: 200,
        headers: Object.assign({}, corsH, { "Content-Type": "application/json" }),
      });
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // POST /api/gyosei-advisor — 行政書士アドバイザー（Fullプラン専用）
  // =========================================================
  if (url.pathname === "/api/gyosei-advisor") {
    var gyoseiEmail = body.email;
    var gyoseiSystem = body.system;
    var gyoseiMessages = body.messages;
    var gyoseiMaxTokens = Math.min(body.max_tokens || 1000, 2000);

    if (!gyoseiSystem || !gyoseiMessages || !Array.isArray(gyoseiMessages) || gyoseiMessages.length === 0) {
      return jsonRes({ error: "system and messages are required" }, 400, corsH);
    }

    var gyoseiCheck = await checkPlanAndCount(gyoseiEmail, "full", env);
    if (!gyoseiCheck.ok) {
      return jsonRes({ error: gyoseiCheck.error, required: gyoseiCheck.required, current: gyoseiCheck.current, limit: gyoseiCheck.limit }, gyoseiCheck.status, corsH);
    }

    try {
      var gyoseiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: gyoseiMaxTokens,
          system: gyoseiSystem,
          messages: gyoseiMessages,
        }),
      });
      if (!gyoseiRes.ok) {
        return jsonRes({ error: "Anthropic API error", detail: await gyoseiRes.text() }, gyoseiRes.status, corsH);
      }
      return new Response(await gyoseiRes.text(), {
        status: 200,
        headers: Object.assign({}, corsH, { "Content-Type": "application/json" }),
      });
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // POST /api/sharoshi-advisor — 社労士アドバイザー（Fullプラン専用）
  // =========================================================
  if (url.pathname === "/api/sharoshi-advisor") {
    var sharoshiEmail = body.email;
    var sharoshiSystem = body.system;
    var sharoshiMessages = body.messages;
    var sharoshiMaxTokens = Math.min(body.max_tokens || 1000, 2000);

    if (!sharoshiSystem || !sharoshiMessages || !Array.isArray(sharoshiMessages) || sharoshiMessages.length === 0) {
      return jsonRes({ error: "system and messages are required" }, 400, corsH);
    }

    var sharoshiCheck = await checkPlanAndCount(sharoshiEmail, "full", env);
    if (!sharoshiCheck.ok) {
      return jsonRes({ error: sharoshiCheck.error, required: sharoshiCheck.required, current: sharoshiCheck.current, limit: sharoshiCheck.limit }, sharoshiCheck.status, corsH);
    }

    try {
      var sharoshiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: sharoshiMaxTokens,
          system: sharoshiSystem,
          messages: sharoshiMessages,
        }),
      });
      if (!sharoshiRes.ok) {
        return jsonRes({ error: "Anthropic API error", detail: await sharoshiRes.text() }, sharoshiRes.status, corsH);
      }
      return new Response(await sharoshiRes.text(), {
        status: 200,
        headers: Object.assign({}, corsH, { "Content-Type": "application/json" }),
      });
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // POST /api/benrishi-advisor — 弁理士アドバイザー（Fullプラン専用）
  // =========================================================
  if (url.pathname === "/api/benrishi-advisor") {
    var benrishiEmail = body.email;
    var benrishiSystem = body.system;
    var benrishiMessages = body.messages;
    var benrishiMaxTokens = Math.min(body.max_tokens || 1000, 2000);

    if (!benrishiSystem || !benrishiMessages || !Array.isArray(benrishiMessages) || benrishiMessages.length === 0) {
      return jsonRes({ error: "system and messages are required" }, 400, corsH);
    }

    var benrishiCheck = await checkPlanAndCount(benrishiEmail, "full", env);
    if (!benrishiCheck.ok) {
      return jsonRes({ error: benrishiCheck.error, required: benrishiCheck.required, current: benrishiCheck.current, limit: benrishiCheck.limit }, benrishiCheck.status, corsH);
    }

    try {
      var benrishiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: benrishiMaxTokens,
          system: benrishiSystem,
          messages: benrishiMessages,
        }),
      });
      if (!benrishiRes.ok) {
        return jsonRes({ error: "Anthropic API error", detail: await benrishiRes.text() }, benrishiRes.status, corsH);
      }
      return new Response(await benrishiRes.text(), {
        status: 200,
        headers: Object.assign({}, corsH, { "Content-Type": "application/json" }),
      });
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
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
    var fsEmail = request.headers.get("X-Customer-Email") || "";
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
          model: "claude-haiku-4-5-20251001",
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
    var chatEmail = body.email;
    var maxTokens = Math.min(body.max_tokens || 1000, 2000);

    if (!system || !messages || !Array.isArray(messages) || messages.length === 0) {
      return jsonRes({ error: "system and messages are required" }, 400, corsH);
    }

    var chatCheck = await checkPlanAndCount(chatEmail, "standard", env);
    if (!chatCheck.ok) {
      return jsonRes({ error: chatCheck.error, required: chatCheck.required, current: chatCheck.current, limit: chatCheck.limit }, chatCheck.status, corsH);
    }

    try {
      var chatRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: maxTokens,
          system: system,
          messages: messages,
        }),
      });
      if (!chatRes.ok) {
        return jsonRes({ error: "Anthropic API error", detail: await chatRes.text() }, chatRes.status, corsH);
      }
      return new Response(await chatRes.text(), {
        status: 200,
        headers: Object.assign({}, corsH, { "Content-Type": "application/json" }),
      });
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message }, 500, corsH);
    }
  }

  // =========================================================
  // POST / — Light アプリ用 (既存・変更なし)
  // =========================================================
  var appType = body.appType;
  var input = body.input;
  var extra = body.extra || {};
  var lightEmail = body.email;

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
