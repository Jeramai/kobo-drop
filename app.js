const API = "https://kobo-drop.jeramai.workers.dev";
const PART_BYTES = 20 * 1024 * 1024;
const MAX_BYTES = 5 * PART_BYTES;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const $ = (id) => document.getElementById(id);

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return chars.slice(0, 4) + "-" + chars.slice(4);
}

function normalizeCode(raw) {
  const chars = String(raw || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return chars.length === 8 ? chars.slice(0, 4) + "-" + chars.slice(4) : null;
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {}
  return value;
}

let code = normalizeCode(new URLSearchParams(location.search).get("c")) || normalizeCode(storage("code")) || newCode();
storage("code", code);

function showCode() {
  $("code").textContent = code;
  $("kobo-addr").textContent = new URL("k/", location.href).href.replace(/^https?:\/\//, "");
}
showCode();
findHomeChannel();
$("setup").open = !storage("sentOnce");

$("code-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const next = normalizeCode($("code-input").value);
  if (!next) {
    $("code-input").setCustomValidity("A code has 8 letters and numbers, like abcd-efgh.");
    $("code-input").reportValidity();
    return;
  }
  code = storage("code", next);
  $("code-input").value = "";
  showCode();
});
$("code-input").addEventListener("input", (e) => e.target.setCustomValidity(""));

const converterReady = (async () => {
  const go = new Go();
  const { instance } = await WebAssembly.instantiateStreaming(fetch("kepubify.wasm"), go.importObject);
  go.run(instance);
})();

function kepubName(name) {
  const base = name.replace(/\.kepub\.epub$/i, "").replace(/\.epub$/i, "");
  return base + ".kepub.epub";
}

async function toKepub(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await converterReady;
  const meta = window.epubMeta(bytes);
  if (/\.kepub\.epub$/i.test(file.name)) return { bytes, meta };
  const result = window.kepubify(bytes);
  if (result.error) throw new Error("This file is not a valid EPUB, so it cannot be converted.");
  return { bytes: result.data, meta };
}

async function thumbnail(cover, type) {
  if (!cover) return null;
  try {
    const image = await createImageBitmap(new Blob([cover], { type }));
    const width = Math.min(240, image.width);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round((image.height / image.width) * width);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  } catch {
    return null;
  }
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

async function findHomeIp() {
  try {
    const { ip } = await (await fetch("https://api4.ipify.org?format=json")).json();
    if (IPV4.test(ip)) return ip;
  } catch {}
  try {
    const ip = (await (await fetch("https://ipv4.icanhazip.com")).text()).trim();
    if (IPV4.test(ip)) return ip;
  } catch {}
  return null;
}

async function findHomeChannel() {
  const ip = await findHomeIp();
  showWhere(ip);
  return ip ? `home-${ip.replaceAll(".", "-")}` : null;
}

function showWhere(ip) {
  $("where").innerHTML = ip
    ? `Sends to every Kobo on this Wi-Fi network (<b>${ip.split(".").slice(2).join(".")}</b>), and to Kobos with the code.`
    : "Cannot find this Wi-Fi network. Books go only to Kobos with the code.";
}

function post(url, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded);
    xhr.onerror = () => reject(new Error("No connection to the server. Check the internet connection and try again."));
    xhr.onload = () => {
      if (xhr.status === 413) reject(new Error("This book is larger than 100 MB, which is the limit."));
      else if (xhr.status >= 300) reject(new Error(`The server refused the book (error ${xhr.status}). Try again in a minute.`));
      else resolve();
    };
    xhr.send(body);
  });
}

function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

async function upload(bytes, form, onProgress) {
  const id = newId();
  const parts = Math.ceil(bytes.length / PART_BYTES);
  for (let n = 0; n < parts; n++) {
    const start = n * PART_BYTES;
    await post(`${API}/part/${id}/${n}`, new Blob([bytes.subarray(start, start + PART_BYTES)]), (loaded) =>
      onProgress((start + loaded) / bytes.length)
    );
  }
  form.append("id", id);
  form.append("parts", parts);
  form.append("size", bytes.length);
  form.append("to", [await findHomeChannel(), code].filter(Boolean).join(","));
  await post(`${API}/drop`, form);
}

function addRow(name) {
  const li = document.createElement("li");
  const cover = document.createElement("img");
  const title = document.createElement("span");
  const author = document.createElement("span");
  const state = document.createElement("span");
  cover.className = "cover";
  cover.alt = "";
  title.className = "title";
  author.className = "author";
  state.className = "state";
  title.textContent = name.replace(/\.kepub\.epub$/i, "").replace(/\.epub$/i, "");
  li.append(cover, title, author, state);
  $("sent").prepend(li);
  return {
    details(meta, thumb) {
      if (meta.title) title.textContent = meta.title;
      if (meta.author) author.textContent = meta.author;
      if (thumb) cover.src = URL.createObjectURL(thumb);
    },
    state(text, kind) {
      state.textContent = text;
      li.className = kind || "";
    },
  };
}

async function send(file) {
  const row = addRow(file.name);
  try {
    if (!/\.epub$/i.test(file.name)) throw new Error("Only EPUB files can go to the Kobo from here.");
    row.state("Converting");
    const { bytes, meta } = await toKepub(file);
    if (bytes.length > MAX_BYTES) throw new Error("This book is larger than 100 MB, which is the limit.");
    const thumb = await thumbnail(meta.cover, meta.coverType);
    row.details(meta, thumb);

    const form = new FormData();
    form.append("name", kepubName(file.name));
    form.append("title", meta.title || "");
    form.append("author", meta.author || "");
    if (thumb) form.append("cover", thumb, "cover.jpg");

    row.state("Sending");
    await upload(bytes, form, (part) => row.state(`Sending, ${Math.round(part * 100)}%`));
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    row.state(`On the Kobo page, ${time}`, "done");
    storage("sentOnce", "1");
  } catch (err) {
    row.state(err.message, "failed");
  }
}

function sendAll(files) {
  for (const file of files) send(file);
}

$("file").addEventListener("change", (e) => {
  sendAll(e.target.files);
  e.target.value = "";
});

const drop = $("drop");
["dragenter", "dragover"].forEach((type) =>
  window.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  })
);
["dragleave", "drop"].forEach((type) =>
  window.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === "drop" || e.relatedTarget === null) drop.classList.remove("over");
  })
);
window.addEventListener("drop", (e) => sendAll(e.dataTransfer.files));
