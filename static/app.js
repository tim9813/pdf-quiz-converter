const $ = (sel) => document.querySelector(sel);

const form = $("#form");
const drop = $("#drop");
const dropLabel = $("#drop-label");
const fileInput = $("#file");
const startInput = $("#start_page");
const endInput = $("#end_page");
const quickSel = $("#quick");
const pageHint = $("#page-hint");
const goBtn = $("#go");
const statusEl = $("#status");
const resultsEl = $("#results");
const countEl = $("#count");
const tbody = document.querySelector("#cards-table tbody");
const copyBtn = $("#copy");
const downloadBtn = $("#download");
const banner = $("#config-banner");

let selectedFile = null;
let totalPages = null;
let cards = [];

async function checkConfig() {
  try {
    const r = await fetch("/api/health");
    const j = await r.json();
    if (!j.key_configured) {
      banner.hidden = false;
      banner.classList.add("warn");
      banner.innerHTML = `No API key in <code>config.json</code>. Copy <code>config.example.json</code> to <code>config.json</code> and add your key.`;
    } else {
      banner.hidden = false;
      banner.classList.remove("warn");
      banner.innerHTML = `Using model <code>${j.model}</code> (configured in <code>config.json</code>).`;
    }
  } catch {
    /* ignore */
  }
}
checkConfig();

function setFile(f) {
  selectedFile = f;
  totalPages = null;
  if (f) {
    dropLabel.textContent = `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`;
    drop.classList.add("has-file");
    goBtn.disabled = false;
    fetchPageCount(f);
  } else {
    dropLabel.textContent = "Drop a PDF here, or click to choose";
    drop.classList.remove("has-file");
    goBtn.disabled = true;
    pageHint.textContent = "Leave “To page” blank to convert to the end of the document.";
  }
}

async function fetchPageCount(f) {
  pageHint.textContent = "Reading page count…";
  const fd = new FormData();
  fd.append("file", f);
  try {
    const r = await fetch("/api/pdf-info", { method: "POST", body: fd });
    const j = await r.json();
    if (r.ok) {
      totalPages = j.page_count;
      endInput.max = totalPages;
      startInput.max = totalPages;
      pageHint.textContent = `PDF has ${totalPages} pages. Leave “To page” blank for end.`;
    } else {
      pageHint.textContent = j.detail || "Could not read page count.";
    }
  } catch {
    pageHint.textContent = "Could not read page count.";
  }
}

drop.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => setFile(e.target.files[0] || null));

["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
  })
);
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f && f.type === "application/pdf") setFile(f);
  else showStatus("Please drop a PDF file.", true);
});

quickSel.addEventListener("change", () => {
  const v = quickSel.value;
  if (!v) return;
  startInput.value = 1;
  if (v === "all") endInput.value = "";
  else endInput.value = v;
});

function showStatus(html, isError = false) {
  statusEl.hidden = false;
  statusEl.classList.toggle("error", isError);
  statusEl.innerHTML = html;
}

function renderCards(list) {
  cards = list;
  countEl.textContent = String(list.length);
  tbody.innerHTML = "";
  for (const c of list) {
    const tr = document.createElement("tr");
    const t = document.createElement("td");
    const d = document.createElement("td");
    t.textContent = c.term;
    d.textContent = c.definition;
    tr.append(t, d);
    tbody.append(tr);
  }
  resultsEl.hidden = list.length === 0;
}

function toTSV(list) {
  return list
    .map((c) => `${c.term.replace(/\t/g, " ")}\t${c.definition.replace(/\t/g, " ").replace(/\n/g, " ")}`)
    .join("\n");
}

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(toTSV(cards));
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = "Copy for Quizlet"), 1500);
  } catch {
    showStatus("Could not copy. Use the download button instead.", true);
  }
});

downloadBtn.addEventListener("click", () => {
  const blob = new Blob([toTSV(cards)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "quizlet-import.txt";
  a.click();
  URL.revokeObjectURL(url);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selectedFile) return;

  const start = parseInt(startInput.value, 10) || 1;
  const end = parseInt(endInput.value, 10) || 0; // 0 = to end on the server

  goBtn.disabled = true;
  resultsEl.hidden = true;
  const range = end > 0 ? `pages ${start}–${end}` : `pages ${start}–end`;
  showStatus(`<span class="spinner"></span>Converting ${range}… roughly 3–6s per page.`);

  const fd = new FormData();
  fd.append("file", selectedFile);
  fd.append("start_page", String(start));
  fd.append("end_page", String(end));

  try {
    const resp = await fetch("/api/convert", { method: "POST", body: fd });
    const data = await resp.json();
    if (!resp.ok) {
      showStatus(`Error: ${data.detail || resp.statusText}`, true);
      return;
    }
    renderCards(data.cards || []);
    let msg = `Done. ${data.card_count} cards from pages ${data.page_range[0]}–${data.page_range[1]} (of ${data.total_pages}).`;
    if (data.errors?.length) msg += ` (${data.errors.length} page errors: ${data.errors.join("; ")})`;
    showStatus(msg);
  } catch (err) {
    showStatus(`Network error: ${err.message}`, true);
  } finally {
    goBtn.disabled = false;
  }
});
