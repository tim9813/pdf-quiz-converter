import asyncio
import base64
import json
import os
from pathlib import Path

import fitz  # PyMuPDF
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI, OpenAIError

load_dotenv()

app = FastAPI(title="PDF → Quizlet Converter")

ROOT = Path(__file__).parent
CONFIG_PATH = ROOT / "config.json"

RENDER_DPI = int(os.environ.get("RENDER_DPI", "150"))
MAX_CONCURRENCY = int(os.environ.get("MAX_CONCURRENCY", "5"))
MAX_PAGES = int(os.environ.get("MAX_PAGES", "100"))

EXTRACTION_PROMPT = """You are creating Quizlet-style flashcards from a single page of a PDF.

Extract the most important learnable concepts from this page and format them as term/definition pairs:
- For Q&A material: question → answer
- For glossaries / vocabulary lists: term → definition
- For prose or textbook content: key concept → its explanation
- For lists or tables: identify the relationship and create pairs

Aim for cards a student would actually want to memorize. Keep terms short (a word or short phrase). Definitions can be 1–3 sentences. Skip non-content pages (covers, copyright, table of contents, page numbers only) by returning an empty list.

Respond ONLY with JSON in exactly this shape:
{"cards": [{"term": "...", "definition": "..."}]}
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


async def extract_cards_from_image(
    client: AsyncOpenAI,
    model: str,
    png_bytes: bytes,
    sem: asyncio.Semaphore,
) -> list[dict]:
    b64 = base64.b64encode(png_bytes).decode()
    async with sem:
        resp = await client.chat.completions.create(
            model=model,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": EXTRACTION_PROMPT},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{b64}",
                                "detail": "high",
                            },
                        },
                    ],
                }
            ],
        )
    content = resp.choices[0].message.content or "{}"
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return []
    cards = data.get("cards", [])
    return [
        {"term": str(c.get("term", "")).strip(), "definition": str(c.get("definition", "")).strip()}
        for c in cards
        if isinstance(c, dict) and c.get("term") and c.get("definition")
    ]


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


@app.post("/api/convert")
async def convert(
    file: UploadFile = File(...),
    start_page: int = Form(1),
    end_page: int = Form(0),  # 0 means "to last page"
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
    s = max(1, start_page)
    e = total if end_page <= 0 else min(end_page, total)
    if s > e:
        doc.close()
        raise HTTPException(400, f"start_page ({s}) is greater than end_page ({e})")

    selected = list(range(s - 1, e))  # 0-indexed
    if len(selected) > MAX_PAGES:
        doc.close()
        raise HTTPException(
            400,
            f"Selected {len(selected)} pages, exceeds limit of {MAX_PAGES}. Narrow the range or raise MAX_PAGES.",
        )

    pngs = [render_page_png(doc[i], RENDER_DPI) for i in selected]
    doc.close()

    client = AsyncOpenAI(api_key=api_key)
    sem = asyncio.Semaphore(MAX_CONCURRENCY)
    try:
        per_page = await asyncio.gather(
            *[extract_cards_from_image(client, model, png, sem) for png in pngs],
            return_exceptions=True,
        )
    except OpenAIError as e:
        raise HTTPException(502, f"OpenAI error: {e}")

    cards: list[dict] = []
    errors: list[str] = []
    for offset, result in enumerate(per_page):
        page_num = selected[offset] + 1
        if isinstance(result, Exception):
            errors.append(f"page {page_num}: {result}")
        else:
            cards.extend(result)

    return JSONResponse(
        {
            "cards": cards,
            "card_count": len(cards),
            "pages_processed": len(selected),
            "page_range": [s, e],
            "total_pages": total,
            "model": model,
            "errors": errors,
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
