/**
 * とむSYSTEM — Cloudflare Worker (API Proxy + Stripe Webhook)
 * 環境変数: ANTHROPIC_API_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY
 * KV: SUBSCRIPTIONS
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Customer-Email",
};

// ===== 日次リクエスト制限 =====
const DAILY_LIMITS = { light: 50, standard: 200, full: 500 };

// ===== システムプロンプト定義 =====
function getSystemPrompt(appType, extra = {}) {
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
      return `あなたは「心のデトックス」のAIです。ユーザーの感情を否定せず、そのまま受け取り、${extra.tone || "やさしく"}寄り添ってください。共感を軸に200〜300文字で応答し、最後に「---」の後に1文の詩的なアファーメーションを添えてください。`;
    case "rapid-reply":
      return `あなたは『爆速メール返信』のAIです。受信メールの要点と返信の方向性（${extra.direction || "承諾"}）を受け取り、失礼がなく簡潔な返信文を2文程度で作成してください。件名は不要です。本文のみ出力してください。`;
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
  const map = {
    "praise": 200, "lunch": 150, "future-letter": 250,
    "three-tasks": 200, "lucky-action": 150, "kokoro_detox": 350,
    "rapid-reply": 200, "book-log": 100, "english": 150, "dinner": 150,
  };
  return map[appType] || 300;
}

// ===== Stripe署名検証 =====
async function verifyStripeSignature(body, signature, secret) {
  const parts = signature.split(",");
  const timestamp = parts.find(p => p.startsWith("t="))?.split("=")[1];
  const sig = parts.find(p => p.startsWith("v1="))?.split("=")[1];
  if (!timestamp || !sig) return false;

  const payload = `${timestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(signed)).map(b => b.toString(16).padStart(2, "0")).join("");
  return hex === sig;
}

// ===== メインハンドラー =====
export default {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // ===== Stripe Webhook =====
    if (url.pathname === "/stripe-webhook" && request.method === "POST") {
      const body = await request.text();
      const signature = request.headers.get("stripe-signature") || "";

      const valid = await verifyStripeSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
      if (!valid) {
        return new Response("Invalid signature", { status: 400 });
      }

      try {
        const event = JSON.parse(body);
        const subscription = event.data.object;
        const email = subscription.metadata?.email || subscription.customer_email || "";
        const priceId = subscription.items?.data?.[0]?.price?.id || "";

        let plan = "none";
        if (priceId === "price_1TGWRtCr8aAPWdNlgoCuJsYi") plan = "light";
        else if (priceId === "price_1TGWU0Cr8aAPWdNlZIKivWfc") plan = "standard";
        else if (priceId === "price_1TGWVHCr8aAPWdNlxx2Yg39Q") plan = "full";

        if (email) {
          if (
            event.type === "customer.subscription.created" ||
            event.type === "customer.subscription.updated"
          ) {
            await env.SUBSCRIPTIONS.put(email, plan);
          } else if (event.type === "customer.subscription.deleted") {
            await env.SUBSCRIPTIONS.delete(email);
          }
        }
      } catch (e) {
        // パース失敗してもStripeには200を返す（リトライ防止）
        console.error("Webhook parse error:", e.message);
      }

      return new Response("OK", { status: 200 });
    }

    // ===== AIプロキシ =====
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "API key not configured" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const { appType, input, extra = {}, email } = body;

    if (!appType || !input) {
      return new Response(JSON.stringify({ error: "appType and input are required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // ===== サブスク確認 =====
    if (!email) {
      return new Response(JSON.stringify({ error: "login_required" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const plan = await env.SUBSCRIPTIONS.get(email);
    if (!plan) {
      return new Response(JSON.stringify({ error: "subscription_required" }), {
        status: 403,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // ===== pingはplanを返して早期リターン =====
    if (appType === "ping") {
      return new Response(JSON.stringify({ ok: true, plan }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // ===== 日次リクエスト制限チェック =====
    const today = new Date().toISOString().slice(0, 10); // "2026-03-31"
    const countKey = `count:${email}:${today}`;
    const currentCount = parseInt(await env.SUBSCRIPTIONS.get(countKey) || "0");
    const limit = DAILY_LIMITS[plan] ?? 50;

    if (currentCount >= limit) {
      return new Response(JSON.stringify({ error: "daily_limit_exceeded", limit }), {
        status: 429,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // カウントアップ（24時間で自動削除）
    await env.SUBSCRIPTIONS.put(countKey, String(currentCount + 1), {
      expirationTtl: 86400,
    });

    // ===== Anthropic API =====
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
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

      if (!response.ok) {
        const err = await response.text();
        return new Response(JSON.stringify({ error: "Anthropic API error", detail: err }), {
          status: response.status,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      const data = await response.json();
      const text = data.content?.[0]?.text ?? "";

      return new Response(JSON.stringify({ result: text }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: "Worker error", detail: err.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
  }
};
