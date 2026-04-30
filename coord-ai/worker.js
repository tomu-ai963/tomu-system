/**
 * とむSYSTEM — Cloudflare Worker (API Proxy + Stripe Webhook)
 * 環境変数: ANTHROPIC_API_KEY, STRIPE_WEBHOOK_SECRET
 * KV バインディング: SUBSCRIPTIONS
 *
 * エンドポイント:
 *   POST /               — Light アプリ用 (appType + input)
 *   POST /api/chat       — Standard/Full アプリ用 (system + messages を自由指定)
 *   POST /api/plant-diagnose — 植物診断アプリ用（認証スキップ）
 *   POST /coord-ai       — Coord AI（コーデ提案）Standard以上
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Customer-Email, X-User-Id, X-User-Plan",
    "Vary": "Origin",
  };
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
      return "あなたは1年後のユーザー自身です。今日の努力や頑張りを聞いて、未来の自分として感謝と励ましのメッセージを届けてください。情緒的で温かく、200文字以内で返してください。";
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
      return "あなたは『10秒英会話』のAIです。ユーザーが指定したシチュエーションに合わせて、今すぐ使える英語フレーズを1つだけ提示してください。フレーズ、日本語訳、カタカナ発音の3点セットで返してください。";
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

async function checkPlanAndCount(email, requiredPlan) {
  if (!email) return { ok: false, status: 401, error: "login_required" };

  var plan = await SUBSCRIPTIONS.get(email);
  if (!plan) return { ok: false, status: 403, error: "subscription_required" };

  if (!planMeetsRequirement(plan, requiredPlan)) {
    return { ok: false, status: 403, error: "plan_upgrade_required", required: requiredPlan, current: plan };
  }

  var today = new Date().toISOString().slice(0, 10);
  var countKey = "count:" + email + ":" + today;
  var currentCount = parseInt(await SUBSCRIPTIONS.get(countKey) || "0");
  var limit = DAILY_LIMITS[plan] || 50;

  if (currentCount >= limit) {
    return { ok: false, status: 429, error: "daily_limit_exceeded", limit: limit };
  }

  await SUBSCRIPTIONS.put(countKey, String(currentCount + 1), { expirationTtl: 86400 });
  return { ok: true, plan: plan };
}

function jsonRes(data, status, corsH) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({}, corsH, { "Content-Type": "application/json" }),
  });
}

// ===== Coord AI ハンドラー =====
async function handleCoordAI(request, corsH) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonRes({ error: "Invalid JSON" }, 400, corsH);
  }

  var images = body.images;
  var situation = body.situation;
  var season = body.season || "";
  var weather = body.weather || "";
  var email = body.email || "";

  // バリデーション
  if (!images || !Array.isArray(images) || images.length === 0) {
    return jsonRes({ error: "images は1枚以上必要です" }, 400, corsH);
  }
  if (!situation) {
    return jsonRes({ error: "situation は必須です" }, 400, corsH);
  }

  // プラン認証（standard以上）
  var check = await checkPlanAndCount(email, "standard");
  if (!check.ok) {
    return jsonRes({
      error: check.error,
      required: check.required,
      current: check.current,
      limit: check.limit
    }, check.status, corsH);
  }

  // カテゴリ日本語マッピング
  var categoryLabel = {
    "tops": "トップス",
    "bottoms": "ボトムス",
    "outer": "アウター",
    "accessory": "アクセサリー",
    "shoes": "シューズ",
    "unspecified": "アイテム",
  };

  // Anthropic API メッセージ構築
  var content = [];

  // 画像を追加
  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    var label = categoryLabel[img.category] || "アイテム";
    content.push({
      type: "text",
      text: "【" + label + "】",
    });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType || "image/jpeg",
        data: img.data,
      },
    });
  }

  // シチュエーションテキストを追加
  var textPrompt = "上記のアイテムを使って、以下の条件に合ったコーディネートをアドバイスしてください。\n\n";
  textPrompt += "【シチュエーション】" + situation + "\n";
  if (season) textPrompt += "【季節】" + season + "\n";
  if (weather) textPrompt += "【天気】" + weather + "\n";

  content.push({ type: "text", text: textPrompt });

  try {
    var anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 1024,
        system: "あなたはファッションコーディネーターのAIです。ユーザーがアップロードした服・小物の写真と、行く場所・シチュエーションを見て、手持ちのアイテムの中から最適なコーディネートをアドバイスしてください。\n- 具体的にどのアイテムとどのアイテムを合わせると良いか\n- その組み合わせが良い理由\n- あれば改善点や小物の足し方のアドバイス\nを日本語で答えてください。",
        messages: [{ role: "user", content: content }],
      }),
    });

    if (!anthropicRes.ok) {
      var errText = await anthropicRes.text();
      console.error("Anthropic API error:", errText);
      return jsonRes({ error: "API連携エラーが発生しました" }, 500, corsH);
    }

    var anthropicData = await anthropicRes.json();
    var advice = (anthropicData.content && anthropicData.content[0])
      ? anthropicData.content[0].text
      : "";

    return jsonRes({ advice: advice }, 200, corsH);

  } catch (err) {
    console.error("Coord AI error:", err.message);
    return jsonRes({ error: "サーバーエラーが発生しました" }, 500, corsH);
  }
}

// ===== メインハンドラー =====
addEventListener("fetch", function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
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
    var valid = await verifyStripeSignature(rawBody, sig, STRIPE_WEBHOOK_SECRET);
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
          await SUBSCRIPTIONS.put(whEmail, whPlan);
        } else if (evt.type === "customer.subscription.deleted") {
          await SUBSCRIPTIONS.delete(whEmail);
        }
      }
    } catch (e) {
      console.error("Webhook parse error:", e.message);
    }
    return new Response("OK", { status: 200 });
  }

  if (request.method !== "POST") {
    return jsonRes({ error: "Method not allowed" }, 405, corsH);
  }

  if (!ANTHROPIC_API_KEY) {
    return jsonRes({ error: "API key not configured" }, 500, corsH);
  }

  // =========================================================
  // POST /coord-ai — Coord AI（コーデ提案）Standard以上
  // =========================================================
  if (url.pathname === "/coord-ai") {
    return handleCoordAI(request, corsH);
  }

  // =========================================================
  // POST /api/plant-diagnose — 植物診断アプリ用（認証スキップ）
  // =========================================================
  if (url.pathname === "/api/plant-diagnose") {
    var plantBody;
    try {
      plantBody = await request.json();
    } catch (e) {
      return jsonRes({ error: "Invalid JSON" }, 400, corsH);
    }
    try {
      var plantRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(plantBody),
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
  // POST /api/chat — Standard/Full アプリ用
  // =========================================================
  if (url.pathname === "/api/chat") {
    var chatBody;
    try {
      chatBody = await request.json();
    } catch (e) {
      return jsonRes({ error: "Invalid JSON" }, 400, corsH);
    }

    var system = chatBody.system;
    var messages = chatBody.messages;
    var chatEmail = chatBody.email;
    var maxTokens = Math.min(chatBody.max_tokens || 1000, 2000);

    if (!system || !messages || !Array.isArray(messages) || messages.length === 0) {
      return jsonRes({ error: "system and messages are required" }, 400, corsH);
    }

    var chatCheck = await checkPlanAndCount(chatEmail, "standard");
    if (!chatCheck.ok) {
      return jsonRes({ error: chatCheck.error, required: chatCheck.required, current: chatCheck.current, limit: chatCheck.limit }, chatCheck.status, corsH);
    }

    try {
      var chatRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
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
  var lightBody;
  try {
    lightBody = await request.json();
  } catch (e) {
    return jsonRes({ error: "Invalid JSON" }, 400, corsH);
  }

  var appType = lightBody.appType;
  var input = lightBody.input;
  var extra = lightBody.extra || {};
  var lightEmail = lightBody.email;

  if (!appType || !input) {
    return jsonRes({ error: "appType and input are required" }, 400, corsH);
  }

  // ping — プラン確認のみ
  if (appType === "ping") {
    if (!lightEmail) return jsonRes({ error: "login_required" }, 401, corsH);
    var pingPlan = await SUBSCRIPTIONS.get(lightEmail);
    if (!pingPlan) return jsonRes({ error: "subscription_required" }, 403, corsH);
    return jsonRes({ ok: true, plan: pingPlan }, 200, corsH);
  }

  var lightCheck = await checkPlanAndCount(lightEmail, "light");
  if (!lightCheck.ok) {
    return jsonRes({ error: lightCheck.error, limit: lightCheck.limit }, lightCheck.status, corsH);
  }

  try {
    var lightRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
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
