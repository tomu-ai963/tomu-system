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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Customer-Email",
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

      var hairPrompt = [
        "Change ONLY the hairstyle to: " + hairDesc + ".",
        "CRITICAL RULES — do NOT change any of the following:",
        "- The person's face, facial features, skin tone, expression, or identity.",
        "- The background, lighting, clothing, or any non-hair elements.",
        "- The overall composition and framing of the photo.",
        "Apply the new hairstyle naturally as if the person visited a hair salon.",
        "The result must look like the same real person with a new hairstyle only.",
      ].join(" ");

      console.log("[hair-sim] prompt:", hairPrompt);

      var hairBuf = await hairImage.arrayBuffer();
      var hairBlob = new Blob([new Uint8Array(hairBuf)], { type: "image/png" });

      var oaiForm = new FormData();
      oaiForm.append("model", "gpt-image-1");
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

      if (oaiData.error) {
        return jsonRes({
          error: oaiData.error.message,
          openai_error: oaiData.error,
        }, oaiRes.status, corsH);
      }

      return jsonRes({ image_url: oaiData.data[0].url }, 200, corsH);
    } catch (err) {
      return jsonRes({ error: "Worker error", detail: err.message, stack: err.stack }, 500, corsH);
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
