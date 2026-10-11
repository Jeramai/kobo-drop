# Kobo Drop

Send EPUB books to a Kobo e-reader from any phone or computer. The book is converted to KEPUB
in the browser and uploaded to a small Cloudflare Worker, which keeps it for 24 hours (25 MB per
book, the KV value limit). The Kobo's web browser picks it up at `/k/`.

On the same Wi-Fi no code is needed: both pages derive a shared channel from their public IPv4
address (via ipify, icanhazip as fallback). Each send page also has a code; a Kobo that enters it
gets books from any network. A book is stored once and listed on both channels.

- `index.html` — send page.
- `k/index.html` — Kobo page. Plain ES5 for the Kobo's old WebKit browser (no fetch, no Promise).
- `worker/` — the Cloudflare Worker and its KV binding. Deploy with `npx wrangler deploy`.
- `kepubify.wasm` — reads title, author and cover (`epubMeta`) and converts (`kepubify`). Built from
  [kepubify](https://github.com/pgaskin/kepubify) (MIT, see `LICENSE-kepubify`)
  compiled to WebAssembly from `wasm/main.go`.

## Rebuild the converter

```sh
git clone https://github.com/pgaskin/kepubify && cd kepubify
mkdir -p cmd/kepubify-wasm && cp ../wasm/main.go cmd/kepubify-wasm/
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -trimpath -o ../kepubify.wasm ./cmd/kepubify-wasm
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" ..
```
