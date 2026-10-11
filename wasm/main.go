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
	"html"
	"path"
	"regexp"
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
	href, mediaType, id, declared := "", "", "", false
	for pass := 0; pass < 3 && href == ""; pass++ {
		for _, it := range pkg.Items {
			if !strings.HasPrefix(it.MediaType, "image/") {
				continue
			}
			lower := strings.ToLower(it.ID + " " + it.Href)
			if (pass == 0 && strings.Contains(it.Properties, "cover-image")) ||
				(pass == 1 && coverID != "" && it.ID == coverID) ||
				(pass == 2 && strings.Contains(lower, "cover")) {
				href, mediaType, id, declared = it.Href, it.MediaType, it.ID, pass < 2
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
			res["coverId"] = id
			res["coverDeclared"] = declared
		}
	}
	return res
}

var (
	reTitle    = regexp.MustCompile(`(?s)(<(?:\w+:)?title\b[^>]*>).*?(</(?:\w+:)?title>)`)
	reCreator  = regexp.MustCompile(`(?s)(<(?:\w+:)?creator\b[^>]*>).*?(</(?:\w+:)?creator>)`)
	reManifest = regexp.MustCompile(`</(?:\w+:)?manifest>`)
	reMetadata = regexp.MustCompile(`</(?:\w+:)?metadata>`)
)

func replaceFirst(re *regexp.Regexp, s, value string) string {
	done := false
	return re.ReplaceAllStringFunc(s, func(m string) string {
		if done {
			return m
		}
		done = true
		parts := re.FindStringSubmatch(m)
		return parts[1] + html.EscapeString(value) + parts[2]
	})
}

func finish(this js.Value, args []js.Value) interface{} {
	in := readBytes(args[0])
	title, author := args[1].String(), args[2].String()
	var cover []byte
	if len(args) > 3 && !args[3].IsNull() && !args[3].IsUndefined() {
		cover = readBytes(args[3])
	}
	declareID := ""
	if len(args) > 4 && args[4].Type() == js.TypeString {
		declareID = args[4].String()
	}

	zr, err := zip.NewReader(bytes.NewReader(in), int64(len(in)))
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	var container struct {
		Rootfiles []struct {
			Path string `xml:"full-path,attr"`
		} `xml:"rootfiles>rootfile"`
	}
	if xml.Unmarshal(readFile(zr, "META-INF/container.xml"), &container) != nil || len(container.Rootfiles) == 0 {
		return map[string]interface{}{"data": args[0]}
	}
	opfPath := container.Rootfiles[0].Path
	opf := string(readFile(zr, opfPath))
	if title != "" {
		opf = replaceFirst(reTitle, opf, title)
	}
	if author != "" {
		opf = replaceFirst(reCreator, opf, author)
	}
	if declareID != "" && cover == nil {
		item := regexp.MustCompile(`<(?:\w+:)?item\b[^>]*\bid="` + regexp.QuoteMeta(declareID) + `"[^>]*?(/?)>`)
		opf = item.ReplaceAllStringFunc(opf, func(m string) string {
			if strings.Contains(m, "properties=") {
				return m
			}
			return strings.Replace(m, " id=", ` properties="cover-image" id=`, 1)
		})
		opf = reMetadata.ReplaceAllLiteralString(opf, `<meta name="cover" content="`+html.EscapeString(declareID)+`"/></metadata>`)
	}
	coverPath := path.Join(path.Dir(opfPath), "kobodrop-cover.jpg")
	if cover != nil {
		opf = reManifest.ReplaceAllLiteralString(opf, `<item id="kobodrop-cover" href="kobodrop-cover.jpg" media-type="image/jpeg" properties="cover-image"/></manifest>`)
		opf = reMetadata.ReplaceAllLiteralString(opf, `<meta name="cover" content="kobodrop-cover"/></metadata>`)
	}

	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, f := range zr.File {
		switch f.Name {
		case opfPath:
			w, err := zw.CreateHeader(&zip.FileHeader{Name: f.Name, Method: zip.Deflate, Modified: f.Modified})
			if err != nil {
				return map[string]interface{}{"error": err.Error()}
			}
			io.WriteString(w, opf)
		default:
			if err := zw.Copy(f); err != nil {
				return map[string]interface{}{"error": err.Error()}
			}
		}
	}
	if cover != nil {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: coverPath, Method: zip.Store})
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		w.Write(cover)
	}
	if err := zw.Close(); err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"data": toJS(out.Bytes())}
}

func main() {
	js.Global().Set("kepubify", js.FuncOf(guard(convert)))
	js.Global().Set("epubMeta", js.FuncOf(guard(meta)))
	js.Global().Set("epubFinish", js.FuncOf(guard(finish)))
	select {}
}
