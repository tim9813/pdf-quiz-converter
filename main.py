import asyncio
import base64
import json
import os
import re
from pathlib import Path

import fitz  # PyMuPDF
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI, OpenAIError

load_dotenv()

app = FastAPI(title="PDF → Quiz Converter")

ROOT = Path(__file__).parent
CONFIG_PATH = ROOT / "config.json"

RENDER_DPI = int(os.environ.get("RENDER_DPI", "150"))
EMBED_JPEG_QUALITY = int(os.environ.get("EMBED_JPEG_QUALITY", "70"))
MAX_CONCURRENCY = int(os.environ.get("MAX_CONCURRENCY", "5"))
MAX_PAGES = int(os.environ.get("MAX_PAGES", "100"))
MAX_LOOKAHEAD_EXTRA = int(os.environ.get("MAX_LOOKAHEAD_EXTRA", "3"))

QUESTION_HEADER_RE = re.compile(r"\bQUESTION\s+(\d+)\b", re.IGNORECASE)

EXTRACTION_PROMPT = """You are extracting pre-written quiz questions from a PDF question bank.

You will see ONE OR MORE page images for the SAME question. The first image is PAGE A (where the question header lives). Subsequent images (if present) are the next pages of the SAME question in source-PDF order — they may carry exhibits, the question's answer area, the filled-in answer, and the answer key / explanation.

Extract questions whose stem starts on PAGE A. Do NOT extract questions from later pages. Do NOT invent questions or distractors.

Three question types are possible:

1. Multiple choice — has a header like "QUESTION N" and lettered options (A, B, C, ...). The "Answer: X" line gives the correct letter.
   Schema: {"number": 23, "type": "mcq", "question": "...", "options": {"A": "...", "B": "..."}, "answer": "B"}

2. Drag-drop / "Select and Place" — has a "QUESTION N" header and a "DRAG DROP" or "Select and Place" sub-header. Page A shows an Options column (labeled boxes) and an empty Answer column, with "Correct Answer:" near the bottom. Page B (if present) shows the SAME page layout but with the Answer column FILLED IN — those filled-in items are the correct ordered answer.
   Schema: {"number": 24, "type": "order", "question": "...", "options": ["Hyper-V site", "Storage account", "..."], "answer": ["Hyper-V site", "Replication policy"]}

Rules for "order" questions:
- Put EVERY box from the Options column into "options" as an array of strings, in the order shown on page A.
- Read the filled-in Answer column on page B and put those items, in the order shown there, into "answer". Each "answer" entry MUST exactly equal one of the "options" strings.
- If page B is missing or its Answer column is empty, set "answer" to [].

CRITICAL — drag-drop continuation pages: If page A IS a drag-drop page whose Answer column on page A is ALREADY FILLED IN with items (instead of empty), then page A is the SECOND/continuation page of a question that started on the previous page. DO NOT extract it as a new question — return an empty questions list for this call. Only extract drag-drop questions from the page where the Answer column is empty.

3. HOTSPOT — has a "QUESTION N" header and a "HOTSPOT" or "Hot Area" sub-header. Page A shows an "Answer Area" with multiple ROWS. Each row is one sub-question that the student answers independently. Two sub-shapes exist:
   - Dropdown rows: a row label (e.g. "To add a backend pool to LB1:") followed by a dropdown that lists 2+ option strings; one is correct.
   - Yes/No grid: a list of statement rows; each row has Yes and No checkboxes; one is correct per row.
   Page A is unanswered: no option is highlighted/selected. Page B (if present) shows the SAME layout with the correct option for each row visibly highlighted (often green-shaded) — that highlighted choice is the answer.
   Schema: {
     "number": 41, "type": "hotspot", "question": "...stem with full instructions...",
     "subquestions": [
       {"label": "To add a backend pool to LB1:", "options": ["Contributor on LB1", "Network Contributor on LB1", "Network Contributor on RG1", "Owner on LB1"], "answer": "Network Contributor on LB1"},
       {"label": "User1 can perform an access review of User4.", "options": ["Yes", "No"], "answer": "No"}
     ]
   }

Rules for "hotspot" questions:
- Each row in the Answer Area becomes one entry in "subquestions", in the order shown on page A.
- "label" is the row text exactly as written.
- "options" is the row's selectable values, in the order shown. For Yes/No grids, this is ["Yes", "No"].
- "answer" is the highlighted/selected option from page B and MUST equal one of "options". If page B is missing or no row is highlighted, set "answer" to "".
- Always include EVERY row from page A as a subquestion, even if its answer is unknown.

CRITICAL — hotspot continuation pages: If page A is a HOTSPOT page where the Answer Area already has options HIGHLIGHTED/SELECTED, page A is the SECOND/continuation page. Return an empty questions list for this call.

Rules for "mcq" questions:
- Only include letter keys that actually appear on the page (could be 2, 3, 4, 5, or 6).
- If no "Answer:" line is on page A, set "answer" to "".

Copy text exactly as written. Skip pages with no QUESTION header (return empty list).

ADDITIONAL FLAG — set "has_exhibit": true ONLY IF the question references a SCREENSHOT, IMAGE, DIAGRAM, or graphical EXHIBIT (e.g. an Azure portal screenshot, a network topology diagram, a UI shown in a figure) that the user MUST see to answer. A simple inline TABLE that you've fully captured in the question stem does NOT count — set has_exhibit:false. Pure text questions: false. When in doubt: false. Drag-drop and standard hotspot rows are NOT exhibits unless they include a screenshot/diagram outside the answer area.

Respond ONLY with JSON. Each question object MUST include "has_exhibit" (true or false):
{"questions": [...]}
"""


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    try:
        with CONFIG_PATH.open() as f:
            return json.load(f)
    except json.JSONDecodeError:
        return {}


