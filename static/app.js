const $ = (sel) => document.querySelector(sel);

const form = $("#form");
const drop = $("#drop");
const dropLabel = $("#drop-label");
const fileInput = $("#file");
const pagesInput = $("#pages");
const quickSel = $("#quick");
const pageHint = $("#page-hint");
const goBtn = $("#go");
const statusEl = $("#status");
const resultsEl = $("#results");
const scoreEl = $("#score");
const totalEl = $("#total");
const metaEl = $("#meta");
const usageEl = $("#usage");
const questionsEl = $("#questions");
const revealBtn = $("#reveal");
const resetBtn = $("#reset");
const saveBtn = $("#save");
const exportBtn = $("#export");
const importBtn = $("#import-btn");
const importFileInput = $("#import-file");
const sessionsListEl = $("#sessions-list");
const banner = $("#config-banner");

const STORAGE_KEY = "pdf-quiz.sessions.v1";
const SESSION_SCHEMA = 1;

let selectedFile = null;
let totalPages = null;
let questions = [];
let answers = []; // chosen letter per question, or null
let currentMeta = null; // { name, model, usage, pages, total_pages, source }
let currentSessionId = null; // id when loaded from storage; null for fresh runs

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
    pageHint.innerHTML = `Leave blank for all pages. Use commas and ranges, e.g. <code>1,3,5-8,12</code>.`;
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
      pageHint.innerHTML = `PDF has <strong>${totalPages}</strong> pages. Use commas and ranges, e.g. <code>1,3,5-8,12</code>. Leave blank for all.`;
    } else {
      pageHint.textContent = j.detail || "Could not read page count.";
    }
  } catch {
    pageHint.textContent = "Could not read page count.";
  }
}

// Drop is a <label> wrapping the file <input>, so clicks bubble to the input natively — no JS click forwarder needed.
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
  pagesInput.value = v === "all" ? "" : v;
});

function showStatus(html, isError = false) {
  statusEl.hidden = false;
  statusEl.classList.toggle("error", isError);
  statusEl.innerHTML = html;
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}

function renderUsage(usage) {
  if (!usage) {
    usageEl.innerHTML = "";
    return;
  }
  usageEl.innerHTML = `
    <span class="pill">prompt: <strong>${fmtNum(usage.prompt_tokens)}</strong></span>
    <span class="pill">completion: <strong>${fmtNum(usage.completion_tokens)}</strong></span>
    <span class="pill total">total tokens: <strong>${fmtNum(usage.total_tokens)}</strong></span>
  `;
}

function isCorrect(q, a) {
  if (a === null || a === undefined || a === "") return false;
  if (q.type === "order") {
    if (!Array.isArray(a)) return false;
    const correct = Array.isArray(q.answer) ? q.answer : [];
    if (correct.length === 0 || a.length !== correct.length) return false;
    return a.every((x, i) => x === correct[i]);
  }
  if (q.type === "hotspot") {
    if (!Array.isArray(a)) return false;
    const subs = q.subquestions || [];
    if (a.length !== subs.length) return false;
    return a.every((v, i) => v && v === subs[i].answer);
  }
  return a === q.answer;
}

function isAnswered(a) {
  if (a === null || a === undefined) return false;
  if (Array.isArray(a)) return true; // [] counts as "submitted but empty"
  return true;
}

function updateScore() {
  const correct = answers.reduce(
    (n, a, i) => n + (isCorrect(questions[i], a) ? 1 : 0),
    0
  );
  scoreEl.textContent = String(correct);
  totalEl.textContent = String(questions.length);
}

