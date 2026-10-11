const JUNK = [
  /\b(?:z-?library|z-?lib|1lib|zlibrary|singlelogin)(?:\.[a-z]{2,4})?\b/gi,
  /\b(?:b-ok|libgen|library genesis|anna['’]?s archive|oceanofpdf|ebook3000|dokumen|pdfdrive|epubjet|wolnelektury)(?:\.[a-z]{2,4})?\b/gi,
  /\bwww\.[\w-]+\.[a-z]{2,4}\b/gi,
  /\b[\w-]{2,}\.(?:com|org|net|sk|se|is|li|io|to)\b/gi,
];

function cleanText(value) {
  let s = String(value || "").replace(/_/g, " ");
  for (const re of JUNK) s = s.replace(re, " ");
  return s
    .replace(/[([{]\s*[,;\s]*[)\]}]/g, " ")
    .replace(/(?:\s*[,;|]\s*)+$/g, "")
    .replace(/^\s*[,;|]+/g, "")
    .replace(/\s+[-–]\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function titleFromFileName(name) {
  return cleanText(name.replace(/\.kepub\.epub$/i, "").replace(/\.epub$/i, ""));
}

function bookFileName(title, author) {
  const base = (author ? `${author} - ${title}` : title).replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  return `${base.slice(0, 150) || "Book"}.kepub.epub`;
}