def render_page_png(page: "fitz.Page", dpi: int) -> bytes:
    pix = page.get_pixmap(dpi=dpi)
    return pix.tobytes("png")


def _pixmap_to_jpeg(pix: "fitz.Pixmap", quality: int) -> bytes:
    if pix.alpha or (pix.colorspace and pix.colorspace.n not in (1, 3)):
        pix = fitz.Pixmap(fitz.csRGB, pix)
    try:
        return pix.tobytes("jpeg", jpg_quality=quality)
    except TypeError:
        return pix.tobytes("jpeg")


def extract_page_image_bytes(page: "fitz.Page", quality: int, min_dim: int = 200) -> list[bytes]:
    """Return JPEG bytes for each raster image embedded on the page.

    Filters out tiny images (icons, watermarks) by requiring width OR height >= min_dim px.
    """
    results: list[bytes] = []
    doc = page.parent
    for info in page.get_images(full=True):
        xref = info[0]
        width = info[2] if len(info) > 2 else 0
        height = info[3] if len(info) > 3 else 0
        if width < min_dim and height < min_dim:
            continue
        try:
            pix = fitz.Pixmap(doc, xref)
            results.append(_pixmap_to_jpeg(pix, quality))
        except Exception:
            continue
    return results


def collect_lookahead_pages(doc, start_idx: int, total: int, max_extra: int = MAX_LOOKAHEAD_EXTRA) -> list[int]:
    """Return 0-indexed pages [start_idx, ...] up to max_extra additional pages,
    stopping (exclusive) at the page where a different QUESTION number header appears."""
    start_text = doc[start_idx].get_text() or ""
    m = QUESTION_HEADER_RE.search(start_text)
    current_num = int(m.group(1)) if m else None
    pages = [start_idx]
    for off in range(1, max_extra + 1):
        nxt = start_idx + off
        if nxt >= total:
            break
        nxt_text = doc[nxt].get_text() or ""
        m2 = QUESTION_HEADER_RE.search(nxt_text)
        if m2 and current_num is not None and int(m2.group(1)) != current_num:
            break
        pages.append(nxt)
    return pages


VALID_LETTERS = ("A", "B", "C", "D", "E", "F")


