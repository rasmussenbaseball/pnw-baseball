"""Render a TrackMan 'Pitcher Session Report' PDF (one pitcher per page) into
per-page header+table crops sized for accurate vision transcription.

WHY vision, not OCR: the new-platform export is pure raster (no text layer,
fonts not embedded) and tesseract systematically drops decimal points on the
movement columns (6.3 -> 63, 5.6 -> 56). Reading the cropped table image
directly is exact. Each crop is pre-resized to ~1300px wide with LANCZOS so it
survives the chat-client downscale and stays legible.

Workflow per PDF:
  1. python3 scripts/trackman/render_pages.py "<file>.pdf"      -> /tmp/tm_crops/p01..pNN.png
  2. read each crop, transcribe into scripts/trackman/data/<team>_<season>.json
     (schema: see data/wenatchee_2026.json — one 14-field row per pitch type)
  3. python3 scripts/trackman/ingest.py scripts/trackman/data/<file>.json --commit

If a page renders small/ambiguous, re-render that one page in left/right halves
at full DPI (see the --page flag) to confirm exact digits.
"""
import argparse
import os

from pdf2image import convert_from_path
from PIL import Image

OUT = "/tmp/tm_crops"
HEADER_FRAC = 0.045   # top band: "Last, First | Team | Year"
TABLE_TOP = 0.265     # "Stats by Pitch Type" table band
TABLE_BOT = 0.520
TARGET_W = 1300


def composite(img):
    w, h = img.size
    header = img.crop((0, 0, w, int(h * HEADER_FRAC)))
    table = img.crop((0, int(h * TABLE_TOP), w, int(h * TABLE_BOT)))
    combo = Image.new("RGB", (w, header.height + table.height + 8), "white")
    combo.paste(header, (0, 0))
    combo.paste(table, (0, header.height + 8))
    return combo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--page", type=int, help="render only this page, in L/R halves at full DPI")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    if a.page:
        img = convert_from_path(a.pdf, dpi=300, first_page=a.page, last_page=a.page)[0]
        combo = composite(img)
        combo.crop((0, 0, int(combo.width * 0.52), combo.height)).save(f"{OUT}/p{a.page:02d}_L.png")
        combo.crop((int(combo.width * 0.50), 0, combo.width, combo.height)).save(f"{OUT}/p{a.page:02d}_R.png")
        print(f"wrote {OUT}/p{a.page:02d}_L.png and _R.png")
        return

    for f in os.listdir(OUT):
        if f.endswith(".png"):
            os.remove(os.path.join(OUT, f))
    pages = convert_from_path(a.pdf, dpi=300)
    for i, img in enumerate(pages):
        combo = composite(img)
        th = int(combo.height * TARGET_W / combo.width)
        combo.resize((TARGET_W, th), Image.LANCZOS).save(f"{OUT}/p{i + 1:02d}.png")
    print(f"rendered {len(pages)} pages -> {OUT}/p01..p{len(pages):02d}.png")


if __name__ == "__main__":
    main()
