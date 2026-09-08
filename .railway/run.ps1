# Esegue `railway config <comando>` aggirando un bug di `railway/iac` 3.11.0 su
# Windows.
#
# L'SDK verifica la versione della CLI eseguendo `process.env._ --version`. Su
# Windows `_` non è valorizzata e il fallback è `railway`, che nel PATH è uno
# script `.ps1`/`.cmd` e non un eseguibile: `execFileSync` non sa avviarlo, e
# l'SDK conclude che la CLI sia troppo vecchia con un messaggio fuorviante che
# invita ad aggiornare una CLI già aggiornata (5.49 contro 5.42.1 richiesto).
#
# Non basta puntare `_` a `node.exe`: la regex dell'SDK è `\b(\d+)\.(\d+)\.(\d+)\b`
# e `node --version` stampa `v22.18.0`, dove fra `v` e `2` non c'è confine di
# parola — quindi non matcha e il controllo fallisce lo stesso, un passo più in
# là. Serve l'eseguibile nativo della CLI, che stampa `railway 5.49.3`.
#
# Si aggira la verifica, non la compatibilità: la CLI soddisfa il requisito, è il
# controllo a essere rotto su Windows.
#
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File .railway/run.ps1 plan
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Command)

$exe = Join-Path $env:APPDATA 'npm\node_modules\@railway\cli\bin\railway.exe'
if (-not (Test-Path $exe)) {
  Write-Error "Eseguibile della CLI Railway non trovato in $exe"
  exit 1
}

$env:_ = $exe
& $exe config @Command
exit $LASTEXITCODE