function renderQuestions() {
  questionsEl.innerHTML = "";
  questions.forEach((q, idx) => {
    const card = document.createElement("article");
    card.className = `qcard ${q.type === "order" ? "qcard-order" : ""} ${q.type === "hotspot" ? "qcard-hotspot" : ""}`.trim();
    card.dataset.idx = String(idx);

    const head = document.createElement("div");
    head.className = "qhead";
    const numLabel = Number.isInteger(q.number) ? `Q${q.number}` : `Q${idx + 1}`;
    const typeLabel = q.type === "order"
      ? `<span class="qtype">drag-drop</span>`
      : q.type === "hotspot"
      ? `<span class="qtype">hotspot</span>`
      : "";
    head.innerHTML = `<span class="qnum"></span>${typeLabel}${q.page ? `<span class="qpage">page ${q.page}</span>` : ""}`;
    head.querySelector(".qnum").textContent = numLabel;
    card.append(head);

    const stem = document.createElement("p");
    stem.className = "qstem";
    stem.textContent = q.question;
    card.append(stem);

    const imgs = Array.isArray(q.images) ? q.images : (q.image ? [q.image] : []);
    if (imgs.length) {
      const gallery = document.createElement("div");
      gallery.className = "qimg-gallery";
      imgs.forEach((src, i) => {
        const img = document.createElement("img");
        img.className = "qimg";
        img.loading = "lazy";
        img.src = src;
        img.alt = `Exhibit ${i + 1} from page ${q.page || ""}`;
        gallery.append(img);
      });
      card.append(gallery);
    }

    if (q.type === "order") {
      card.append(buildOrderUi(idx, q));
    } else if (q.type === "hotspot") {
      card.append(buildHotspotUi(idx, q));
    } else {
      card.append(buildMcqUi(idx, q));
    }

    questionsEl.append(card);
  });

  answers.forEach((a, i) => {
    if (isAnswered(a)) paintCard(i);
  });

  updateScore();
}

function buildMcqUi(idx, q) {
  const opts = document.createElement("div");
  opts.className = "qopts";
  const letters = ["A", "B", "C", "D", "E", "F"].filter((L) => L in q.options);
  for (const letter of letters) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt";
    b.dataset.letter = letter;
    b.innerHTML = `<span class="letter">${letter}</span><span class="text"></span>`;
    b.querySelector(".text").textContent = q.options[letter];
    b.addEventListener("click", () => choose(idx, letter));
    opts.append(b);
  }
  return opts;
}

function buildOrderUi(idx, q) {
  const wrap = document.createElement("div");
  wrap.className = "order-wrap";
  wrap.innerHTML = `
    <div class="order-grid">
      <div class="order-col">
        <div class="col-label">Options <span class="hint-inline">(click to add)</span></div>
        <div class="pool"></div>
      </div>
      <div class="order-col">
        <div class="col-label">Your answer <span class="hint-inline">(click an item to remove)</span></div>
        <div class="answer-pool"></div>
      </div>
    </div>
    <div class="order-foot">
      <button type="button" class="check-btn">Check answer</button>
      <button type="button" class="ghost clear-btn">Clear</button>
    </div>
  `;
  const pool = wrap.querySelector(".pool");
  const ansPool = wrap.querySelector(".answer-pool");
  const checkBtn = wrap.querySelector(".check-btn");
  const clearBtn = wrap.querySelector(".clear-btn");

  function rebuild(currentChoice) {
    pool.innerHTML = "";
    ansPool.innerHTML = "";
    q.options.forEach((opt) => {
      const inUse = currentChoice.includes(opt);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ord-item pool-item";
      b.textContent = opt;
      b.disabled = inUse;
      b.addEventListener("click", () => {
        const next = [...currentChoice, opt];
        rebuild(next);
      });
      pool.append(b);
    });
    currentChoice.forEach((opt, pos) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ord-item ans-item";
      b.innerHTML = `<span class="pos">${pos + 1}.</span><span class="text"></span>`;
      b.querySelector(".text").textContent = opt;
      b.addEventListener("click", () => {
        const next = currentChoice.filter((_, i) => i !== pos);
        rebuild(next);
      });
      ansPool.append(b);
    });
    // Cache the in-progress draft on the card itself so paintCard can read it.
    wrap._draft = currentChoice;
  }

  rebuild(Array.isArray(answers[idx]) ? answers[idx] : []);

  checkBtn.addEventListener("click", () => {
    answers[idx] = wrap._draft.slice();
    paintCard(idx);
    updateScore();
    persistCurrentAnswers();
  });
  clearBtn.addEventListener("click", () => rebuild([]));

  return wrap;
}

