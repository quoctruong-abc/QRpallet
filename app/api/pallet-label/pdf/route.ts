import { readFile } from "node:fs/promises";
import path from "node:path";

import fontkit from "@pdf-lib/fontkit";
import { NextResponse } from "next/server";
import { PDFDocument, rgb } from "pdf-lib";
import QRCode from "qrcode";

import { authorizePermission } from "@/lib/auth";
import { createPdfPrintPage } from "@/lib/pdf-print-page";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PalletRecord = {
  pallet_id: string;
  itemcode: string | null;
  product_name: string | null;
  customer: string | null;
  wo: string | null;
  quanorder: number | string | null;
  machine: string | null;
  quantity: number | string | null;
  status: string | null;
  working_day: string | null;
};

type TextLayout = {
  x: number;
  y: number;
  size: number;
  bold: boolean;
  maxWidth: number;
};

const MM_TO_POINT = 72 / 25.4;

function mm(value: number): number {
  return value * MM_TO_POINT;
}

function safe(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function formatNumber(value: unknown): string {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return safe(value);
  return numericValue.toLocaleString("vi-VN");
}

function formatWorkingDay(value: string | null): string {
  if (!value) return "-";
  const datePart = value.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!match) return safe(value);
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

function withPrefix(prefix: string, value: unknown): string {
  return `${prefix}${safe(value)}`;
}

// Nội dung đứng trước dữ liệu. Để chuỗi rỗng "" nếu không muốn hiện tiêu đề.
const LABEL_PREFIX = {
  workingDay: "Ngày sản xuất: ",
  itemcode: "Itemcode: ",
  wo: "Số WO: ",
  productName: "Tên sản phẩm: ",
  customer: "",
  machine: "Máy: ",
  quantity: "Số lượng: ",
  quanorder: "Số lượng đơn hàng: ",
} as const;

// Tất cả x/y dùng đơn vị mm, tính từ góc trên bên trái giấy A4 nằm ngang.
// A4 landscape có kích thước 297 x 210 mm.
const LABEL_LAYOUT = {
  workingDay: { x: 18, y: 160, size: 20, bold: false, maxWidth: 185 },
  itemcode: { x: 18, y: 100, size: 25, bold: true, maxWidth: 150 },
  wo: { x: 18, y: 115, size: 20, bold: false, maxWidth: 150 },
  productName: { x: 18, y: 57, size: 25, bold: true, maxWidth: 270 },
  customer: { x: 18, y: 40, size: 92, bold: true, maxWidth: 185 },
  machine: { x: 18, y: 130, size: 20, bold: false, maxWidth: 100 },
  quantity: { x: 18, y: 180, size: 40, bold: true, maxWidth: 140 },
  quanorder: { x: 18, y: 145, size: 20, bold: false, maxWidth: 100 },
  qr: { x: 210, y: 130, size: 72 },
  qrCaption: { x: 225, y: 130, size: 15, bold: true, maxWidth: 70 },
} satisfies Record<string, TextLayout | { x: number; y: number; size: number }>;

export async function GET(request: Request) {
  try {
    const authorization = await authorizePermission("pallet.create");
    if (!authorization.ok) {
      return NextResponse.json({ error: authorization.error }, { status: authorization.status });
    }

    const requestUrl = new URL(request.url);
    const palletId = requestUrl.searchParams.get("palletId")?.trim();
    if (!palletId) {
      return NextResponse.json({ error: "Thiếu palletId." }, { status: 400 });
    }

    if (requestUrl.searchParams.get("raw") !== "1") {
      const rawPdfUrl = `/api/pallet-label/pdf?palletId=${encodeURIComponent(palletId)}&raw=1`;
      const printJobId = requestUrl.searchParams.get("printJobId")?.trim().slice(0, 128) || null;
      return createPdfPrintPage(rawPdfUrl, `In tem pallet ${palletId}`, {
        closeAfterPrint: true,
        printJobId,
      });
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("pallet_data")
      .select("pallet_id,itemcode,product_name,customer,wo,quanorder,machine,quantity,status,working_day")
      .eq("pallet_id", palletId)
      .is("effect_to", null)
      .maybeSingle();

    if (error) {
      console.error("Read pallet failed", error);
      return NextResponse.json(
        { error: error.message || "Không thể đọc dữ liệu pallet." },
        { status: 500 },
      );
    }

    if (!data) {
      return NextResponse.json(
        { error: "Không tìm thấy pallet đang có hiệu lực." },
        { status: 404 },
      );
    }

    const pallet: PalletRecord = {
      pallet_id: data.pallet_id,
      itemcode: data.itemcode,
      product_name: data.product_name,
      customer: data.customer,
      wo: data.wo,
      quanorder: data.quanorder,
      machine: data.machine,
      quantity: data.quantity,
      status: data.status,
      working_day: data.working_day,
    };

    const regularFontPath = path.join(process.cwd(), "public", "fonts", "Arial-Regular.ttf");
    const boldFontPath = path.join(process.cwd(), "public", "fonts", "Arial-Bold.ttf");
    const [regularFontBytes, boldFontBytes] = await Promise.all([
      readFile(regularFontPath),
      readFile(boldFontPath),
    ]);

    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);

    const regularFont = await pdfDoc.embedFont(regularFontBytes, { subset: true });
    const boldFont = await pdfDoc.embedFont(boldFontBytes, { subset: true });

    // A4 landscape: rộng 297 mm, cao 210 mm.
    const page = pdfDoc.addPage([mm(297), mm(210)]);
    const pageHeight = page.getHeight();

    const drawText = (text: unknown, config: TextLayout) => {
      page.drawText(safe(text), {
        x: mm(config.x),
        y: pageHeight - mm(config.y),
        size: config.size,
        font: config.bold ? boldFont : regularFont,
        color: rgb(0, 0, 0),
        maxWidth: mm(config.maxWidth),
      });
    };

    const qrBuffer = await QRCode.toBuffer(pallet.pallet_id, {
      type: "png",
      width: 600,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    const qrImage = await pdfDoc.embedPng(qrBuffer);

    drawText(
      withPrefix(LABEL_PREFIX.workingDay, formatWorkingDay(pallet.working_day)),
      LABEL_LAYOUT.workingDay,
    );
    drawText(withPrefix(LABEL_PREFIX.itemcode, pallet.itemcode), LABEL_LAYOUT.itemcode);
    drawText(withPrefix(LABEL_PREFIX.wo, pallet.wo), LABEL_LAYOUT.wo);
    drawText(withPrefix(LABEL_PREFIX.productName, pallet.product_name), LABEL_LAYOUT.productName);
    drawText(withPrefix(LABEL_PREFIX.customer, pallet.customer), LABEL_LAYOUT.customer);
    drawText(withPrefix(LABEL_PREFIX.machine, pallet.machine), LABEL_LAYOUT.machine);
    drawText(withPrefix(LABEL_PREFIX.quantity, formatNumber(pallet.quantity)), LABEL_LAYOUT.quantity);
    drawText(withPrefix(LABEL_PREFIX.quanorder, formatNumber(pallet.quanorder)), LABEL_LAYOUT.quanorder);

    page.drawImage(qrImage, {
      x: mm(LABEL_LAYOUT.qr.x),
      y: pageHeight - mm(LABEL_LAYOUT.qr.y + LABEL_LAYOUT.qr.size),
      width: mm(LABEL_LAYOUT.qr.size),
      height: mm(LABEL_LAYOUT.qr.size),
    });

    drawText(pallet.pallet_id, LABEL_LAYOUT.qrCaption);

    const pdfBytes = await pdfDoc.save();
    const filename = sanitizeFilename(`${pallet.pallet_id}.pdf`);

    return new Response(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    console.error("Generate pallet PDF failed", error);

    if (error instanceof Error && error.message.includes("ENOENT")) {
      return NextResponse.json(
        { error: "Không tìm thấy font. Kiểm tra public/fonts/Arial-Regular.ttf và Arial-Bold.ttf." },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Không thể tạo PDF." },
      { status: 500 },
    );
  }
}
