"""Rebuild the shift-report background as an A4 landscape vector PDF.

Run with Python + reportlab from the repository root. All coordinates below
reference the original 2048 x 1444 scan, preserving the existing fill boxes.
No scan image is embedded; labels, branding and table rules are vector objects.
"""

import argparse
from pathlib import Path

from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
PAGE_W, PAGE_H = landscape(A4)
SX, SY = PAGE_W / 2048, PAGE_H / 1444

# Outline of the original white Srithai emblem, in original scan coordinates.
LOGO_PATHS = [[[90.0, 97.5], [91.0, 97.5], [92.0, 97.5], [93.0, 97.5], [94.0, 97.5], [95.0, 97.5], [96.0, 97.5], [97.0, 97.5], [98.0, 97.5], [98.5, 98.0], [99.0, 98.5], [100.0, 98.5], [101.0, 98.5], [101.5, 99.0], [102.0, 99.5], [102.5, 100.0], [103.0, 100.5], [104.0, 100.5], [104.5, 101.0], [105.0, 101.5], [105.5, 102.0], [106.0, 102.5], [106.5, 103.0], [107.0, 103.5], [107.5, 104.0], [108.0, 104.5], [108.5, 105.0], [108.5, 106.0], [108.5, 107.0], [108.5, 108.0], [108.5, 109.0], [108.5, 110.0], [108.5, 111.0], [108.5, 112.0], [108.5, 113.0], [108.5, 114.0], [108.5, 115.0], [108.5, 116.0], [108.5, 117.0], [108.5, 118.0], [108.5, 119.0], [108.5, 120.0], [108.5, 121.0], [108.5, 122.0], [108.0, 122.5], [107.5, 123.0], [107.0, 123.5], [106.5, 124.0], [106.0, 124.5], [105.5, 125.0], [105.0, 125.5], [104.5, 126.0], [104.0, 126.5], [103.0, 126.5], [102.5, 127.0], [102.0, 127.5], [101.5, 128.0], [101.0, 128.5], [100.0, 128.5], [99.5, 129.0], [99.0, 129.5], [98.0, 129.5], [97.0, 129.5], [96.0, 129.5], [95.0, 129.5], [94.0, 129.5], [93.0, 129.5], [92.0, 129.5], [91.0, 129.5], [90.0, 129.5], [89.0, 129.5], [88.5, 129.0], [88.0, 128.5], [87.0, 128.5], [86.5, 128.0], [86.0, 127.5], [85.0, 127.5], [84.5, 127.0], [84.0, 126.5], [83.5, 126.0], [83.0, 125.5], [82.0, 125.5], [81.5, 125.0], [81.5, 124.0], [81.0, 123.5], [80.5, 123.0], [80.0, 122.5], [79.5, 122.0], [79.5, 121.0], [79.0, 120.5], [78.5, 120.0], [78.5, 119.0], [78.0, 118.5], [77.5, 118.0], [77.5, 117.0], [77.5, 116.0], [77.5, 115.0], [77.5, 114.0], [77.0, 113.5], [76.5, 113.0], [76.5, 112.0], [77.0, 111.5], [77.5, 111.0], [77.5, 110.0], [77.5, 109.0], [77.5, 108.0], [78.0, 107.5], [78.5, 107.0], [78.5, 106.0], [79.0, 105.5], [79.5, 105.0], [80.0, 104.5], [80.5, 104.0], [81.0, 103.5], [81.5, 103.0], [82.0, 102.5], [82.5, 102.0], [83.0, 101.5], [83.5, 101.0], [84.0, 100.5], [85.0, 100.5], [85.5, 100.0], [86.0, 99.5], [86.5, 99.0], [87.0, 98.5], [88.0, 98.5], [89.0, 98.5], [89.5, 98.0], [90.0, 97.5]], [[93.0, 99.5], [92.5, 100.0], [92.0, 100.5], [91.5, 101.0], [91.5, 102.0], [91.0, 102.5], [90.5, 103.0], [90.5, 104.0], [90.0, 104.5], [89.5, 105.0], [89.0, 105.5], [88.5, 106.0], [88.0, 106.5], [87.5, 107.0], [87.5, 108.0], [87.5, 109.0], [87.5, 110.0], [87.5, 111.0], [87.0, 111.5], [86.5, 112.0], [86.5, 113.0], [86.5, 114.0], [86.5, 115.0], [86.0, 115.5], [85.5, 116.0], [85.5, 117.0], [85.0, 117.5], [84.5, 118.0], [84.5, 119.0], [85.0, 119.5], [85.5, 120.0], [85.0, 120.5], [84.0, 120.5], [83.0, 120.5], [82.5, 121.0], [82.5, 122.0], [83.0, 122.5], [83.5, 123.0], [84.0, 123.5], [85.0, 123.5], [86.0, 123.5], [87.0, 123.5], [88.0, 123.5], [88.5, 124.0], [88.5, 125.0], [89.0, 125.5], [89.5, 126.0], [90.0, 126.5], [90.5, 127.0], [91.0, 127.5], [92.0, 127.5], [93.0, 127.5], [94.0, 127.5], [94.5, 127.0], [94.5, 126.0], [94.0, 125.5], [93.5, 125.0], [94.0, 124.5], [95.0, 124.5], [95.5, 125.0], [96.0, 125.5], [96.5, 126.0], [97.0, 126.5], [98.0, 126.5], [99.0, 126.5], [99.5, 126.0], [100.0, 125.5], [100.5, 125.0], [100.0, 124.5], [99.5, 124.0], [99.0, 123.5], [98.5, 123.0], [98.5, 122.0], [99.0, 121.5], [100.0, 121.5], [101.0, 121.5], [102.0, 121.5], [103.0, 121.5], [103.5, 121.0], [103.5, 120.0], [103.0, 119.5], [102.5, 119.0], [102.0, 118.5], [101.5, 118.0], [101.5, 117.0], [102.0, 116.5], [102.5, 116.0], [102.5, 115.0], [102.5, 114.0], [102.5, 113.0], [102.5, 112.0], [102.5, 111.0], [102.5, 110.0], [102.0, 109.5], [101.5, 109.0], [101.5, 108.0], [101.5, 107.0], [101.0, 106.5], [100.5, 106.0], [100.0, 105.5], [99.0, 105.5], [98.5, 105.0], [98.5, 104.0], [98.5, 103.0], [98.5, 102.0], [99.0, 101.5], [99.5, 101.0], [99.5, 100.0], [99.0, 99.5], [98.0, 99.5], [97.0, 99.5], [96.0, 99.5], [95.0, 99.5], [94.0, 99.5], [93.0, 99.5]], [[95.0, 107.5], [96.0, 107.5], [97.0, 107.5], [97.5, 108.0], [98.0, 108.5], [98.5, 109.0], [98.5, 110.0], [98.5, 111.0], [98.5, 112.0], [98.5, 113.0], [98.5, 114.0], [98.5, 115.0], [98.5, 116.0], [98.5, 117.0], [98.0, 117.5], [97.5, 118.0], [97.5, 119.0], [97.5, 120.0], [97.0, 120.5], [96.5, 121.0], [96.0, 121.5], [95.0, 121.5], [94.0, 121.5], [93.5, 122.0], [93.0, 122.5], [92.5, 122.0], [92.0, 121.5], [91.5, 121.0], [92.0, 120.5], [92.5, 120.0], [92.5, 119.0], [92.5, 118.0], [92.5, 117.0], [92.5, 116.0], [92.5, 115.0], [92.5, 114.0], [92.5, 113.0], [92.5, 112.0], [93.0, 111.5], [93.5, 111.0], [93.5, 110.0], [94.0, 109.5], [94.5, 109.0], [94.5, 108.0], [95.0, 107.5]]]


