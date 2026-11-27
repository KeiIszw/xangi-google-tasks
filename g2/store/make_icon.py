"""Even Hub のストアアイコン（24x24・1bit）を生成する。

仕様の根拠: https://hub.evenrealities.com/docs/build/design-guidelines（2026-07-10 版）
  - Developer Portal の 24x24 px エディタで描き、アップロード時に検証される
  - 1bit モノクロ（全点灯か全消灯のみ、灰色・アンチエイリアスなし）
  - 点灯画素はすべて 2x2 ブロックの一部（実質 12x12 の解像度）
  - 余白を取らず端まで使う
このため 12x12 のセル図を 2 倍に拡大して描く。セル図はポータルのエディタで手で
写す時の下絵にもなるよう、文字の図として ICON_CELLS に置く。

実行: python3 make_icon.py
出力:
  icon-24.png          提出用 24x24・1bit
  icon-preview.png     確認用の拡大図（1 セル = 40px、格子線つき）
"""
from PIL import Image, ImageDraw

# 12x12 のセル図。'#' が点灯。
# タスク 2 件のリスト: 上は完了（枠の中にチェック）、下は未完了（空の枠）。
# 右側の 2 本線はタスク名と詳細行を表す。
ICON_CELLS = [
    "#####..#####",
    "#..##.......",
    "##.##..####.",
    "#.#.#.......",
    "#####..#####",
    "............",
    "............",
    "#####..#####",
    "#...#.......",
    "#...#..####.",
    "#...#.......",
    "#####..#####",
]
CELL_PX = 2          # 1 セル = 2x2 px（Even Hub の 2x2 ブロック規則）
PREVIEW_CELL_PX = 40


def validate(cells: list[str]) -> None:
    """12x12 で、使う文字が '#' と '.' だけであることを確かめる。"""
    assert len(cells) == 12 and all(len(row) == 12 for row in cells), "12x12 ではありません"
    assert all(set(row) <= {"#", "."} for row in cells), "'#' と '.' 以外の文字があります"


def render(cells: list[str], cell_px: int, grid: bool = False) -> Image.Image:
    size = 12 * cell_px
    # 提出用は 1bit（mode "1"）。確認用は格子線を灰色で描くため L（8bit）。
    image = Image.new("L" if grid else "1", (size, size), 0)
    draw = ImageDraw.Draw(image)
    for y, row in enumerate(cells):
        for x, cell in enumerate(row):
            if cell == "#":
                draw.rectangle([x * cell_px, y * cell_px, (x + 1) * cell_px - 1, (y + 1) * cell_px - 1], fill=255)
    if grid:
        for i in range(13):
            draw.line([(i * cell_px, 0), (i * cell_px, size)], fill=60)
            draw.line([(0, i * cell_px), (size, i * cell_px)], fill=60)
    return image


def main() -> None:
    validate(ICON_CELLS)
    render(ICON_CELLS, CELL_PX).save("icon-24.png")
    render(ICON_CELLS, PREVIEW_CELL_PX, grid=True).save("icon-preview.png")


if __name__ == "__main__":
    main()