def _coerce_number(raw) -> int | None:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float) and raw.is_integer():
        return int(raw)
    if isinstance(raw, str):
        s = raw.strip().lstrip("Qq").rstrip(".")
        if s.isdigit():
            return int(s)
    return None


def normalize_question(q: dict) -> dict | None:
    if not isinstance(q, dict):
        return None
    stem = str(q.get("question", "")).strip()
    if not stem:
        return None
    qtype = str(q.get("type", "mcq")).strip().lower() or "mcq"
    number = _coerce_number(q.get("number"))
    has_exhibit = bool(q.get("has_exhibit"))

    if qtype == "order":
        opts = q.get("options")
        ans = q.get("answer")
        if not isinstance(opts, list):
            return None
        norm_opts = [str(o).strip() for o in opts if str(o).strip()]
        if len(norm_opts) < 2:
            return None
        norm_ans: list[str] = []
        if isinstance(ans, list):
            for item in ans:
                s = str(item).strip()
                if s and s in norm_opts:
                    norm_ans.append(s)
        return {
            "number": number,
            "type": "order",
            "question": stem,
            "options": norm_opts,
            "answer": norm_ans,
            "has_exhibit": has_exhibit,
        }

    if qtype == "hotspot":
        subs = q.get("subquestions")
        if not isinstance(subs, list):
            return None
        norm_subs: list[dict] = []
        for s in subs:
            if not isinstance(s, dict):
                continue
            label = str(s.get("label", "")).strip()
            opts = s.get("options")
            ans = str(s.get("answer", "")).strip()
            if not label or not isinstance(opts, list):
                continue
            sub_opts = [str(o).strip() for o in opts if str(o).strip()]
            if len(sub_opts) < 2:
                continue
            if ans and ans not in sub_opts:
                ans = ""
            norm_subs.append({"label": label, "options": sub_opts, "answer": ans})
        if not norm_subs:
            return None
        return {
            "number": number,
            "type": "hotspot",
            "question": stem,
            "subquestions": norm_subs,
            "has_exhibit": has_exhibit,
        }

    # default to mcq
    opts = q.get("options")
    answer = str(q.get("answer", "")).strip().upper()
    if not isinstance(opts, dict):
        return None
    norm_opts = {}
    for key in VALID_LETTERS:
        if key in opts:
            v = str(opts.get(key, "")).strip()
            if v:
                norm_opts[key] = v
    if len(norm_opts) < 2:
        return None
    if answer and answer not in norm_opts:
        answer = ""
    return {
        "number": number,
        "type": "mcq",
        "question": stem,
        "options": norm_opts,
        "answer": answer,
        "has_exhibit": has_exhibit,
    }


DRAGDROP_MARKERS = ("DRAG DROP", "DRAG AND DROP", "SELECT AND PLACE")
HOTSPOT_MARKERS = ("HOTSPOT", "HOT AREA", "ANSWER AREA")
LOOKAHEAD_MARKERS = DRAGDROP_MARKERS + HOTSPOT_MARKERS


def needs_lookahead_page(text: str) -> bool:
    upper = (text or "").upper()
    return any(m in upper for m in LOOKAHEAD_MARKERS)


def _has_answer(q: dict) -> bool:
    if q.get("type") == "hotspot":
        return any(s.get("answer") for s in (q.get("subquestions") or []))
    a = q.get("answer")
    if isinstance(a, list):
        return len(a) > 0
    return bool(a)


def _answer_score(q: dict) -> int:
    if q.get("type") == "hotspot":
        return sum(1 for s in (q.get("subquestions") or []) if s.get("answer"))
    a = q.get("answer")
    if isinstance(a, list):
        return len(a)
    return 1 if a else 0


def _stem_key(q: dict) -> str:
    # Use the FULL normalized stem; truncating loses uniqueness when many questions share long
    # boilerplate (e.g. "Note: This question is part of a series ..."). Full-text dedup still
    # catches the model duplicating the same question under different numbers.
    return " ".join(str(q.get("question", "")).lower().split())


