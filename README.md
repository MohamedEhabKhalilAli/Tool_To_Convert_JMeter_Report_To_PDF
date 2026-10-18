# JMeter HTML Report → PDF

Converts the Apache JMeter HTML dashboard folder (the output of `jmeter ... -e -o report`) into one PDF:

- **Cover page** – title, overall KPIs (samples, error %, average, 90th/95th pct, throughput, APDEX), test info, table of contents with page numbers
- **Dashboard** – test info, APDEX, requests summary pie, full statistics table, errors, top 5 errors by sampler
- **Over Time / Throughput / Response Times charts** – every graph panel is expanded and drawn (including the ones JMeter loads lazily)
- Custom graphs page (only if the report has any)
- Footer with title and "Page X of Y" on every page

## Requirements
- Windows/macOS/Linux with **Node.js 18+** (https://nodejs.org)
- Internet on the first run (npm downloads the packages and a headless Chrome)

## Web tool (upload folder → download PDF)
1. Double-click **`start.bat`** (first run installs dependencies).
2. Your browser opens at http://localhost:4000.
3. Drag & drop the report folder (or click *Choose report folder*, or upload a `.zip` of it).
4. Optionally set the title, paper size, orientation and which pages to include.
5. Click **Generate PDF** – the PDF downloads automatically.

Change port: `set PORT=8080` before `start.bat`.
Others on your network can use it at `http://<your-pc-ip>:4000`.

## Command line (CI / batch)
```
convert.bat "C:\results\report" "C:\results\Load_Test.pdf" --title "Checkout Load Test"
node cli.js <reportFolder> [output.pdf] [--title "..."] [--format A4|A3|Letter|Legal] [--portrait] [--no-cover]
```
Exit code is non-zero on failure, so it can run as a Jenkins / Azure DevOps / GitHub Actions step right after JMeter.

## Troubleshooting
| Problem | Fix |
|---|---|
| Chrome download blocked by proxy during `npm install` | `set PUPPETEER_SKIP_DOWNLOAD=1` then `npm install` – the tool falls back to installed Chrome or Edge |
| Use a specific browser | `set CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe` |
| "No JMeter HTML report found" | Select the folder that directly contains `index.html` and `content\` |
| Very long tests (huge graph.js) time out | Increase `timeoutMs` in `src/converter.js` (default 180 s per page) |

## Project layout
```
server.js          Express web server (upload + convert API)
cli.js             Command-line converter
src/converter.js   Rendering engine (headless Chrome via Puppeteer + pdf-lib merge)
public/index.html  Upload page
start.bat          One-click start on Windows
convert.bat        CLI wrapper on Windows
```
