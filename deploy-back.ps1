param(
    [switch]$FullTerraform = $false
)

$ErrorActionPreference = "Stop"
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " 🚀 JobNet Backend Deploy (Express + Terraform)   " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

$env:AWS_PROFILE = "terra-profile"
$rootDir = $PSScriptRoot

# 0. Load .env file
$envFile = Join-Path $rootDir ".env"
$envDict = @{}
if (Test-Path $envFile) {
    Write-Host "`n[0/4] 📄 Loading environment variables from .env..." -ForegroundColor Yellow
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $parts = $line.Split("=", 2)
            $key = $parts[0].Trim()
            $val = $parts[1].Trim()
            $envDict[$key] = $val
        }
    }
    Write-Host "   Loaded $($envDict.Count) variables from .env" -ForegroundColor Green
} else {
    Write-Warning "⚠️ No .env file found at $envFile. Proceeding with environment defaults."
}

# 1. Clean & create output dirs
$distDir = Join-Path $rootDir "dist"
$lambdasDir = Join-Path $distDir "lambdas"
$zipsDir = Join-Path $distDir "zips"

if (-not (Test-Path $zipsDir)) {
    New-Item -ItemType Directory -Path $zipsDir -Force | Out-Null
}

Write-Host "`n[1/4] 📦 Bundling with esbuild..." -ForegroundColor Yellow

$buildConfigs = @(
    @{ Entry = "src/lambda.ts"; OutDir = "dist/lambdas/api"; Out = "dist/lambdas/api/index.js"; Zip = "api.zip"; Func = "jobnet-api-prod" },
    @{ Entry = "src/lambdaWs.ts"; OutDir = "dist/lambdas/ws"; Out = "dist/lambdas/ws/index.js"; Zip = "ws.zip"; Func = "jobnet-ws-prod" },
    @{ Entry = "src/handlers/wsAuthorizer.ts"; OutDir = "dist/lambdas/wsAuthorizer"; Out = "dist/lambdas/wsAuthorizer/index.js"; Zip = "wsAuthorizer.zip"; Func = "jobnet-ws-authorizer-prod" },
    @{ Entry = "src/handlers/postConfirmation.ts"; OutDir = "dist/lambdas/postConfirmation"; Out = "dist/lambdas/postConfirmation/index.js"; Zip = "postConfirmation.zip"; Func = "jobnet-post-confirmation-prod" },
    @{ Entry = "src/lambdaSuspensionExpiry.ts"; OutDir = "dist/lambdas/suspensionExpiry"; Out = "dist/lambdas/suspensionExpiry/index.js"; Zip = "suspensionExpiry.zip"; Func = "jobnet-suspension-expiry-prod" }
)

foreach ($cfg in $buildConfigs) {
    $entryFile = Join-Path $rootDir $cfg.Entry
    $outFile = Join-Path $rootDir $cfg.Out
    $outDir = Split-Path -Path $outFile -Parent
    if (-not (Test-Path $outDir)) {
        New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    }
    
    & npx esbuild $entryFile `
        --bundle `
        --platform=node `
        --target=node20 `
        --format=cjs `
        "--outfile=$outFile" `
        "--external:@aws-sdk/*"
        
    # Copiar .env junto al index.js empaquetado para que dotenv lo lea en /var/task
    if (Test-Path $envFile) {
        Copy-Item -Path $envFile -Destination (Join-Path $outDir ".env") -Force
    }
}

Write-Host "`n[2/4] 🗜️ Packaging ZIP archives..." -ForegroundColor Yellow

foreach ($cfg in $buildConfigs) {
    $destZip = Join-Path $zipsDir $cfg.Zip
    if (Test-Path $destZip) {
        Remove-Item -Path $destZip -Force
    }
    
    $outDir = Join-Path $rootDir $cfg.OutDir
    $itemsToZip = Get-ChildItem -Path $outDir | Select-Object -ExpandProperty FullName
    Compress-Archive -Path $itemsToZip -DestinationPath $destZip -Force
}

