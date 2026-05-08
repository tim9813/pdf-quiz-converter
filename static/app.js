const $ = (sel) => document.querySelector(sel);

const form = $("#form");
const drop = $("#drop");
const dropLabel = $("#drop-label");
const fileInput = $("#file");
const apiKeyInput = $("#api_key");
const modelInput = $("#model");
const goBtn = $("#go");
const statusEl = $("#status");
const resultsEl = $("#results");
const countEl = $("#count");
const tbody = document.querySelector("#cards-table tbody");
const copyBtn = $("#copy");
const downloadBtn = $("#download");

// Persist API key + model in localStorage so users don't retype.
apiKeyInput.value = localStorage.getItem("openai_api_key") || "";
modelInput.value = localStorage.getItem("openai_model") || modelInput.value;
apiKeyInput.addEventListener("change", () => localStorage.setItem("openai_api_key", apiKeyInput.value));
modelInput.addEventListener("change", () => localStorage.setItem("openai_model", modelInput.value));

let selectedFile = null;
let cards = [];

function setFile(f) {
  selectedFile = f;
  if (f) {
    dropLabel.textContent = `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`;
    drop.classList.add("has-file");
    goBtn.disabled = false;
  } else {
    dropLabel.textContent = "Drop a PDF here, or click to choose";
    drop.classList.remove("has-file");
    goBtn.disabled = true;
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

function showStatus(html, isError = false) {
  statusEl.hidden = false;
  statusEl.classList.toggle("error", isError);
  statusEl.innerHTML = html;
}
function clearStatus() {
  statusEl.hidden = true;
  statusEl.classList.remove("error");
  statusEl.innerHTML = "";
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
  const text = toTSV(cards);
  try {
    await navigator.clipboard.writeText(text);
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

  goBtn.disabled = true;
  resultsEl.hidden = true;
  showStatus(`<span class="spinner"></span>Converting… this can take ~3–6s per page.`);

  const fd = new FormData();
  fd.append("file", selectedFile);
  fd.append("api_key", apiKeyInput.value.trim());
  fd.append("model", modelInput.value.trim() || "gpt-4o");

  try {
    const resp = await fetch("/api/convert", { method: "POST", body: fd });
    const data = await resp.json();
    if (!resp.ok) {
      showStatus(`Error: ${data.detail || resp.statusText}`, true);
      return;
    }
    renderCards(data.cards || []);
    let msg = `Done. ${data.card_count} cards from ${data.page_count} pages.`;
    if (data.errors?.length) msg += ` (${data.errors.length} page errors: ${data.errors.join("; ")})`;
    showStatus(msg);
  } catch (err) {
    showStatus(`Network error: ${err.message}`, true);
  } finally {
    goBtn.disabled = false;
  }
});
