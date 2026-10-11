const BOOK_TTL_S = 24 * 60 * 60;
const PART_BYTES = 20 * 1024 * 1024;
const MAX_PARTS = 5;
const MAX_COVER_BYTES = 200 * 1024;
const MAX_PER_CHANNEL = 30;
const ID = /^[a-z0-9]{16}$/;
const CHANNEL = /^(home-\d{1,3}(-\d{1,3}){3}|[a-z0-9]{4}-[a-z0-9]{4})$/;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });
}

function channels(param) {
  const list = (param || "").split(",").filter(Boolean);
  return list.length > 0 && list.length <= 2 && list.every((c) => CHANNEL.test(c)) ? list : null;
}

async function readIndex(env, channel) {
  const now = Date.now();
  const index = (await env.BOOKS.get(`index:${channel}`, "json")) || [];
  return index.filter((b) => now - b.time < BOOK_TTL_S * 1000 && ID.test(b.id) && b.parts >= 1);
}

function text(value, max) {
  return String(value || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);
}

async function part(request, env, id, n) {
  const index = Number(n);
  if (!ID.test(id) || !Number.isInteger(index) || index < 0 || index >= MAX_PARTS) return json({ error: "Bad part." }, 400);
  if (Number(request.headers.get("content-length")) > PART_BYTES) return json({ error: "too_large" }, 413);
  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > PART_BYTES) return json({ error: "too_large" }, 413);
  await env.BOOKS.put(`part:${id}:${index}`, body, { expirationTtl: BOOK_TTL_S });
  return json({ ok: true }, 201);
}

