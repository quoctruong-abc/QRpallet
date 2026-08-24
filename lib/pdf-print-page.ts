import "server-only";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

type PdfPrintPageOptions = {
  closeAfterPrint?: boolean;
  printJobId?: string | null;
};

export function createPdfPrintPage(
  pdfUrl: string,
  title: string,
  options: PdfPrintPageOptions = {},
) {
  const safeTitle = escapeHtml(title);
  const serializedPdfUrl = JSON.stringify(pdfUrl).replaceAll("<", "\\u003c");
  const closeAfterPrint = options.closeAfterPrint === true;
  const serializedPrintJobId = JSON.stringify(options.printJobId ?? null).replaceAll("<", "\\u003c");

  const html = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; background: #eef2f7; font-family: Arial, Helvetica, sans-serif; }
    body { display: grid; grid-template-rows: auto minmax(0, 1fr); }
    .print-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 14px;
      border-bottom: 1px solid #d0d5dd;
      background: #ffffff;
      box-shadow: 0 3px 12px rgba(16, 24, 40, 0.08);
      z-index: 2;
    }
    .print-copy { min-width: 0; }
    .print-copy strong { display: block; color: #172033; }
    .print-copy span { display: block; margin-top: 3px; color: #667085; font-size: 0.82rem; }
    .print-button {
      min-height: 40px;
      flex: 0 0 auto;
      padding: 8px 16px;
      border: 0;
      border-radius: 10px;
      color: #ffffff;
      background: #155eef;
      cursor: pointer;
      font: inherit;
      font-weight: 800;
    }
    .print-button:disabled { opacity: 0.55; cursor: wait; }
    #pdf-frame { width: 100%; height: 100%; border: 0; background: #ffffff; }
    @media (max-width: 640px) {
      .print-toolbar { align-items: stretch; flex-direction: column; }
      .print-button { width: 100%; }
    }
    @media print {
      body { display: block; background: #ffffff; }
      .print-toolbar { display: none !important; }
      #pdf-frame { width: 100%; height: 100vh; }
    }
  </style>
</head>
<body>
  <div class="print-toolbar">
    <div class="print-copy">
      <strong>${safeTitle}</strong>
      <span id="print-status">Đang chuẩn bị PDF...</span>
    </div>
    <button class="print-button" id="print-button" type="button" disabled>In ngay</button>
  </div>
  <iframe id="pdf-frame" title="${safeTitle}"></iframe>
  <script>
    (() => {
      const frame = document.getElementById("pdf-frame");
      const button = document.getElementById("print-button");
      const status = document.getElementById("print-status");
      const closeAfterPrint = ${closeAfterPrint};
      const printJobId = ${serializedPrintJobId};
      let printStarted = false;
      let printFinished = false;

      function notifyHost(printStatus, message) {
        if (!printJobId) return;
        const payload = {
          source: "qr-pallet-print-page",
          jobId: printJobId,
          status: printStatus,
          message: message || null,
        };

        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, window.location.origin);
        }
        if (window.parent !== window) {
          window.parent.postMessage(payload, window.location.origin);
        }
      }

      function finishPrint() {
        if (printFinished) return;
        printFinished = true;
        status.textContent = "Đã gửi lệnh in.";
        notifyHost("sent");
        if (closeAfterPrint && window.opener && !window.opener.closed) {
          window.setTimeout(() => window.close(), 150);
        }
      }

      function failPrint() {
        printStarted = false;
        button.disabled = false;
        status.textContent = "Không thể gửi lệnh in. Hãy nhấn In ngay để thử lại.";
        notifyHost("error", "Không thể gửi lệnh in tới trình duyệt.");
      }

      function openPrintDialog() {
        if (printStarted) return;
        printStarted = true;
        button.disabled = true;
        status.textContent = "Đang gửi lệnh in...";
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
          window.setTimeout(finishPrint, 250);
        } catch (error) {
          try {
            window.focus();
            window.print();
            window.setTimeout(finishPrint, 250);
          } catch (fallbackError) {
            failPrint();
          }
        }
      }

      window.addEventListener("afterprint", finishPrint);

      button.addEventListener("click", openPrintDialog);
      frame.addEventListener("load", () => {
        try {
          frame.contentWindow.addEventListener("afterprint", finishPrint);
        } catch (error) {
          // The fallback timer in openPrintDialog still closes this print page.
        }
        button.disabled = false;
        status.textContent = "PDF đã sẵn sàng. Nếu hộp thoại chưa mở, nhấn In ngay.";
        window.setTimeout(openPrintDialog, 900);
      });

      frame.src = ${serializedPdfUrl};

      window.setTimeout(() => {
        if (!printStarted && button.disabled) {
          button.disabled = false;
          status.textContent = "PDF đang tải chậm. Có thể nhấn In ngay để thử lại.";
        }
      }, 8000);
    })();
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
