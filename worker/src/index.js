const BOOK_TTL_S = 24 * 60 * 60;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PER_CHANNEL = 30;
const CHANNEL = /^(home-\d{1,3}(-\d{1,3}){3}|[a-z0-9]{4}-[a-z0-9]{4})$/;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, OPTIONS",
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
  return index.filter((b) => now - b.time < BOOK_TTL_S * 1000);
}

async function drop(request, env, url) {
  const to = channels(url.searchParams.get("to"));
  const name = (url.searchParams.get("name") || "").replace(/[\\/\u0000-\u001f"]/g, "").slice(0, 200);
  if (!to || !/\.kepub\.epub$/i.test(name)) return json({ error: "Bad channel or file name." }, 400);
  if (Number(request.headers.get("content-length")) > MAX_BYTES) return json({ error: "too_large" }, 413);

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return json({ error: "too_large" }, 413);

  const book = { id: crypto.randomUUID().slice(0, 12), name, size: body.byteLength, time: Date.now() };
  await env.BOOKS.put(`book:${book.id}`, body, { expirationTtl: BOOK_TTL_S });
  for (const channel of to) {
    const index = await readIndex(env, channel);
    await env.BOOKS.put(`index:${channel}`, JSON.stringify([book, ...index].slice(0, MAX_PER_CHANNEL)));
  }
  return json(book, 201);
}

async function list(env, url) {
  const from = channels(url.searchParams.get("from"));
  if (!from) return json({ error: "Bad channel." }, 400);
  const seen = new Set();
  const books = (await Promise.all(from.map((c) => readIndex(env, c))))
    .flat()
    .filter((b) => !seen.has(b.id) && seen.add(b.id))
    .sort((a, b) => b.time - a.time)
    .map((b) => ({ ...b, url: `${url.origin}/book/${b.id}/${encodeURIComponent(b.name)}`, expires: b.time + BOOK_TTL_S * 1000 }));
  return json(books);
}

async function download(env, id, name) {
  const body = await env.BOOKS.get(`book:${id}`, "stream");
  if (!body) return new Response("This book is no longer available. Send it again.", { status: 404, headers: CORS });
  return new Response(body, {
    headers: {
      ...CORS,
      "content-type": "application/epub+zip",
      "content-disposition": `attachment; filename="${decodeURIComponent(name).replace(/"/g, "")}"`,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, route, id, name] = url.pathname.split("/");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "PUT" && route === "drop") return drop(request, env, url);
    if (request.method === "GET" && route === "list") return list(env, url);
    if (request.method === "GET" && route === "book" && id && name) return download(env, id, name);
    return json({ error: "Not found." }, 404);
  },
};
