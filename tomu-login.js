/**
 * tomu-login.js — とむSYSTEM 共通認証モジュール v1.0
 * 使い方: <script src="../tomu-login.js"></script> を</body>直前に追加
 * 各アプリのfetch呼び出しでemailを渡すには TomuAuth.getEmail() を使う
 */

(function () {
  const WORKER_URL = 'https://orange-sound-354b.inverted-triangle-leef.workers.dev/';  const STORAGE_KEY = 'tomu_email';
  const STRIPE_LINKS = {
    light:    'https://buy.stripe.com/3cI00i8nQf5Sd1c3T58Zq01',
    standard: 'https://buy.stripe.com/8x214mcE6f5S2my1KX8Zq02',
    full:     'https://buy.stripe.com/3cIcN4dIag9W2my4X98Zq03',
  };

  // ============================================================
  // CSS インジェクション
  // ============================================================
  const style = document.createElement('style');
  style.textContent = `
    /* ===== とむSYSTEM ログインオーバーレイ ===== */
    #tomu-auth-overlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 10000;
      background: rgba(26,22,18,0.72);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    #tomu-auth-overlay.active { display: flex; }

    #tomu-auth-modal {
      background: #f7f3ee;
      border: 1px solid #ddd5c8;
      border-radius: 24px;
      padding: 48px 40px 40px;
      width: 100%;
      max-width: 420px;
      position: relative;
      box-shadow: 0 32px 80px rgba(26,22,18,0.18);
      animation: tomuModalIn 0.3s cubic-bezier(0.16,1,0.3,1);
    }

    @keyframes tomuModalIn {
      from { opacity:0; transform: translateY(16px) scale(0.97); }
      to   { opacity:1; transform: translateY(0) scale(1); }
    }

    #tomu-auth-modal .tomu-modal-logo {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 1.1rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      color: #1a1612;
      margin-bottom: 28px;
      text-align: center;
    }
    #tomu-auth-modal .tomu-modal-logo span { color: #b87333; }

    #tomu-auth-modal h2 {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 1.6rem;
      font-weight: 300;
      letter-spacing: 0.03em;
      color: #1a1612;
      margin-bottom: 8px;
      line-height: 1.3;
    }

    #tomu-auth-modal .tomu-modal-sub {
      font-size: 0.78rem;
      color: #8a7e72;
      line-height: 1.8;
      margin-bottom: 32px;
    }

    #tomu-auth-modal label {
      display: block;
      font-size: 0.68rem;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: #8a7e72;
      margin-bottom: 8px;
    }

    #tomu-auth-modal input[type="email"] {
      width: 100%;
      padding: 14px 16px;
      border: 1px solid #ddd5c8;
      border-radius: 12px;
      background: #fff;
      font-family: 'Noto Sans JP', sans-serif;
      font-size: 0.88rem;
      font-weight: 300;
      color: #1a1612;
      outline: none;
      transition: border-color .2s;
      box-sizing: border-box;
    }
    #tomu-auth-modal input[type="email"]:focus { border-color: #b87333; }

    #tomu-auth-btn {
      width: 100%;
      margin-top: 16px;
      padding: 15px 24px;
      background: #1a1612;
      color: #f7f3ee;
      border: none;
      border-radius: 12px;
      font-family: 'Noto Sans JP', sans-serif;
      font-size: 0.82rem;
      font-weight: 300;
      letter-spacing: 0.15em;
      cursor: pointer;
      transition: background .2s, transform .1s;
      position: relative;
    }
    #tomu-auth-btn:hover { background: #2e2820; }
    #tomu-auth-btn:active { transform: scale(0.99); }
    #tomu-auth-btn:disabled { opacity: 0.6; cursor: not-allowed; }

    #tomu-auth-btn .tomu-btn-loading {
      display: none;
      gap: 4px;
      justify-content: center;
      align-items: center;
    }
    #tomu-auth-btn.loading .tomu-btn-text { display: none; }
    #tomu-auth-btn.loading .tomu-btn-loading { display: flex; }

    #tomu-auth-btn .tomu-btn-loading span {
      width: 5px; height: 5px;
      border-radius: 50%;
      background: #f7f3ee;
      animation: tomuDot 1.2s ease-in-out infinite;
    }
    #tomu-auth-btn .tomu-btn-loading span:nth-child(2) { animation-delay: 0.2s; }
    #tomu-auth-btn .tomu-btn-loading span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes tomuDot {
      0%,80%,100% { transform: scale(0.7); opacity: 0.5; }
      40% { transform: scale(1); opacity: 1; }
    }

    #tomu-auth-error {
      display: none;
      margin-top: 12px;
      padding: 12px 16px;
      background: #fff5f5;
      border: 1px solid #fccaca;
      border-radius: 10px;
      font-size: 0.76rem;
      color: #c0392b;
      line-height: 1.6;
    }
    #tomu-auth-error.visible { display: block; }

    /* 決済案内パネル */
    #tomu-pricing-panel {
      display: none;
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid #ddd5c8;
    }
    #tomu-pricing-panel.visible { display: block; }

    #tomu-pricing-panel .tomu-pricing-title {
      font-size: 0.7rem;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: #8a7e72;
      margin-bottom: 12px;
      text-align: center;
    }

    .tomu-plan-btn {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 13px 16px;
      border: 1px solid #ddd5c8;
      border-radius: 10px;
      background: #fff;
      cursor: pointer;
      font-family: 'Noto Sans JP', sans-serif;
      font-size: 0.8rem;
      font-weight: 300;
      color: #1a1612;
      text-decoration: none;
      margin-bottom: 8px;
      transition: all .2s;
      box-sizing: border-box;
    }
    .tomu-plan-btn:last-child { margin-bottom: 0; }
    .tomu-plan-btn:hover { border-color: #b87333; background: #fdf8f3; }
    .tomu-plan-btn .tomu-plan-name { font-weight: 400; letter-spacing: 0.05em; }
    .tomu-plan-btn .tomu-plan-price { color: #b87333; font-family: 'Cormorant Garamond', Georgia, serif; font-size: 1rem; }

    /* ログイン済みバッジ */
    #tomu-user-badge {
      display: none;
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 9000;
      background: #f7f3ee;
      border: 1px solid #ddd5c8;
      border-radius: 40px;
      padding: 8px 14px 8px 10px;
      font-family: 'Noto Sans JP', sans-serif;
      font-size: 0.7rem;
      font-weight: 300;
      color: #8a7e72;
      align-items: center;
      gap: 8px;
      box-shadow: 0 4px 16px rgba(26,22,18,0.08);
      cursor: pointer;
      transition: all .2s;
    }
    #tomu-user-badge.active { display: flex; }
    #tomu-user-badge:hover { border-color: #b87333; }
    #tomu-user-badge .tomu-badge-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: #7a9e7e;
      flex-shrink: 0;
    }

    /* アプリコンテンツのブロック */
    #tomu-app-blocked {
      display: none;
      pointer-events: none;
      filter: blur(3px);
      opacity: 0.4;
      user-select: none;
      transition: all .3s;
    }
    body.tomu-locked #tomu-app-blocked { display: block; }
    body.tomu-locked .tomu-lockable { 
      pointer-events: none;
      filter: blur(3px);
      opacity: 0.4;
      user-select: none;
    }

    @media (max-width: 480px) {
      #tomu-auth-modal { padding: 36px 24px 32px; }
    }
  `;
  document.head.appendChild(style);

  // ============================================================
  // HTML インジェクション
  // ============================================================
  const overlay = document.createElement('div');
  overlay.id = 'tomu-auth-overlay';
  overlay.innerHTML = `
    <div id="tomu-auth-modal">
      <div class="tomu-modal-logo">とむ<span>SYSTEM</span></div>
      <h2 id="tomu-modal-title">メールアドレスで<br>ログイン</h2>
      <p class="tomu-modal-sub" id="tomu-modal-sub">登録済みのメールアドレスを入力してください。<br>サブスクリプションを確認してアプリを開放します。</p>
      <label for="tomu-email-input">メールアドレス</label>
      <input type="email" id="tomu-email-input" placeholder="you@example.com" autocomplete="email" />
      <button id="tomu-auth-btn">
        <span class="tomu-btn-text">確認する</span>
        <span class="tomu-btn-loading"><span></span><span></span><span></span></span>
      </button>
      <div id="tomu-auth-error"></div>
      <div id="tomu-pricing-panel">
        <p class="tomu-pricing-title">プランを選んで始める</p>
        <a class="tomu-plan-btn" id="tomu-plan-light" href="${STRIPE_LINKS.light}" target="_blank" rel="noopener">
          <span class="tomu-plan-name">Light — 3アプリ選択</span>
          <span class="tomu-plan-price">¥480/月</span>
        </a>
        <a class="tomu-plan-btn" id="tomu-plan-standard" href="${STRIPE_LINKS.standard}" target="_blank" rel="noopener">
          <span class="tomu-plan-name">Standard — 6アプリ選択</span>
          <span class="tomu-plan-price">¥980/月</span>
        </a>
        <a class="tomu-plan-btn" id="tomu-plan-full" href="${STRIPE_LINKS.full}" target="_blank" rel="noopener">
          <span class="tomu-plan-name">Full — 全10アプリ使い放題</span>
          <span class="tomu-plan-price">¥1,480/月</span>
        </a>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const badge = document.createElement('div');
  badge.id = 'tomu-user-badge';
  badge.innerHTML = `<span class="tomu-badge-dot"></span><span id="tomu-badge-label"></span>`;
  badge.title = 'クリックでログアウト';
  document.body.appendChild(badge);

  // ============================================================
  // ロジック
  // ============================================================
  const TomuAuth = {
    _email: null,

    getEmail() {
      return this._email || localStorage.getItem(STORAGE_KEY) || null;
    },

    _setEmail(email) {
      this._email = email;
      localStorage.setItem(STORAGE_KEY, email);
    },

    _clear() {
      this._email = null;
      localStorage.removeItem(STORAGE_KEY);
    },

    // Worker に email だけ送って登録確認 (input は空文字でOK、appTypeはping)
    async _checkSubscription(email) {
      const res = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appType: 'ping', input: 'ping', email }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.error === 'subscription_required') return 'unsubscribed';
      if (res.status === 401) return 'no_email';
      // 200 or any other response = registered (ping appType fallsthrough to default prompt)
      return 'ok';
    },

    showOverlay() {
      overlay.classList.add('active');
      document.body.classList.add('tomu-locked');
      setTimeout(() => document.getElementById('tomu-email-input')?.focus(), 100);
    },

    hideOverlay() {
      overlay.classList.remove('active');
      document.body.classList.remove('tomu-locked');
    },

    showBadge(email) {
      const label = document.getElementById('tomu-badge-label');
      if (label) label.textContent = email;
      badge.classList.add('active');
    },

    async init() {
      const saved = this.getEmail();
      if (saved) {
        const status = await this._checkSubscription(saved);
        if (status === 'ok') {
          this._email = saved;
          this.showBadge(saved);
          return; // アプリそのまま使用可能
        } else {
          // 保存メールが無効になった場合はクリア
          this._clear();
        }
      }
      this.showOverlay();
    },
  };

  // ============================================================
  // イベントハンドラ
  // ============================================================
  document.getElementById('tomu-auth-btn').addEventListener('click', async () => {
    const emailInput = document.getElementById('tomu-email-input');
    const btn = document.getElementById('tomu-auth-btn');
    const errorEl = document.getElementById('tomu-auth-error');
    const pricingPanel = document.getElementById('tomu-pricing-panel');
    const email = emailInput.value.trim().toLowerCase();

    // バリデーション
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errorEl.textContent = 'メールアドレスを正しく入力してください。';
      errorEl.classList.add('visible');
      return;
    }

    btn.classList.add('loading');
    btn.disabled = true;
    errorEl.classList.remove('visible');
    pricingPanel.classList.remove('visible');

    try {
      const status = await TomuAuth._checkSubscription(email);

      if (status === 'ok') {
        TomuAuth._setEmail(email);
        TomuAuth.hideOverlay();
        TomuAuth.showBadge(email);
        // アプリのロック解除イベントを発火
        document.dispatchEvent(new CustomEvent('tomu:unlocked', { detail: { email } }));
      } else if (status === 'unsubscribed') {
        // 決済案内を表示
        document.getElementById('tomu-modal-title').textContent = 'サブスクリプションが\n必要です';
        document.getElementById('tomu-modal-sub').textContent =
          'このアプリを使用するにはサブスクリプションが必要です。\nプランを選んでご登録ください。';
        pricingPanel.classList.add('visible');
        // Stripeリンクにemailをプリフィル
        ['light','standard','full'].forEach(plan => {
          const el = document.getElementById(`tomu-plan-${plan}`);
          if (el) el.href = `${STRIPE_LINKS[plan]}?prefilled_email=${encodeURIComponent(email)}`;
        });
        errorEl.textContent = 'このメールアドレスはまだ登録されていません。';
        errorEl.classList.add('visible');
      } else {
        errorEl.textContent = 'エラーが発生しました。もう一度お試しください。';
        errorEl.classList.add('visible');
      }
    } catch (e) {
      errorEl.textContent = 'ネットワークエラーが発生しました。接続を確認してください。';
      errorEl.classList.add('visible');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });

  // Enterキー対応
  document.getElementById('tomu-email-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('tomu-auth-btn').click();
  });

  // バッジクリック → ログアウト確認
  badge.addEventListener('click', () => {
    if (confirm('ログアウトしますか？')) {
      TomuAuth._clear();
      badge.classList.remove('active');
      document.getElementById('tomu-modal-title').textContent = 'メールアドレスで\nログイン';
      document.getElementById('tomu-modal-sub').textContent =
        '登録済みのメールアドレスを入力してください。\nサブスクリプションを確認してアプリを開放します。';
      document.getElementById('tomu-pricing-panel').classList.remove('visible');
      document.getElementById('tomu-auth-error').classList.remove('visible');
      document.getElementById('tomu-email-input').value = '';
      TomuAuth.showOverlay();
    }
  });

  // ============================================================
  // 初期化 & グローバル公開
  // ============================================================
  window.TomuAuth = TomuAuth;
  document.addEventListener('DOMContentLoaded', () => TomuAuth.init());
})();
