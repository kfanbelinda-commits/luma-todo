$ErrorActionPreference = 'Stop'

$projectDirectory = $PSScriptRoot
$electronExecutable = Join-Path $projectDirectory 'node_modules\electron\dist\electron.exe'

try {
    if (-not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) {
        throw 'Electron is not installed. Open PowerShell in the project folder and run: npm install'
    }

    # Some developer shells set this variable, which makes Electron run as Node.js.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

    Start-Process `
        -FilePath $electronExecutable `
        -ArgumentList @('.') `
        -WorkingDirectory $projectDirectory `
        -WindowStyle Hidden
}
catch {
    $shell = New-Object -ComObject WScript.Shell
    $null = $shell.Popup(
        "Luma Todo could not start.`r`n`r`n$($_.Exception.Message)",
        0,
        'Luma Todo',
        16
    )
    exit 1
}