function buildHotspotUi(idx, q) {
  const wrap = document.createElement("div");
  wrap.className = "hotspot-wrap";
  const subs = q.subquestions || [];
  wrap._draft = Array.isArray(answers[idx]) && answers[idx].length === subs.length
    ? answers[idx].slice()
    : new Array(subs.length).fill(null);

  subs.forEach((sub, sIdx) => {
    const row = document.createElement("div");
    row.className = "hotspot-row";
    row.dataset.sub = String(sIdx);

    const label = document.createElement("div");
    label.className = "hotspot-label";
    label.textContent = sub.label;
    row.append(label);

    const opts = document.createElement("div");
    opts.className = "hotspot-opts";
    sub.options.forEach((opt) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt hotspot-opt";
      b.dataset.value = opt;
      const span = document.createElement("span");
      span.className = "text";
      span.textContent = opt;
      b.append(span);
      b.addEventListener("click", () => {
        wrap._draft[sIdx] = opt;
        row.querySelectorAll(".hotspot-opt").forEach((btn) => {
          btn.classList.toggle("chosen", btn.dataset.value === opt);
        });
      });
      if (wrap._draft[sIdx] === opt) b.classList.add("chosen");
      opts.append(b);
    });
    row.append(opts);
    wrap.append(row);
  });

  const foot = document.createElement("div");
  foot.className = "order-foot";
  foot.innerHTML = `
    <button type="button" class="check-btn">Check answers</button>
    <button type="button" class="ghost clear-btn">Clear</button>
  `;
  foot.querySelector(".check-btn").addEventListener("click", () => {
    answers[idx] = wrap._draft.slice();
    paintCard(idx);
    updateScore();
    persistCurrentAnswers();
  });
  foot.querySelector(".clear-btn").addEventListener("click", () => {
    wrap._draft = new Array(subs.length).fill(null);
    wrap.querySelectorAll(".hotspot-opt.chosen").forEach((b) => b.classList.remove("chosen"));
  });
  wrap.append(foot);
  return wrap;
}

function choose(idx, letter) {
  if (answers[idx]) return;
  answers[idx] = letter;
  paintCard(idx);
  updateScore();
  persistCurrentAnswers();
}

function paintCard(idx) {
  const card = questionsEl.querySelector(`.qcard[data-idx="${idx}"]`);
  if (!card) return;
  const q = questions[idx];
  const chosen = answers[idx];
  card.classList.add("answered");

  if (q.type === "order") {
    paintOrderCard(card, q, Array.isArray(chosen) ? chosen : []);
    return;
  }

  if (q.type === "hotspot") {
    paintHotspotCard(card, q, Array.isArray(chosen) ? chosen : []);
    return;
  }

  card.querySelectorAll(".opt").forEach((btn) => {
    const letter = btn.dataset.letter;
    btn.classList.remove("chosen", "correct", "wrong");
    if (q.answer && letter === q.answer) btn.classList.add("correct");
    if (chosen && letter === chosen && chosen !== q.answer) btn.classList.add("wrong");
    if (chosen && letter === chosen) btn.classList.add("chosen");
    btn.disabled = true;
  });
}

function paintHotspotCard(card, q, chosen) {
  const wrap = card.querySelector(".hotspot-wrap");
  if (!wrap) return;
  wrap.querySelectorAll(".hotspot-opt").forEach((b) => (b.disabled = true));
  card.querySelector(".check-btn")?.setAttribute("disabled", "true");
  card.querySelector(".clear-btn")?.setAttribute("disabled", "true");

  const subs = q.subquestions || [];
  let anyMissing = false;

  wrap.querySelectorAll(".hotspot-row").forEach((row, sIdx) => {
    const correct = subs[sIdx]?.answer || "";
    const picked = chosen[sIdx];
    if (!correct) anyMissing = true;
    row.querySelectorAll(".hotspot-opt").forEach((btn) => {
      btn.classList.remove("chosen", "correct", "wrong");
      const val = btn.dataset.value;
      if (correct && val === correct) btn.classList.add("correct");
      if (picked && val === picked) btn.classList.add("chosen");
      if (picked && val === picked && correct && val !== correct) btn.classList.add("wrong");
    });
  });

  const allMissing = subs.every((s) => !s.answer);
  if (allMissing && wrap.querySelector(".order-solution") === null) {
    const note = document.createElement("div");
    note.className = "order-solution";
    const lbl = document.createElement("div");
    lbl.className = "col-label missing";
    lbl.textContent = "Correct answers not detected on the PDF page";
    note.append(lbl);
    wrap.append(note);
  }
}