if ($FullTerraform) {
    Write-Host "`n[3/4] 🏗️ Applying Terraform configuration..." -ForegroundColor Yellow
    
    # Exportar variables de entorno de .env para que Terraform las inyecte
    if ($envDict.ContainsKey("DEEPSEEK_API_KEY")) { $env:TF_VAR_deepseek_api_key = $envDict["DEEPSEEK_API_KEY"] }
    if ($envDict.ContainsKey("DEEPSEEK_API_URL")) { $env:TF_VAR_deepseek_api_url = $envDict["DEEPSEEK_API_URL"] }
    if ($envDict.ContainsKey("GEMINI_API_KEY")) { $env:TF_VAR_gemini_api_key = $envDict["GEMINI_API_KEY"] }
    if ($envDict.ContainsKey("GEMINI_API_URL")) { $env:TF_VAR_gemini_api_url = $envDict["GEMINI_API_URL"] }
    if ($envDict.ContainsKey("AI_PROVIDER")) { $env:TF_VAR_ai_provider = $envDict["AI_PROVIDER"] }
    if ($envDict.ContainsKey("AI_MODERATION_PROVIDER")) { $env:TF_VAR_ai_moderation_provider = $envDict["AI_MODERATION_PROVIDER"] }
    if ($envDict.ContainsKey("AI_MODERATION_MODEL")) { $env:TF_VAR_ai_moderation_model = $envDict["AI_MODERATION_MODEL"] }
    if ($envDict.ContainsKey("AI_REASONING_PROVIDER")) { $env:TF_VAR_ai_reasoning_provider = $envDict["AI_REASONING_PROVIDER"] }
    if ($envDict.ContainsKey("AI_REASONING_MODEL")) { $env:TF_VAR_ai_reasoning_model = $envDict["AI_REASONING_MODEL"] }

    Push-Location (Join-Path $rootDir "terraform/environments/prod")
    try {
        & terraform apply -auto-approve
    } finally {
        Pop-Location
    }
} else {
    Write-Host "`n[3/4] ⚡ Fast Lambda code updates via AWS CLI..." -ForegroundColor Yellow
    foreach ($cfg in $buildConfigs) {
        $zipPath = Join-Path $zipsDir $cfg.Zip
        Write-Host "   -> Updating code for $($cfg.Func)..." -ForegroundColor Gray
        & aws lambda update-function-code `
            --function-name $cfg.Func `
            --zip-file "fileb://$zipPath" `
            --query "FunctionName" `
            --output text | Out-Null
    }

    # Sincronizar variables de entorno de .env a jobnet-api-prod en AWS
    if ($envDict.Count -gt 0) {
        Write-Host "   -> Syncing .env variables to jobnet-api-prod in AWS..." -ForegroundColor Yellow
        try {
            # Esperar a que la actualización de código termine para evitar ResourceConflictException
            Write-Host "      Waiting for jobnet-api-prod to finish updating code..." -ForegroundColor Gray
            & aws lambda wait function-updated --function-name "jobnet-api-prod"

            $currentConfigRaw = & aws lambda get-function-configuration --function-name "jobnet-api-prod" --query "Environment.Variables" --output json
            $currentConfig = $currentConfigRaw | ConvertFrom-Json
            
            $mergedVars = [ordered]@{}
            if ($currentConfig) {
                $currentConfig.psobject.properties | ForEach-Object {
                    $mergedVars[$_.Name] = [string]$_.Value
                }
            }
            
            # Variables de IA y configuración que deben sincronizarse desde .env
            $keysToSync = @(
                "DEEPSEEK_API_KEY",
                "DEEPSEEK_API_URL",
                "GEMINI_API_KEY",
                "GEMINI_API_URL",
                "AI_PROVIDER",
                "AI_MODERATION_PROVIDER",
                "AI_MODERATION_MODEL",
                "AI_REASONING_PROVIDER",
                "AI_REASONING_MODEL"
            )
            
            $updatedAny = $false
            foreach ($k in $keysToSync) {
                if ($envDict.ContainsKey($k) -and $envDict[$k]) {
                    $mergedVars[$k] = $envDict[$k]
                    $updatedAny = $true
                }
            }
            
            if ($updatedAny) {
                $payloadObj = @{
                    FunctionName = "jobnet-api-prod"
                    Environment = @{
                        Variables = $mergedVars
                    }
                }
                $tempJsonFile = Join-Path $distDir "env-config.json"
                $payloadObj | ConvertTo-Json -Depth 5 | Set-Content -Path $tempJsonFile -Encoding UTF8
                
                & aws lambda update-function-configuration --cli-input-json "file://$tempJsonFile" --query "FunctionName" --output text | Out-Null
                Remove-Item -Path $tempJsonFile -Force -ErrorAction SilentlyContinue
                Write-Host "   ✅ Lambda environment variables synced successfully in AWS." -ForegroundColor Green
            }
        } catch {
            Write-Warning "   ⚠️ Warning during update-function-configuration: $_"
            Write-Warning "   (.env is already embedded inside the zip package as active fallback)"
        }
    }
}

Write-Host "`n[4/4] 🔍 Health Check..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "https://z79mmps5xk.execute-api.us-east-1.amazonaws.com/health" -Method Get -TimeoutSec 10
    Write-Host "   ✅ API is Online: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    Write-Warning "   ⚠️ Could not reach /health endpoint: $_"
}

$stopwatch.Stop()
Write-Host "`n=================================================" -ForegroundColor Green
Write-Host " 🎉 Backend Deployed in $($stopwatch.Elapsed.TotalSeconds.ToString('F2')) seconds!" -ForegroundColor Green
Write-Host " 🌐 HTTP API: https://z79mmps5xk.execute-api.us-east-1.amazonaws.com" -ForegroundColor Cyan
Write-Host " 💬 WS API:   wss://v9b53l2zr2.execute-api.us-east-1.amazonaws.com/prod" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Green
