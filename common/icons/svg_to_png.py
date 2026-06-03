"""
SVG → PNG converter using headless Chromium (playwright).
Generates 192x192 and 512x512 PNGs for each SVG in this directory.
"""

import json
import pathlib
from playwright.sync_api import sync_playwright

ICONS_DIR = pathlib.Path(__file__).parent
SIZES = [192, 512]

SVG_FILES = [
    "icon-tomu-system",
    "icon-light",
    "icon-standard",
    "icon-full",
    "icon-shikaku",
]


def svg_to_png(page, svg_path: pathlib.Path, out_path: pathlib.Path, size: int):
    svg_content = svg_path.read_text(encoding="utf-8")
    # Inline SVG in a minimal HTML page; body margin=0 so screenshot is clean
    html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  html, body {{ width: {size}px; height: {size}px; overflow: hidden; background: transparent; }}
  svg {{ display: block; width: {size}px; height: {size}px; }}
</style>
</head>
<body>{svg_content}</body>
</html>"""

    page.set_viewport_size({"width": size, "height": size})
    page.set_content(html, wait_until="load")
    page.screenshot(
        path=str(out_path),
        clip={"x": 0, "y": 0, "width": size, "height": size},
        omit_background=False,
    )


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()

        for name in SVG_FILES:
            svg_path = ICONS_DIR / f"{name}.svg"
            if not svg_path.exists():
                print(f"SKIP (not found): {svg_path.name}")
                continue
            for size in SIZES:
                out_path = ICONS_DIR / f"{name}-{size}.png"
                svg_to_png(page, svg_path, out_path, size)
                print(f"  created: {out_path.name}  ({size}x{size})")

        browser.close()
    print("\nAll done.")


if __name__ == "__main__":
    main()
