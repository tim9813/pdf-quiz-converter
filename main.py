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

DEFAULT_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o")
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


@app.post("/api/convert")
async def convert(
    file: UploadFile = File(...),
    api_key: str = Form(""),
    model: str = Form(DEFAULT_MODEL),
):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "File must be a PDF")

    key = api_key.strip() or os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise HTTPException(400, "No OpenAI API key provided. Paste one in the form or set OPENAI_API_KEY.")

    pdf_bytes = await file.read()
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(400, f"Could not open PDF: {e}")

    if doc.page_count > MAX_PAGES:
        doc.close()
        raise HTTPException(
            400,
            f"PDF has {doc.page_count} pages; limit is {MAX_PAGES}. Split it or raise MAX_PAGES.",
        )

    pngs = [render_page_png(doc[i], RENDER_DPI) for i in range(doc.page_count)]
    page_count = doc.page_count
    doc.close()

    client = AsyncOpenAI(api_key=key)
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
    for i, result in enumerate(per_page):
        if isinstance(result, Exception):
            errors.append(f"page {i + 1}: {result}")
        else:
            cards.extend(result)

    return JSONResponse(
        {
            "cards": cards,
            "card_count": len(cards),
            "page_count": page_count,
            "errors": errors,
        }
    )


@app.get("/api/health")
async def health():
    return {"ok": True, "model": DEFAULT_MODEL}


static_dir = Path(__file__).parent / "static"
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