def dedupe_questions(qs: list[dict]) -> list[dict]:
    """Remove duplicates while preserving page order.

    Two passes:
      1. By question number — keep the entry with a non-empty answer when there's a tie.
      2. By normalized stem text — catch cases where the model assigned different numbers to the same question.
    """
    by_number: dict[int, int] = {}  # number -> index in result
    result: list[dict] = []
    for q in qs:
        num = q.get("number")
        if not isinstance(num, int):
            result.append(q)
            continue
        if num not in by_number:
            by_number[num] = len(result)
            result.append(q)
            continue
        existing_idx = by_number[num]
        existing = result[existing_idx]
        if _answer_score(q) > _answer_score(existing):
            result[existing_idx] = q

    # second pass: stem-text dedup
    by_stem: dict[str, int] = {}
    deduped: list[dict] = []
    for q in result:
        key = _stem_key(q)
        if not key:
            deduped.append(q)
            continue
        if key not in by_stem:
            by_stem[key] = len(deduped)
            deduped.append(q)
            continue
        existing_idx = by_stem[key]
        existing = deduped[existing_idx]
        if _answer_score(q) > _answer_score(existing):
            deduped[existing_idx] = q
    return deduped


async def extract_questions_from_image(
    client: AsyncOpenAI,
    model: str,
    pngs: list[bytes],
    sem: asyncio.Semaphore,
) -> tuple[list[dict], dict]:
    content: list[dict] = [{"type": "text", "text": EXTRACTION_PROMPT}]
    for png in pngs:
        b64 = base64.b64encode(png).decode()
        content.append(
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/png;base64,{b64}",
                    "detail": "high",
                },
            }
        )
    async with sem:
        resp = await client.chat.completions.create(
            model=model,
            response_format={"type": "json_object"},
            messages=[{"role": "user", "content": content}],
        )
    usage = {
        "prompt_tokens": getattr(resp.usage, "prompt_tokens", 0) or 0,
        "completion_tokens": getattr(resp.usage, "completion_tokens", 0) or 0,
        "total_tokens": getattr(resp.usage, "total_tokens", 0) or 0,
    }
    content = resp.choices[0].message.content or "{}"
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return [], usage
    raw = data.get("questions", [])
    questions = [nq for nq in (normalize_question(q) for q in raw) if nq]
    return questions, usage


@app.post("/api/pdf-info")
async def pdf_info(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "File must be a PDF")
    try:
        doc = fitz.open(stream=await file.read(), filetype="pdf")
    except Exception as e:
        raise HTTPException(400, f"Could not open PDF: {e}")
    pages = doc.page_count
    doc.close()
    return {"page_count": pages}


def parse_pages_spec(spec: str, total: int) -> list[int]:
    """Parse '1,3,5-8,12' into a sorted unique list of 1-based page numbers within [1, total].

    Empty/whitespace or 'all' returns every page. Pieces outside the range are silently dropped.
    Raises ValueError on malformed input.
    """
    s = (spec or "").strip().lower()
    if not s or s == "all":
        return list(range(1, total + 1))
    pages: set[int] = set()
    for raw in s.split(","):
        part = raw.strip()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            start = int(a.strip())
            end = int(b.strip())
            if start > end:
                start, end = end, start
            for p in range(start, end + 1):
                if 1 <= p <= total:
                    pages.add(p)
        else:
            p = int(part)
            if 1 <= p <= total:
                pages.add(p)
    return sorted(pages)


