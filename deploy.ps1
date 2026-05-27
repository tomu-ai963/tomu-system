# orange-sound-354b Worker デプロイスクリプト
# 使い方: .\deploy.ps1 -Token "your_cf_api_token"
#         または $env:CF_API_TOKEN を設定して .\deploy.ps1 を実行
#
# エンドポイント一覧:
#   POST /                  — Light アプリ用
#   POST /api/chat          — Standard/Full アプリ用
#   POST /api/plant-diagnose
#   POST /api/yama-calendar
#   POST /api/tax-advisor   — Full プラン専用
#   POST /api/legal-advisor — Full プラン専用
#   POST /mystic-bridge     — MYSTIC MCP ブリッジ (tools/call)
#   POST /mcp               — とむSYSTEM MCPサーバー (JSON-RPC 2.0, MCP-Token 認証)
#   POST /hair-sim          — ヘアーシミュレーター
#   POST /stripe-webhook    — Stripe Webhook

param(
    [string]$Token = $env:CF_API_TOKEN
)

if (-not $Token) {
    Write-Error "CF_API_TOKEN が未設定です。-Token パラメータで渡すか、環境変数を設定してください。"
    exit 1
}

$AccountId = "b6815ad2ee3097cc0f9e79b8536776b9"
$ScriptName = "orange-sound-354b"
$WorkerFile = Join-Path $PSScriptRoot "tomu_system_worker.js"

if (-not (Test-Path $WorkerFile)) {
    Write-Error "tomu_system_worker.js が見つかりません: $WorkerFile"
    exit 1
}

$metadata = @"
{
  "main_module": "worker.js",
  "compatibility_date": "2024-01-01",
  "bindings": [
    {
      "type": "kv_namespace",
      "name": "SUBSCRIPTIONS",
      "namespace_id": "3d4d66de96b449e28198fdceb322b9d4"
    }
  ]
}
"@

$metaPath = Join-Path $env:TEMP "worker_metadata_$(Get-Random).json"
$metadata | Set-Content -Path $metaPath -Encoding UTF8

Write-Host "Deploying $ScriptName ..."

$curlArgs = @(
    "-s", "-X", "PUT",
    "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/scripts/$ScriptName",
    "-H", "Authorization: Bearer $Token",
    "-F", "metadata=@$metaPath;type=application/json",
    "-F", "worker.js=@$WorkerFile;filename=worker.js;type=application/javascript+module"
)

$result = & curl.exe @curlArgs
Remove-Item $metaPath -Force -ErrorAction SilentlyContinue

try {
    $json = $result | ConvertFrom-Json
    if ($json.success) {
        Write-Host "Deploy successful!" -ForegroundColor Green
        Write-Host "Worker: https://$ScriptName.tomu-ai963.workers.dev"
    } else {
        Write-Host "Deploy failed:" -ForegroundColor Red
        $json.errors | ForEach-Object { Write-Host "  - $($_.message)" -ForegroundColor Red }
    }
} catch {
    Write-Host $result
}
