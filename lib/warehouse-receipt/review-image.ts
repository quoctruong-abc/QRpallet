type ImageRow = { cells: string[]; shortage: boolean };

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  return text.split(/\r?\n/).flatMap((paragraph) => {
    const lines: string[] = [];
    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= width) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const ch of word) {
        if (line && ctx.measureText(line + ch).width > width) {
          lines.push(line);
          line = "";
        }
        line += ch;
      }
    }
    lines.push(line);
    return lines;
  });
}

export function renderReviewImage(headers: string[], rows: ImageRow[], title: string, subtitle: string): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Không tạo được ảnh bảng Review.");

  const columnWidths = [110, 138, 254, 178, 108, 278, 93];
  const margin = 24;
  const padding = 11;
  const lineHeight = 20;
  const tableTop = 88;
  const width = columnWidths.reduce((sum, value) => sum + value, 2 * margin);
  const headerFont = "bold 14px Arial, sans-serif";
  const rowFont = "14px Arial, sans-serif";
  const layout = (cells: string[], font: string, minHeight: number) => {
    ctx.font = font;
    const lines = cells.map((value, index) => wrap(ctx, value, columnWidths[index] - padding * 2));
    return { lines, height: Math.max(minHeight, ...lines.map((cell) => cell.length * lineHeight + padding * 2)) };
  };
  const heading = layout(headers, headerFont, 52);
  const body = rows.map((row) => ({ ...layout(row.cells, rowFont, 46), shortage: row.shortage }));
  const height = body.reduce((sum, row) => sum + row.height, tableTop + heading.height + margin);
  const scale = Math.min(2, 16_384 / height, Math.sqrt(16_000_000 / (width * height)));
  if (scale < 0.75) throw new Error("Bảng quá dài để sao chép thành ảnh. Hãy thu hẹp bộ lọc rồi thử lại.");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  ctx.scale(scale, scale);
  ctx.textBaseline = "top";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width / scale, canvas.height / scale);
  ctx.fillStyle = "#101828";
  ctx.font = "bold 24px Arial, sans-serif";
  ctx.fillText(title, margin, 22);
  ctx.fillStyle = "#475467";
  ctx.font = rowFont;
  ctx.fillText(subtitle, margin, 56);

  let y = tableTop;
  function draw(row: typeof heading, font: string, background: string) {
    if (!ctx) return;
    let x = margin;
    ctx.font = font;
    row.lines.forEach((lines, index) => {
      const cellWidth = columnWidths[index];
      ctx.fillStyle = background;
      ctx.fillRect(x, y, cellWidth, row.height);
      ctx.strokeStyle = "#d0d5dd";
      ctx.strokeRect(x, y, cellWidth, row.height);
      ctx.fillStyle = "#101828";
      const numeric = index === 4 || index === 6;
      ctx.textAlign = numeric ? "right" : "left";
      lines.forEach((line, i) => ctx.fillText(line, numeric ? x + cellWidth - padding : x + padding, y + padding + i * lineHeight));
      x += cellWidth;
    });
    y += row.height;
  }
  draw(heading, headerFont, "#eef2f7");
  body.forEach((row) => draw(row, rowFont, row.shortage ? "#fffaeb" : "#fff"));

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Không tạo được ảnh bảng Review."));
    }, "image/png");
  });
}