@app.post("/api/convert")
async def convert(
    file: UploadFile = File(...),
    pages: str = Form(""),
):
    config = load_config()
    api_key = str(config.get("api_key", "")).strip()
    model = str(config.get("model", "gpt-4o")).strip() or "gpt-4o"

    if not api_key or api_key.startswith("sk-..."):
        raise HTTPException(
            400,
            "No API key in config.json. Copy config.example.json to config.json and fill in your key.",
        )

    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "File must be a PDF")

    pdf_bytes = await file.read()
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(400, f"Could not open PDF: {e}")

    total = doc.page_count
    try:
        page_nums = parse_pages_spec(pages, total)
    except ValueError:
        doc.close()
        raise HTTPException(400, f"Could not parse pages spec: {pages!r}. Use e.g. '1,3,5-8,12' or 'all'.")
    if not page_nums:
        doc.close()
        raise HTTPException(400, f"No pages selected. PDF has {total} pages.")

    if len(page_nums) > MAX_PAGES:
        doc.close()
        raise HTTPException(
            400,
            f"Selected {len(page_nums)} pages, exceeds limit of {MAX_PAGES}. Narrow the selection or raise MAX_PAGES.",
        )

    selected = [p - 1 for p in page_nums]  # 0-indexed
    rendered_png: dict[int, bytes] = {}

    def get_png(idx: int) -> bytes:
        if idx not in rendered_png:
            rendered_png[idx] = render_page_png(doc[idx], RENDER_DPI)
        return rendered_png[idx]

    # Pre-filter: only process pages that contain a QUESTION header. Pages without one
    # are continuation/answer pages, picked up via lookahead from the question's start page.
    # This stops the model from fabricating a "Q81" out of a page that has no QUESTION header.
    skipped_no_header: list[int] = []
    calls: list[dict] = []
    covered: set[int] = set()
    for idx in selected:
        if idx in covered:
            continue
        text = doc[idx].get_text() or ""
        if not QUESTION_HEADER_RE.search(text):
            skipped_no_header.append(idx + 1)
            continue
        if needs_lookahead_page(text):
            la = collect_lookahead_pages(doc, idx, total)
        else:
            la = [idx]
        # Pages we send to the model.
        pngs = [get_png(p) for p in la]
        # Pull every embedded raster image across the question's pages. Answer-key content
        # in this PDF format is rendered as text/vector, not raster, so it won't show up here.
        embed_urls: list[str] = []
        for p in la:
            for jpeg in extract_page_image_bytes(doc[p], EMBED_JPEG_QUALITY):
                embed_urls.append("data:image/jpeg;base64," + base64.b64encode(jpeg).decode())
        calls.append({"idx": idx, "lookahead": la, "pngs": pngs, "embed_urls": embed_urls})
        for p in la:
            covered.add(p)
    doc.close()

    client = AsyncOpenAI(api_key=api_key)
    sem = asyncio.Semaphore(MAX_CONCURRENCY)
    try:
        per_call = await asyncio.gather(
            *[extract_questions_from_image(client, model, call["pngs"], sem) for call in calls],
            return_exceptions=True,
        )
    except OpenAIError as ex:
        raise HTTPException(502, f"OpenAI error: {ex}")

    raw_questions: list[dict] = []
    errors: list[str] = []
    usage_total = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    for offset, result in enumerate(per_call):
        call = calls[offset]
        page_num = call["idx"] + 1
        if isinstance(result, Exception):
            errors.append(f"page {page_num}: {result}")
            continue
        page_qs, page_usage = result
        for k in usage_total:
            usage_total[k] += page_usage.get(k, 0)
        for q in page_qs:
            q_with_page = dict(q)
            q_with_page["page"] = page_num
            if q.get("has_exhibit") and call["embed_urls"]:
                q_with_page["images"] = call["embed_urls"]
            raw_questions.append(q_with_page)

    questions = dedupe_questions(raw_questions)

    return JSONResponse(
        {
            "questions": questions,
            "question_count": len(questions),
            "pages_processed": len(calls),
            "pages_skipped_no_header": skipped_no_header,
            "pages": page_nums,
            "total_pages": total,
            "model": model,
            "errors": errors,
            "usage": usage_total,
        }
    )


@app.get("/api/health")
async def health():
    config = load_config()
    return {
        "ok": True,
        "key_configured": bool(str(config.get("api_key", "")).strip()) and not str(config.get("api_key", "")).startswith("sk-..."),
        "model": str(config.get("model", "gpt-4o")) or "gpt-4o",
    }


app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="static")