async function drop(request, env) {
  if (Number(request.headers.get("content-length")) > MAX_COVER_BYTES + 64 * 1024) return json({ error: "too_large" }, 413);
  const form = await request.formData().catch(() => null);
  const to = channels(form?.get("to"));
  const id = String(form?.get("id") || "");
  const parts = Number(form?.get("parts"));
  const name = text(form?.get("name"), 200).replace(/[\\/"]/g, "");
  if (!to || !ID.test(id) || !Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS || !/\.kepub\.epub$/i.test(name)) {
    return json({ error: "Bad channel or file." }, 400);
  }

  const cover = form.get("cover");
  const hasCover = cover instanceof File && cover.type === "image/jpeg" && cover.size <= MAX_COVER_BYTES;
  const book = {
    id,
    parts,
    name,
    title: text(form.get("title"), 300),
    author: text(form.get("author"), 200),
    cover: hasCover,
    to,
    size: Number(form.get("size")) || 0,
    time: Date.now(),
  };
  if (hasCover) await env.BOOKS.put(`cover:${id}`, await cover.arrayBuffer(), { expirationTtl: BOOK_TTL_S });
  for (const channel of to) {
    const index = await readIndex(env, channel);
    await env.BOOKS.put(`index:${channel}`, JSON.stringify([book, ...index.filter((b) => b.id !== id)].slice(0, MAX_PER_CHANNEL)));
  }
  return json(book, 201);
}

async function remove(env, url) {
  const id = url.searchParams.get("id") || "";
  const from = channels(url.searchParams.get("from"));
  if (!ID.test(id) || !from) return json({ error: "Bad book or channel." }, 400);
  const targets = new Set(from);
  let parts = 0;
  for (const channel of from) {
    const book = (await readIndex(env, channel)).find((b) => b.id === id);
    if (!book) continue;
    parts = Math.max(parts, book.parts);
    for (const c of book.to || []) targets.add(c);
  }
  for (const channel of targets) {
    const index = await readIndex(env, channel);
    if (index.some((b) => b.id === id)) await env.BOOKS.put(`index:${channel}`, JSON.stringify(index.filter((b) => b.id !== id)));
  }
  const keys = [`cover:${id}`, ...Array.from({ length: parts }, (_, n) => `part:${id}:${n}`)];
  await Promise.all(keys.map((key) => env.BOOKS.delete(key)));
  return json({ ok: true });
}

function titleVariants(title) {
  const variants = [title, title.split(/[:(\[]/)[0], title.replace(/\s*\d+\s*$/, ""), title.split(/[:(\[]/)[0].replace(/\s*\d+\s*$/, "")];
  return [...new Set(variants.map((t) => t.trim()).filter((t) => t.length > 1))];
}

async function openLibraryCover(title, author) {
  for (const t of titleVariants(title)) {
    const q = new URLSearchParams({ title: t, limit: "5", fields: "cover_i" });
    if (author) q.set("author", author);
    const res = await fetch(`https://openlibrary.org/search.json?${q}`, { headers: { "user-agent": "kobo-drop (github.com/Jeramai/kobo-drop)" } });
    if (!res.ok) continue;
    const doc = (await res.json()).docs?.find((d) => d.cover_i);
    if (doc) return `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
  }
  return null;
}

async function googleBooksCover(title, author) {
  const q = `intitle:${title}${author ? ` inauthor:${author}` : ""}`;
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&fields=items(volumeInfo/imageLinks)`);
  if (!res.ok) return null;
  const link = (await res.json()).items?.find((i) => i.volumeInfo?.imageLinks)?.volumeInfo.imageLinks;
  return (link?.thumbnail || link?.smallThumbnail)?.replace(/^http:/, "https:").replace("&edge=curl", "") || null;
}

async function lookup(url, ctx) {
  const title = text(url.searchParams.get("title"), 200);
  const author = text(url.searchParams.get("author"), 120);
  if (!title) return json({ error: "Missing title." }, 400);
  const cache = caches.default;
  const key = new Request(`${url.origin}/lookup?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  let image = null;
  for (const find of [openLibraryCover, googleBooksCover]) {
    const link = await find(title, author).catch(() => null);
    if (!link) continue;
    const res = await fetch(link).catch(() => null);
    const type = res?.headers.get("content-type") || "";
    if (res?.ok && type.startsWith("image/")) {
      image = new Response(res.body, { headers: { ...CORS, "content-type": type, "cache-control": "public, max-age=604800" } });
      break;
    }
  }
  if (!image) return new Response(null, { status: 404, headers: { ...CORS, "cache-control": "public, max-age=86400" } });
  ctx.waitUntil(cache.put(key, image.clone()));
  return image;
}

async function cover(env, id) {
  const body = await env.BOOKS.get(`cover:${id}`, "stream");
  if (!body) return new Response(null, { status: 404, headers: CORS });
  return new Response(body, { headers: { ...CORS, "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } });
}

async function list(env, url) {
  const from = channels(url.searchParams.get("from"));
  if (!from) return json({ error: "Bad channel." }, 400);
  const seen = new Set();
  const books = (await Promise.all(from.map((c) => readIndex(env, c))))
    .flat()
    .filter((b) => !seen.has(b.id) && seen.add(b.id))
    .sort((a, b) => b.time - a.time)
    .map((b) => ({
      ...b,
      url: `${url.origin}/book/${b.id}/${b.parts}/${encodeURIComponent(b.name)}`,
      coverUrl: b.cover ? `${url.origin}/cover/${b.id}` : null,
      expires: b.time + BOOK_TTL_S * 1000,
    }));
  return json(books);
}

function disposition(name) {
  let full = name;
  try {
    full = decodeURIComponent(name);
  } catch {}
  const ascii = full.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const utf8 = encodeURIComponent(full).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

async function download(env, id, parts, name) {
  const count = Number(parts);
  if (!ID.test(id) || !Number.isInteger(count) || count < 1 || count > MAX_PARTS) return json({ error: "Not found." }, 404);
  const streams = await Promise.all(Array.from({ length: count }, (_, n) => env.BOOKS.get(`part:${id}:${n}`, "stream")));
  if (streams.some((s) => !s)) {
    await Promise.all(streams.map((s) => s?.cancel()));
    return new Response("This book is no longer available. Send it again.", { status: 404, headers: CORS });
  }

  const { readable, writable } = new TransformStream();
  (async () => {
    for (const stream of streams) await stream.pipeTo(writable, { preventClose: true });
    await writable.close();
  })().catch(() => {});

  return new Response(readable, {
    headers: {
      ...CORS,
      "content-type": "application/epub+zip",
      "content-disposition": disposition(name),
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const [, route, id, second, third] = url.pathname.split("/");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "POST" && route === "part" && id && second) return part(request, env, id, second);
    if (request.method === "POST" && route === "drop") return drop(request, env);
    if (request.method === "GET" && route === "list") return list(env, url);
    if (request.method === "GET" && route === "lookup") return lookup(url, ctx);
    if (request.method === "POST" && route === "remove") return remove(env, url);
    if (request.method === "GET" && route === "book" && id && second && third) return download(env, id, second, third);
    if (request.method === "GET" && route === "cover" && id) return cover(env, id);
    return json({ error: "Not found." }, 404);
  },
};
