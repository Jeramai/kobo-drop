# Kobo Drop

Send EPUB books to a Kobo e-reader from any phone or computer. The book is converted to KEPUB
in the browser, relayed through [ntfy.sh](https://ntfy.sh) (deleted after 3 hours), and the
Kobo's web browser picks it up at `/k/`.

- `index.html` — send page.
- `k/index.html` — Kobo page. Plain ES5 for the Kobo's old WebKit browser.
- `kepubify.wasm` — [kepubify](https://github.com/pgaskin/kepubify) (MIT, see `LICENSE-kepubify`)
  compiled to WebAssembly from `wasm/main.go`.

## Rebuild the converter

```sh
git clone https://github.com/pgaskin/kepubify && cd kepubify
mkdir -p cmd/kepubify-wasm && cp ../wasm/main.go cmd/kepubify-wasm/
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -trimpath -o ../kepubify.wasm ./cmd/kepubify-wasm
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" ..
```