def build(output: Path):
    pdfmetrics.registerFont(TTFont("Arial", str(ROOT / "public/fonts/Arial-Regular.ttf")))
    pdfmetrics.registerFont(TTFont("ArialBold", str(ROOT / "public/fonts/Arial-Bold.ttf")))
    output.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(output), pagesize=(PAGE_W, PAGE_H), pageCompression=1, invariant=1)
    c.setTitle("Daily report on activity of injection machine")
    c.setAuthor("SVN Warehouse")

    def line(x0, y0, x1, y1, width=0.45):
        c.setStrokeColor(black)
        c.setLineWidth(width)
        c.line(x0 * SX, PAGE_H - y0 * SY, x1 * SX, PAGE_H - y1 * SY)

    def box_text(value, x, y, width, height, size=6.6, font="Arial", align="left", color=black):
        lines = value.split("\n")
        while size > 4 and (
            max(pdfmetrics.stringWidth(t, font, size) for t in lines) > width * SX
            or len(lines) * size * 1.18 > height * SY
        ):
            size -= 0.1
        assert max(pdfmetrics.stringWidth(t, font, size) for t in lines) <= width * SX + 0.01, value
        ascent, descent = pdfmetrics.getAscentDescent(font, size)
        leading = size * 1.18
        text_height = ascent - descent + (len(lines) - 1) * leading
        baseline = PAGE_H - y * SY - (height * SY - text_height) / 2 - ascent
        c.setFont(font, size)
        c.setFillColor(color)
        for i, text in enumerate(lines):
            tw = pdfmetrics.stringWidth(text, font, size)
            tx = x * SX + (width * SX - tw) / 2 if align == "center" else x * SX
            if align == "right":
                tx = (x + width) * SX - tw
            c.drawString(tx, baseline - i * leading, text)

    # Main frame and header fields. The scan's small skew is replaced by straight rules.
    for x0, y0, x1, y1 in [(51, 82, 1992, 82), (51, 82, 51, 1389), (1992, 82, 1992, 1389), (51, 1389, 1992, 1389)]:
        line(x0, y0, x1, y1, 0.8)
    for y in [147, 249, 303, 349]:
        line(51, y, 1992, y, 0.65)
    line(566, 199, 1992, 199)
    line(566, 82, 566, 303)
    line(934, 147, 934, 303)
    line(1404, 82, 1404, 303)

    # Reconstructed native branding: solid colour, clean type, traced original emblem.
    c.setFillColor(HexColor("#b52f43"))
    c.rect(64 * SX, PAGE_H - 138 * SY, 160 * SX, 47 * SY, fill=1, stroke=0)
    c.setFillColor(white)
    p = c.beginPath()
    for points in LOGO_PATHS:
        p.moveTo(points[0][0] * SX, PAGE_H - points[0][1] * SY)
        for x, y in points[1:]:
            p.lineTo(x * SX, PAGE_H - y * SY)
        p.close()
    c.drawPath(p, fill=1, stroke=0, fillMode=0)
    box_text("Srithai", 113, 95, 106, 36, size=10.2, font="ArialBold", color=white)
    box_text("SRITHAI (VIETNAM) COMPANY LIMITED", 243, 87, 317, 55, size=6.1, font="ArialBold", align="center")
    box_text("DAILY REPORT ON ACTIVITY OF INJECTION MACHINE", 575, 86, 820, 26, size=9, font="ArialBold", align="center")
    box_text("BÁO CÁO HOẠT ĐỘNG SẢN XUẤT HÀNG NGÀY CỦA MÁY ÉP", 575, 117, 820, 25, size=9.2, font="ArialBold", align="center")
    box_text("WI-PRO-01-FM-05 (REV: 01)", 1414, 91, 295, 25, size=6.6, font="ArialBold", align="center")
    box_text("Applied from 20/08/2025", 1414, 117, 295, 25, size=6.6, font="ArialBold", align="center")
    teal = HexColor("#008c8c")
    c.setStrokeColor(teal)
    c.setFillColor(white)
    c.setLineWidth(1)
    c.rect(1718 * SX, PAGE_H - 146 * SY, 274 * SX, 92 * SY, fill=1, stroke=1)
    box_text("CONTROL", 1730, 59, 249, 49, size=23, font="ArialBold", align="center", color=teal)
    box_text("QHSE", 1900, 109, 82, 32, size=10, font="ArialBold", align="center", color=teal)

    # Labels deliberately leave the existing machine/WO/customer/data boxes empty.
    box_text("Part name (Tên sản phẩm):", 55, 149, 240, 23, size=6.7)
    box_text("Machine no\n(Máy số):", 571, 151, 111, 42, size=6.6)
    box_text("Work Order No.\n(Công việc số) :", 939, 151, 136, 42, size=6.6)
    box_text("Date (Ngày):", 1409, 169, 107, 26, size=6.6)
    box_text("Material\n(Tên vật liệu):", 571, 202, 111, 41, size=6.6)
    box_text("Customer name\n(Khách hàng):", 939, 202, 136, 41, size=6.6)
    box_text("Ordered quantity (Số lượng đơn hàng):", 1409, 219, 324, 24, size=6.5)
    box_text("pcs/set", 1925, 220, 62, 23, size=6.5, align="right")
    box_text("Part no\n(Mã sản phẩm):", 55, 253, 140, 42, size=6.6)
    box_text("Product weight\n(Trọng lượng):", 571, 253, 119, 42, size=6.6)
    box_text("gram", 880, 276, 48, 22, size=6.5, align="right")
    box_text("Color (Màu):", 939, 276, 111, 22, size=6.6)
    box_text("Order remain (Đơn hàng còn sản xuất):", 1409, 272, 399, 26, size=6.5)
    box_text("pcs/set", 1925, 275, 62, 23, size=6.5, align="right")
    box_text("Production target (Định mức):", 55, 313, 242, 24, size=6.5)
    box_text("pcs-set /hour (Cái-set/giờ)", 433, 314, 310, 24, size=6.5)

    group_bounds = [424, 933, 1403, 1841, 1992]
    hour_groups = [
        [424, 471, 518, 566, 623, 679, 736, 797, 868],
        [933, 983, 1034, 1085, 1134, 1187, 1238, 1288, 1338],
        [1403, 1450, 1497, 1544, 1592, 1639, 1686, 1734, 1781],
    ]
    for x in group_bounds[:-1]:
        line(x, 349, x, 1213, 0.65)
    for boundaries in hour_groups:
        for x in boundaries[1:]:
            if x == boundaries[-1]:
                line(x, 349, x, 516)
            else:
                line(x, 378, x, 516, 0.35)
            line(x, 569, x, 1213, 0.35)
        line(boundaries[0], 378, boundaries[-1], 378)
    line(51, 349, 424, 413, 0.45)
    box_text("Time (Thời gian)", 180, 356, 237, 26, size=6.3, align="center")
    box_text("Description (Diễn giải)", 55, 385, 330, 23, size=6.3)
    hours = [
        ["6-7", "7-8", "8-9", "9-10", "10-11", "11-12", "12-13", "13-14"],
        ["14-15", "15-16", "16-17", "17-18", "18-19", "19-20", "20-21", "21-22"],
        ["22-23", "23-24", "24-1", "1-2", "2-3", "3-4", "4-5", "5-6"],
    ]
    for i, boundaries in enumerate(hour_groups):
        box_text(f"Shift {i + 1} (Ca {i + 1})", boundaries[0], 351, boundaries[-1] - boundaries[0], 24, size=6.4, align="center")
        for start, end, value in zip(boundaries, boundaries[1:], hours[i]):
            box_text(value, start + 2, 380, end - start - 4, 29, size=6.2, align="center")
        box_text("Total\nTổng", boundaries[-1] + 2, 352, group_bounds[i + 1] - boundaries[-1] - 4, 56, size=6.4, align="center")
    box_text("Total 3 shift\n(Tổng cộng 3 ca)", 1844, 353, 144, 54, size=6.2, align="center")

    row_edges = [413, 467, 516, 569, 607, 647, 670, 694, 718, 741, 764, 788, 812, 835, 859, 882, 905, 929, 953, 976, 999, 1023, 1047, 1070, 1094, 1118, 1141, 1164, 1188, 1213]
    for y in row_edges:
        line(51, y, 1992, y, 0.4 if 647 < y < 1213 else 0.65)
    for top, bottom in [(413, 516), (569, 1213)]:
        line(1945, top, 1945, bottom, 0.35)
    row_labels = [
        "Good product Quantity - Produced\nSố lượng sản phẩm tốt đã sản xuất",
        "Quantity Sticked QR Code\nSố lượng đã dán QR code",
        "QR Code Number Start From - To\nSố thứ tự QR Code dán trên thùng",
        "Sticker QR NG./Tem QR Bị Hư Hỏng",
        "NG Product in Production - No Label/No Lead\nSản phẩm hư trong SX- Không Label/Ko Chì",
    ]
    for text, top, bottom in zip(row_labels, row_edges, row_edges[1:]):
        box_text(text, 55, top + 2, 364, bottom - top - 4, size=6.2)
    defects = [
        "A1. FLASH (CÓ BAVIA)", "B1.SINK MARK (MÓP)", "C1.SHORT SHOT (THIẾU NHỰA)",
        "D1. BLACK POINT (CHẤM ĐEN)", "E1. WHITE MARK (CẤN TRẮNG)", "F1. DIRTY (DƠ)",
        "G1. SCRATCH (TRẦY)", "H1. COLOR DIF (KHÁC MÀU, Ko TAN)", "I1.OVERCUT (CẮT PHẠM)",
        "J1.BURN (CHÁY)", "K1.CRACK (NỨT, GÃY)", "L1.DEFORM (BIẾN DẠNG)",
        "M1.WEIGHT (TRỌNG LƯỢNG)", "N1.SILVER STREAK (TÉT NƯỚC)", "O1. STAIN (Ố VÀNG)",
        "P1. MISALIGNMENT (LỆCH LABEL)", "Q1. AIR VENTS (ĐƯỜNG HƠI)", "R1. SCRATCH LABEL (XƯỚC LABEL)",
        "S1. FOLD LABEL (GẤP LABEL)", "T1. LONG GATE (DÀI CỔNG)", "U1. AIR TRAP (BỌT NHỰA)",
        "V1. ADJUST CONDITION (CHỈNH MÁY)", "X1. OTHER (LỖI KHÁC)", "Y1. CHANGE - OVER (SÚC NÒNG)",
    ]
    for text, top, bottom in zip(defects, row_edges[5:], row_edges[6:]):
        box_text(text, 93, top + 1, 326, bottom - top - 2, size=5.9)
    for i, (top, bottom) in enumerate(zip(row_edges, row_edges[1:])):
        box_text("pcs", 1901, top + 1, 40, bottom - top - 2, size=5.9, align="right")
        if i != 2:
            box_text("Kg", 1950, top + 1, 38, bottom - top - 2, size=5.9, align="right")

    # Signature, notes, sample boxes and supervisor panel.
    for y in [1251, 1282]:
        line(51, y, 1992, y, 0.65)
    for x in [424, 933, 1403, 1777]:
        line(x, 1213, x, 1389, 0.65)
    for x in [676, 1182, 1635]:
        line(x, 1213, x, 1251)
    box_text("Considering product\n(Sản phẩm cần xem xét)", 55, 1215, 364, 34, size=6)
    for left, mid, right in [(424, 676, 933), (933, 1182, 1403), (1403, 1635, 1777)]:
        box_text("Worker:\n(Công Nhân)", left + 5, 1215, mid - left - 10, 34, size=6)
        box_text("Shift leader:\n(Trưởng ca)", mid + 5, 1215, right - mid - 10, 34, size=6)
    for left, right in [(51, 424), (424, 933), (933, 1403), (1403, 1777)]:
        box_text("Note (Ghi Chú)", left + 5, 1253, right - left - 10, 27, size=6)
    box_text("Checked by", 1782, 1253, 205, 27, size=6, align="center")
    instruction = (
        "YÊU CẦU: TRƯỞNG NHÓM KIỂM SOÁT TEM QR HÀNG NGÀY.\n"
        "GHI SỐ QR BẮT ĐẦU DÙNG VÀO BÁO CA- VÀ SỐ CỦA TEM\n"
        "CUỐI CA SX THEO SỐ LƯỢNG SP ĐÃ SẢN XUẤT. (Gỡ, Thu hồi\n"
        "và ghi lại mã số của tem bị hư đóng gói lại ghi rõ số lượng và\n"
        "dán nhãn NG.)"
    )
    box_text(instruction, 55, 1285, 364, 100, size=5.5)
    sample_bounds = [
        [424, 471, 518, 565, 621, 676, 733, 793, 864, 933],
        [933, 982, 1034, 1084, 1134, 1186, 1238, 1288, 1338, 1403],
        [1403, 1450, 1497, 1544, 1591, 1639, 1686, 1734, 1777],
    ]
    for boundaries in sample_bounds:
        left, right = boundaries[0], boundaries[-1]
        line(left, 1331, right, 1331)
        line(left, 1358, right, 1358)
        for x in boundaries[1:-1]:
            line(x, 1331, x, 1358, 0.35)
        box_text("QC lấy mẫu", left + 5, 1304, right - left - 10, 24, size=6)
        box_text("Keo Cục:", left + 5, 1361, right - left - 10, 24, size=6)
    box_text("Mr. Trần Văn Quyết\nInjection Supervisor", 1782, 1344, 205, 42, size=6.1, align="center")
    box_text("Page 1 of 2", 940, 1398, 200, 23, size=6.3, align="center")
    c.showPage()
    c.save()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "public/templates/shift-report.pdf")
    build(parser.parse_args().output)
