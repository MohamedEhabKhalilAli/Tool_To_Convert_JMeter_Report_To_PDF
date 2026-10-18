@echo off
REM Command-line conversion (for CI / batch use)
REM Usage: convert.bat "C:\path\to\report" ["C:\path\to\output.pdf"] [--title "My Test"] [--format A4] [--portrait] [--no-cover]
cd /d "%~dp0"
if not exist node_modules call npm install --no-audit --no-fund
node cli.js %*
