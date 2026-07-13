import { readFile } from "node:fs/promises";
import path from "node:path";

import fontkit from "@pdf-lib/fontkit";
import { NextResponse } from "next/server";
import { PDFDocument, rgb } from "pdf-lib";
import QRCode from "qrcode";

import { getCurrentProfile } from "@/lib/auth";
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
  note: string | null;
};

const MM_TO_POINT = 72 / 25.4;

function mm(value: number): number {
  return value * MM_TO_POINT;
}

function safe(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  return String(value);
}

function formatNumber(value: unknown): string {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return safe(value);
  }

  return numericValue.toLocaleString("vi-VN");
}

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

export async function GET(request: Request) {
  try {
    const profile = await getCurrentProfile();

    if (!profile) {
      return NextResponse.json(
        { error: "Phiên đăng nhập đã hết hạn." },
        { status: 401 },
      );
    }

    if (
      !profile.is_active ||
      (profile.role !== "admin" &&
        profile.position !== "pallet")
    ) {
      return NextResponse.json(
        { error: "Bạn không có quyền in tem pallet." },
        { status: 403 },
      );
    }

    const requestUrl = new URL(request.url);

    const palletId = requestUrl.searchParams
      .get("palletId")
      ?.trim();

    if (!palletId) {
      return NextResponse.json(
        { error: "Thiếu palletId." },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    const { data, error } = await supabase
      .from("pallet_data")
      .select(
        [
          "pallet_id",
          "itemcode",
          "product_name",
          "customer",
          "wo",
          "quanorder",
          "machine",
          "quantity",
          "status",
          "note",
        ].join(","),
      )
      .eq("pallet_id", palletId)
      .is("effect_to", null)
      .maybeSingle();

    if (error) {
      console.error("Read pallet failed", error);

      return NextResponse.json(
        {
          error:
            error.message ||
            "Không thể đọc dữ liệu pallet.",
        },
        { status: 500 },
      );
    }

    if (!data) {
      return NextResponse.json(
        {
          error:
            "Không tìm thấy pallet đang có hiệu lực.",
        },
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
      note: data.note,
    };

    const templatePath = path.join(
      process.cwd(),
      "public",
      "templates",
      "pallet-label.pdf",
    );

    const regularFontPath = path.join(
      process.cwd(),
      "assets",
      "fonts",
      "Roboto-Regular.ttf",
    );

    const boldFontPath = path.join(
      process.cwd(),
      "assets",
      "fonts",
      "Roboto-Bold.ttf",
    );

    const [
      templateBytes,
      regularFontBytes,
      boldFontBytes,
    ] = await Promise.all([
      readFile(templatePath),
      readFile(regularFontPath),
      readFile(boldFontPath),
    ]);

    const pdfDoc = await PDFDocument.load(templateBytes);

    pdfDoc.registerFontkit(fontkit);

    const regularFont = await pdfDoc.embedFont(
      regularFontBytes,
      { subset: true },
    );

    const boldFont = await pdfDoc.embedFont(
      boldFontBytes,
      { subset: true },
    );

    const page = pdfDoc.getPages()[0];

    if (!page) {
      throw new Error(
        "File pallet-label.pdf không có trang nào.",
      );
    }

    const pageHeight = page.getHeight();

    const drawText = (
      text: unknown,
      xMm: number,
      yMm: number,
      size = 11,
      isBold = false,
      maxWidthMm = 78,
    ) => {
      page.drawText(safe(text), {
        x: mm(xMm),
        y: pageHeight - mm(yMm),
        size,
        font: isBold ? boldFont : regularFont,
        color: rgb(0, 0, 0),
        maxWidth: mm(maxWidthMm),
      });
    };

    const qrBuffer = await QRCode.toBuffer(
      pallet.pallet_id,
      {
        type: "png",
        width: 600,
        margin: 1,
        errorCorrectionLevel: "M",
      },
    );

    const qrImage = await pdfDoc.embedPng(qrBuffer);

    drawText(pallet.pallet_id, 18, 48, 18, true, 115);
    drawText(pallet.itemcode, 18, 65, 12, true, 85);
    drawText(pallet.wo, 18, 82, 12, true, 85);
    drawText(pallet.product_name, 18, 99, 10, false, 120);
    drawText(pallet.customer, 18, 116, 10, false, 120);
    drawText(pallet.machine, 110, 65, 12, true, 38);
    drawText(formatNumber(pallet.quantity), 110, 82, 18, true, 38);
    drawText(formatNumber(pallet.quanorder), 110, 99, 11, false, 38);
    drawText(pallet.note, 18, 133, 9, false, 120);

    page.drawImage(qrImage, {
      x: mm(155),
      y: pageHeight - mm(56),
      width: mm(35),
      height: mm(35),
    });

    page.drawText(pallet.pallet_id, {
      x: mm(155),
      y: pageHeight - mm(61),
      size: 8,
      font: boldFont,
      color: rgb(0, 0, 0),
      maxWidth: mm(35),
    });

    const pdfBytes = await pdfDoc.save();

    const filename = sanitizeFilename(
      `${pallet.pallet_id}.pdf`,
    );

    return new Response(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition":
          `inline; filename="${filename}"`,
        "Cache-Control":
          "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    console.error("Generate pallet PDF failed", error);

    if (
      error instanceof Error &&
      error.message.includes("ENOENT")
    ) {
      return NextResponse.json(
        {
          error:
            "Không tìm thấy PDF mẫu hoặc font. Kiểm tra public/templates/pallet-label.pdf và assets/fonts.",
        },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Không thể tạo PDF.",
      },
      { status: 500 },
    );
  }
}
