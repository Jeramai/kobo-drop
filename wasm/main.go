//go:build js && wasm

package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"
	"syscall/js"

	"github.com/pgaskin/kepubify/v4/kepub"
)

func readBytes(arg js.Value) []byte {
	b := make([]byte, arg.Get("length").Int())
	js.CopyBytesToGo(b, arg)
	return b
}

func toJS(b []byte) js.Value {
	res := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(res, b)
	return res
}

func guard(fn func(js.Value, []js.Value) interface{}) func(js.Value, []js.Value) interface{} {
	return func(this js.Value, args []js.Value) (res interface{}) {
		defer func() {
			if r := recover(); r != nil {
				res = map[string]interface{}{"error": fmt.Sprint("The converter failed on this book: ", r)}
			}
		}()
		return fn(this, args)
	}
}

func convert(this js.Value, args []js.Value) interface{} {
	in := readBytes(args[0])
	zr, err := zip.NewReader(bytes.NewReader(in), int64(len(in)))
	if err != nil {
		return map[string]interface{}{"error": "Not a valid EPUB file: " + err.Error()}
	}
	var out bytes.Buffer
	if err := kepub.NewConverter().Convert(context.Background(), &out, zr); err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"data": toJS(out.Bytes())}
}

type opf struct {
	Titles   []string `xml:"metadata>title"`
	Creators []string `xml:"metadata>creator"`
	Metas    []struct {
		Name    string `xml:"name,attr"`
		Content string `xml:"content,attr"`
	} `xml:"metadata>meta"`
	Items []struct {
		ID         string `xml:"id,attr"`
		Href       string `xml:"href,attr"`
		MediaType  string `xml:"media-type,attr"`
		Properties string `xml:"properties,attr"`
	} `xml:"manifest>item"`
}

func readFile(zr *zip.Reader, name string) []byte {
	f, err := zr.Open(name)
	if err != nil {
		return nil
	}
	defer f.Close()
	b, _ := io.ReadAll(f)
	return b
}

func meta(this js.Value, args []js.Value) interface{} {
	in := readBytes(args[0])
	res := map[string]interface{}{}
	zr, err := zip.NewReader(bytes.NewReader(in), int64(len(in)))
	if err != nil {
		return res
	}

	var container struct {
		Rootfiles []struct {
			Path string `xml:"full-path,attr"`
		} `xml:"rootfiles>rootfile"`
	}
	if xml.Unmarshal(readFile(zr, "META-INF/container.xml"), &container) != nil || len(container.Rootfiles) == 0 {
		return res
	}
	opfPath := container.Rootfiles[0].Path
	var pkg opf
	if xml.Unmarshal(readFile(zr, opfPath), &pkg) != nil {
		return res
	}
	if len(pkg.Titles) > 0 {
		res["title"] = strings.TrimSpace(pkg.Titles[0])
	}
	if len(pkg.Creators) > 0 {
		res["author"] = strings.TrimSpace(pkg.Creators[0])
	}

	coverID := ""
	for _, m := range pkg.Metas {
		if m.Name == "cover" {
			coverID = m.Content
		}
	}
	href, mediaType := "", ""
	for pass := 0; pass < 3 && href == ""; pass++ {
		for _, it := range pkg.Items {
			if !strings.HasPrefix(it.MediaType, "image/") {
				continue
			}
			lower := strings.ToLower(it.ID + " " + it.Href)
			if (pass == 0 && strings.Contains(it.Properties, "cover-image")) ||
				(pass == 1 && coverID != "" && it.ID == coverID) ||
				(pass == 2 && strings.Contains(lower, "cover")) {
				href, mediaType = it.Href, it.MediaType
				break
			}
		}
	}
	if href != "" {
		if unescaped, err := url.PathUnescape(href); err == nil {
			href = unescaped
		}
		if b := readFile(zr, path.Join(path.Dir(opfPath), href)); len(b) > 0 {
			res["cover"] = toJS(b)
			res["coverType"] = mediaType
		}
	}
	return res
}

func main() {
	js.Global().Set("kepubify", js.FuncOf(guard(convert)))
	js.Global().Set("epubMeta", js.FuncOf(guard(meta)))
	select {}
}
