/**
 * coord-ai Worker 追加コード
 *
 * 既存の orange-sound-354b Worker に /coord-ai エンドポイントを追加する。
 *
 * ===== マージ手順 =====
 * 1. Cloudflare ダッシュボード または curl で既存 Worker コードを取得
 * 2. 既存の fetch ハンドラ内に、ルーティング分岐を追加：
 *
 *   // 既存コードの先頭付近（他のルートと同列に）:
 *   if (url.pathname === '/coord-ai') return handleCoordAI(request, env);
 *
 * 3. この handleCoordAI 関数を Worker コードに追加
 * 4. curl でデプロイ（下記 README.md 参照）
 *
 * ===== CORS ヘッダー =====
 * Access-Control-Allow-Origin: https://tomu-ai963.github.io
 * Access-Control-Allow-Methods: POST, OPTIONS
 * Access-Control-Allow-Headers: Content-Type
 */

const COORD_AI_CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://tomu-ai963.github.io',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * /coord-ai エンドポイントハンドラ
 * @param {Request} request
 * @param {Object} env  - env.ANTHROPIC_API_KEY が必要
 */
async function handleCoordAI(request, env) {
  // OPTIONS プリフライト
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: COORD_AI_CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...COORD_AI_CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...COORD_AI_CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const { images, situation, season, weather } = body;

  if (!images || images.length === 0) {
    return new Response(JSON.stringify({ error: 'images required' }), {
      status: 400,
      headers: { ...COORD_AI_CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  if (!situation) {
    return new Response(JSON.stringify({ error: 'situation required' }), {
      status: 400,
      headers: { ...COORD_AI_CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Anthropic API 向けのコンテンツブロックを構築
  const contentBlocks = [];

  // カテゴリ名の日本語マッピング
  const categoryLabel = {
    tops: 'トップス',
    bottoms: 'ボトムス',
    outer: 'アウター',
    accessory: 'アクセサリー',
    shoes: '靴',
    unspecified: 'アイテム',
  };

  images.forEach((img, idx) => {
    const label = categoryLabel[img.category] || 'アイテム';
    contentBlocks.push({ type: 'text', text: `[写真 ${idx + 1}: ${label}]` });
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType || 'image/jpeg',
        data: img.data,
      },
    });
  });

  // シチュエーション情報をテキストで付加
  let situationText = `\nシチュエーション: ${situation}`;
  if (season) situationText += `\n季節: ${season}`;
  if (weather) situationText += `\n天気: ${weather}`;
  situationText += '\n\n上記の服・小物の写真を見て、このシチュエーションに合う最適なコーディネートをアドバイスしてください。';
  contentBlocks.push({ type: 'text', text: situationText });

  const anthropicPayload = {
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system:
      'あなたはファッションコーディネーターのAIです。\nユーザーがアップロードした服・小物の写真と、行く場所・シチュエーションを見て、\n手持ちのアイテムの中から最適なコーディネートをアドバイスしてください。\n- 具体的にどのアイテムとどのアイテムを合わせると良いか\n- その組み合わせが良い理由\n- 改善点や小物の足し方のアドバイス\nを日本語で答えてください。',
    messages: [{ role: 'user', content: contentBlocks }],
  };

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicPayload),
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Anthropic API unreachable', detail: String(err) }), {
      status: 502,
      headers: { ...COORD_AI_CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text().catch(() => '');
    return new Response(JSON.stringify({ error: 'Anthropic API error', detail: errText }), {
      status: 502,
      headers: { ...COORD_AI_CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const anthropicData = await anthropicRes.json();
  const advice = anthropicData?.content?.[0]?.text || '';

  return new Response(JSON.stringify({ advice }), {
    status: 200,
    headers: { ...COORD_AI_CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
