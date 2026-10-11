const RELAY = "https://ntfy.sh";
const TOPIC_PREFIX = "kobodrop-";
const MAX_BYTES = 15 * 1024 * 1024;
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
  if (/\.kepub\.epub$/i.test(file.name)) return bytes;
  await converterReady;
  const result = window.kepubify(bytes);
  if (result.error) throw new Error("This file is not a valid EPUB, so it cannot be converted.");
  return result.data;
}

async function findHomeTopic() {
  try {
    const { ip } = await (await fetch("https://api4.ipify.org?format=json")).json();
    if (ip) return `${TOPIC_PREFIX}home-${ip.replaceAll(".", "-")}`;
  } catch {}
  try {
    const ip = (await (await fetch("https://ipv4.icanhazip.com")).text()).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return `${TOPIC_PREFIX}home-${ip.replaceAll(".", "-")}`;
  } catch {}
  return null;
}

async function publish(topic, init) {
  const res = await fetch(`${RELAY}/${topic}`, init);
  if (!res.ok) throw new Error(`The relay refused the book (error ${res.status}). Try again in a minute.`);
  return res.json();
}

async function upload(bytes, name) {
  const codeTopic = TOPIC_PREFIX + code;
  const homeTopic = await findHomeTopic();
  const sent = await publish(homeTopic || codeTopic, { method: "PUT", headers: { Filename: name }, body: bytes });
  if (homeTopic) {
    await publish(codeTopic, { method: "POST", headers: { Filename: name, Attach: sent.attachment.url } });
  }
}

function addRow(name) {
  const li = document.createElement("li");
  const title = document.createElement("span");
  const state = document.createElement("span");
  title.className = "name";
  state.className = "state";
  title.textContent = name.replace(/\.epub$/i, "");
  li.append(title, state);
  $("sent").prepend(li);
  return (text, kind) => {
    state.textContent = text;
    li.className = kind || "";
  };
}

async function send(file) {
  const setState = addRow(file.name);
  try {
    if (!/\.epub$/i.test(file.name)) throw new Error("Only EPUB files can go to the Kobo from here.");
    setState("Converting");
    const bytes = await toKepub(file);
    if (bytes.length > MAX_BYTES) throw new Error("This book is larger than 15 MB, which is the limit.");
    setState("Sending");
    await upload(bytes, kepubName(file.name));
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setState(`On the Kobo page, ${time}`, "done");
  } catch (err) {
    setState(err instanceof TypeError ? "No connection to the relay. Check the internet connection and try again." : err.message, "failed");
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
