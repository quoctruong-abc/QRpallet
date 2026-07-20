import { readFile } from "node:fs/promises";
import path from "node:path";

import fontkit from "@pdf-lib/fontkit";
import { NextResponse } from "next/server";
import { PDFDocument, PageSizes, rgb } from "pdf-lib";
import QRCode from "qrcode";

import { authorizePermission } from "@/lib/auth";
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

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

// All positions use millimetres measured from the top-left corner of an A4 page.
// Change only this block when adjusting the label layout.
const LABEL_LAYOUT = {
  palletId: { x: 18, y: 34, size: 24, bold: true, maxWidth: 125 },
  itemcode: { x: 18, y: 58, size: 16, bold: true, maxWidth: 105 },
  wo: { x: 18, y: 80, size: 16, bold: true, maxWidth: 105 },
  productName: { x: 18, y: 103, size: 13, bold: false, maxWidth: 125 },
  customer: { x: 18, y: 124, size: 13, bold: false, maxWidth: 125 },
  machine: { x: 112, y: 58, size: 16, bold: true, maxWidth: 35 },
  quantity: { x: 112, y: 82, size: 24, bold: true, maxWidth: 35 },
  quanorder: { x: 112, y: 106, size: 13, bold: false, maxWidth: 35 },
  qr: { x: 154, y: 40, size: 38 },
  qrCaption: { x: 154, y: 83, size: 9, bold: true, maxWidth: 38 },
} as const;

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

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("pallet_data")
      .select("pallet_id,itemcode,product_name,customer,wo,quanorder,machine,quantity,status")
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
    const page = pdfDoc.addPage(PageSizes.A4);
    const pageHeight = page.getHeight();

    const drawText = (
      text: unknown,
      config: { x: number; y: number; size: number; bold: boolean; maxWidth: number },
    ) => {
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

    drawText(pallet.pallet_id, LABEL_LAYOUT.palletId);
    drawText(pallet.itemcode, LABEL_LAYOUT.itemcode);
    drawText(pallet.wo, LABEL_LAYOUT.wo);
    drawText(pallet.product_name, LABEL_LAYOUT.productName);
    drawText(pallet.customer, LABEL_LAYOUT.customer);
    drawText(pallet.machine, LABEL_LAYOUT.machine);
    drawText(formatNumber(pallet.quantity), LABEL_LAYOUT.quantity);
    drawText(formatNumber(pallet.quanorder), LABEL_LAYOUT.quanorder);

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
