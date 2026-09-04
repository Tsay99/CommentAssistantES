$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$compiler=Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler is unavailable.' }
$source=Join-Path $projectRoot 'background-launcher.cs'
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'bin') | Out-Null
$output=Join-Path $projectRoot 'bin\CommentAssistantES.Background.exe'
& $compiler /nologo /target:winexe /optimize+ "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw 'Background launcher compilation failed.' }