function paintOrderCard(card, q, chosen) {
  // Disable interactive controls; show user's chosen sequence with correctness, plus the correct answer for reference.
  const wrap = card.querySelector(".order-wrap");
  if (!wrap) return;
  wrap.querySelectorAll(".pool-item").forEach((b) => (b.disabled = true));
  wrap.querySelectorAll(".ans-item").forEach((b) => (b.disabled = true));
  card.querySelector(".check-btn")?.setAttribute("disabled", "true");
  card.querySelector(".clear-btn")?.setAttribute("disabled", "true");

  const correct = Array.isArray(q.answer) ? q.answer : [];
  const ansPool = wrap.querySelector(".answer-pool");
  ansPool.querySelectorAll(".ans-item").forEach((btn, pos) => {
    const text = btn.querySelector(".text").textContent;
    btn.classList.remove("correct", "wrong");
    if (correct[pos] === text) btn.classList.add("correct");
    else btn.classList.add("wrong");
  });

  // Append a "Correct sequence" block whenever the user's answer is wrong (or empty).
  const allRight =
    correct.length > 0 &&
    chosen.length === correct.length &&
    chosen.every((x, i) => x === correct[i]);
  if (!allRight && wrap.querySelector(".order-solution") === null) {
    const solution = document.createElement("div");
    solution.className = "order-solution";
    const label = document.createElement("div");
    label.className = "col-label";
    if (correct.length === 0) {
      label.textContent = "Correct answer not detected on the PDF page";
      label.classList.add("missing");
      solution.append(label);
    } else {
      label.textContent = "Correct order";
      const list = document.createElement("div");
      list.className = "answer-pool";
      correct.forEach((opt, pos) => {
        const b = document.createElement("div");
        b.className = "ord-item ans-item correct";
        b.innerHTML = `<span class="pos">${pos + 1}.</span><span class="text"></span>`;
        b.querySelector(".text").textContent = opt;
        list.append(b);
      });
      solution.append(label, list);
    }
    wrap.append(solution);
  }
}

revealBtn.addEventListener("click", () => {
  questions.forEach((q, i) => {
    if (!isAnswered(answers[i])) {
      if (q.type === "order") answers[i] = [];
      else if (q.type === "hotspot") answers[i] = (q.subquestions || []).map(() => null);
      else answers[i] = "";
    }
    paintCard(i);
  });
  updateScore();
  persistCurrentAnswers();
});

resetBtn.addEventListener("click", () => {
  answers = questions.map(() => null);
  renderQuestions();
  persistCurrentAnswers();
});

// ---------- Session storage ----------

function loadAllSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveAllSessions(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    showStatus(`Could not save: ${err.message}. Local storage may be full.`, true);
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function buildSessionPayload(name) {
  return {
    schema: SESSION_SCHEMA,
    id: currentSessionId || newId(),
    name: name || (currentMeta?.name ?? "Untitled session"),
    createdAt: new Date().toISOString(),
    source: currentMeta?.source || null,
    model: currentMeta?.model || null,
    pages: currentMeta?.pages || null,
    total_pages: currentMeta?.total_pages || null,
    usage: currentMeta?.usage || null,
    questions,
    answers,
  };
}

function deriveSessionName(qs, fallback) {
  const nums = qs.map((q) => q.number).filter((n) => Number.isInteger(n));
  if (nums.length === 0) return fallback || "Quiz session";
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return min === max ? `Q${min}` : `Q${min}-Q${max}`;
}

function autoSaveSession() {
  if (questions.length === 0) return;
  const fallback = currentMeta?.source ? currentMeta.source.replace(/\.pdf$/i, "") : "Quiz session";
  const name = deriveSessionName(questions, fallback);
  currentMeta = { ...(currentMeta || {}), name };
  const payload = buildSessionPayload(name);
  currentSessionId = payload.id;
  const list = loadAllSessions();
  const idx = list.findIndex((s) => s.id === payload.id);
  if (idx === -1) list.push(payload);
  else list[idx] = payload;
  saveAllSessions(list);
  renderSessionsList();
}

function persistCurrentAnswers() {
  if (!currentSessionId) return;
  const list = loadAllSessions();
  const idx = list.findIndex((s) => s.id === currentSessionId);
  if (idx === -1) return;
  list[idx] = { ...list[idx], answers, updatedAt: new Date().toISOString() };
  saveAllSessions(list);
  renderSessionsList();
}

function renderSessionsList() {
  const list = loadAllSessions();
  if (list.length === 0) {
    sessionsListEl.innerHTML = `<p class="hint empty">No saved sessions yet. Generate a quiz — it'll auto-save here.</p>`;
    return;
  }
  sessionsListEl.innerHTML = "";
  list
    .slice()
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .forEach((s) => {
      const correct = (s.answers || []).reduce(
        (n, a, i) => n + (a && a === s.questions[i]?.answer ? 1 : 0),
        0
      );
      const row = document.createElement("div");
      row.className = "session-row";
      row.dataset.id = s.id;
      row.innerHTML = `
        <div class="session-info">
          <div class="session-name"></div>
          <div class="session-sub"></div>
        </div>
        <div class="session-actions">
          <button type="button" class="ghost load-btn">Load</button>
          <button type="button" class="ghost export-row-btn">Export</button>
          <button type="button" class="ghost danger delete-btn">Delete</button>
        </div>
      `;
      row.querySelector(".session-name").textContent = s.name || "Untitled";
      const created = s.createdAt ? new Date(s.createdAt).toLocaleString() : "";
      const tokens = s.usage?.total_tokens ? `${fmtNum(s.usage.total_tokens)} tokens` : "no usage info";
      row.querySelector(".session-sub").textContent =
        `${s.questions?.length || 0} questions · ${correct} answered correctly · ${tokens}${created ? " · " + created : ""}`;
      row.querySelector(".load-btn").addEventListener("click", () => loadSession(s.id));
      row.querySelector(".export-row-btn").addEventListener("click", () => exportSession(s));
      row.querySelector(".delete-btn").addEventListener("click", () => deleteSession(s.id));
      sessionsListEl.append(row);
    });
}

function loadSession(id) {
  const list = loadAllSessions();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  currentSessionId = s.id;
  currentMeta = {
    name: s.name,
    source: s.source,
    model: s.model,
    pages: s.pages,
    total_pages: s.total_pages,
    usage: s.usage,
  };
  questions = Array.isArray(s.questions) ? s.questions : [];
  answers = Array.isArray(s.answers) && s.answers.length === questions.length
    ? s.answers.slice()
    : questions.map(() => null);
  renderQuestions();
  renderUsage(s.usage);
  metaEl.textContent =
    `${s.name || "Untitled"} · ${questions.length} questions` +
    (s.pages?.length ? ` · pages ${formatPagesList(s.pages)}` : "") +
    (s.model ? ` · model ${s.model}` : "") +
    (s.source ? ` · ${s.source}` : "");
  resultsEl.hidden = questions.length === 0;
  showStatus(`Loaded session "${s.name}". No tokens used.`);
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function deleteSession(id) {
  if (!confirm("Delete this saved session?")) return;
  const list = loadAllSessions().filter((s) => s.id !== id);
  saveAllSessions(list);
  if (currentSessionId === id) currentSessionId = null;
  renderSessionsList();
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function safeFilename(name) {
  return (name || "session").replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60) || "session";
}

function exportSession(s) {
  downloadJson(`${safeFilename(s.name)}.quiz.json`, s);
}

function formatPagesList(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return "";
  // Compress contiguous runs into ranges for display only.
  const sorted = pages.slice().sort((a, b) => a - b);
  const parts = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i];
    if (p === prev + 1) {
      prev = p;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = p;
    prev = p;
  }
  parts.push(start === prev ? String(start) : `${start}-${prev}`);
  return parts.join(",");
}

saveBtn.addEventListener("click", () => {
  if (questions.length === 0 || !currentSessionId) return;
  const defaultName = currentMeta?.name || "Quiz session";
  const name = prompt("Rename session:", defaultName);
  if (name === null) return;
  const trimmed = name.trim() || defaultName;
  currentMeta = { ...(currentMeta || {}), name: trimmed };
  const list = loadAllSessions();
  const idx = list.findIndex((s) => s.id === currentSessionId);
  if (idx !== -1) {
    list[idx] = { ...list[idx], name: trimmed, updatedAt: new Date().toISOString() };
    saveAllSessions(list);
    renderSessionsList();
  }
  metaEl.textContent = metaEl.textContent.replace(/^[^·]*·/, `${trimmed} ·`);
  showStatus(`Renamed to "${trimmed}".`);
});

exportBtn.addEventListener("click", () => {
  if (questions.length === 0) return;
  const name = currentMeta?.name || "Quiz session";
  const payload = buildSessionPayload(name);
  exportSession(payload);
});

importBtn.addEventListener("click", () => importFileInput.click());

importFileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ""; // allow re-picking the same file later
  if (!file) return;
  try {
    const text = await file.text();
    const obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.questions)) {
      throw new Error("Not a valid quiz session file.");
    }
    const imported = {
      schema: SESSION_SCHEMA,
      id: newId(),
      name: obj.name || file.name.replace(/\.json$/i, ""),
      createdAt: new Date().toISOString(),
      source: obj.source || null,
      model: obj.model || null,
      pages: obj.pages || null,
      total_pages: obj.total_pages || null,
      usage: obj.usage || null,
      questions: obj.questions,
      answers: Array.isArray(obj.answers) && obj.answers.length === obj.questions.length
        ? obj.answers
        : obj.questions.map(() => null),
    };
    const list = loadAllSessions();
    list.push(imported);
    saveAllSessions(list);
    renderSessionsList();
    loadSession(imported.id);
    showStatus(`Imported "${imported.name}".`);
  } catch (err) {
    showStatus(`Import failed: ${err.message}`, true);
  }
});

