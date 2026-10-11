//go:build js && wasm

package main

import (
	"archive/zip"
	"bytes"
	"context"
	"syscall/js"

	"github.com/pgaskin/kepubify/v4/kepub"
)

func convert(this js.Value, args []js.Value) interface{} {
	in := make([]byte, args[0].Get("length").Int())
	js.CopyBytesToGo(in, args[0])

	zr, err := zip.NewReader(bytes.NewReader(in), int64(len(in)))
	if err != nil {
		return map[string]interface{}{"error": "Not a valid EPUB file: " + err.Error()}
	}
	var out bytes.Buffer
	if err := kepub.NewConverter().Convert(context.Background(), &out, zr); err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	res := js.Global().Get("Uint8Array").New(out.Len())
	js.CopyBytesToJS(res, out.Bytes())
	return map[string]interface{}{"data": res}
}

func main() {
	js.Global().Set("kepubify", js.FuncOf(convert))
	select {}
}