// ---------- Convert ----------

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selectedFile) return;

  const pagesSpec = pagesInput.value.trim();

  goBtn.disabled = true;
  resultsEl.hidden = true;
  const rangeLabel = pagesSpec ? `pages ${pagesSpec}` : "all pages";
  showStatus(`<span class="spinner"></span>Generating quiz from ${rangeLabel}… roughly 3–6s per page.`);

  const fd = new FormData();
  fd.append("file", selectedFile);
  fd.append("pages", pagesSpec);

  try {
    const resp = await fetch("/api/convert", { method: "POST", body: fd });
    const data = await resp.json();
    if (!resp.ok) {
      showStatus(`Error: ${data.detail || resp.statusText}`, true);
      return;
    }
    questions = data.questions || [];
    answers = questions.map(() => null);
    currentSessionId = null;
    currentMeta = {
      name: null,
      source: selectedFile.name,
      model: data.model,
      pages: data.pages,
      total_pages: data.total_pages,
      usage: data.usage,
    };
    renderQuestions();
    renderUsage(data.usage);
    autoSaveSession(); // assigns currentSessionId and currentMeta.name
    metaEl.textContent =
      `${currentMeta.name} · ${data.question_count} questions from pages ${formatPagesList(data.pages)} (of ${data.total_pages}). Model: ${data.model}.` +
      (data.errors?.length ? ` ${data.errors.length} page error(s).` : "");
    resultsEl.hidden = questions.length === 0;
    showStatus(
      `Done. Saved as <strong>${currentMeta.name}</strong>. ${data.question_count} questions. Tokens used — prompt ${fmtNum(data.usage.prompt_tokens)}, completion ${fmtNum(data.usage.completion_tokens)}, total ${fmtNum(data.usage.total_tokens)}.`
    );
  } catch (err) {
    showStatus(`Network error: ${err.message}`, true);
  } finally {
    goBtn.disabled = false;
  }
});

// initial render
renderSessionsList();
