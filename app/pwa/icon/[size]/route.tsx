import { ImageResponse } from "next/og";

const SUPPORTED_SIZES = new Set([180, 192, 512]);

export const runtime = "edge";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ size: string }> },
) {
  const { size: rawSize } = await params;
  const size = Number(rawSize);

  if (!Number.isInteger(size) || !SUPPORTED_SIZES.has(size)) {
    return new Response("Icon size not found.", { status: 404 });
  }

  const response = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#155eef",
          padding: size * 0.075,
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            background: "#ffffff",
            borderRadius: size * 0.18,
            padding: size * 0.105,
            boxShadow: `0 ${size * 0.025}px ${size * 0.07}px rgba(16, 24, 40, 0.22)`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              color: "#155eef",
            }}
          >
            <span
              style={{
                fontSize: size * 0.19,
                fontWeight: 900,
                letterSpacing: size * 0.008,
                lineHeight: 1,
              }}
            >
              SVN
            </span>
            <span
              style={{
                fontSize: size * 0.07,
                fontWeight: 800,
                color: "#475467",
                letterSpacing: size * 0.005,
              }}
            >
              WAREHOUSE
            </span>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                color: "#101828",
              }}
            >
              <span
                style={{
                  fontSize: size * 0.24,
                  fontWeight: 950,
                  lineHeight: 0.9,
                }}
              >
                WH
              </span>
              <span
                style={{
                  marginTop: size * 0.025,
                  fontSize: size * 0.052,
                  fontWeight: 800,
                  color: "#667085",
                }}
              >
                QR PALLET
              </span>
            </div>

            <div
              style={{
                position: "relative",
                display: "flex",
                width: size * 0.255,
                height: size * 0.255,
                borderRadius: size * 0.025,
                background: "#101828",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: size * 0.025,
                  top: size * 0.025,
                  width: size * 0.072,
                  height: size * 0.072,
                  border: `${Math.max(2, size * 0.012)}px solid #ffffff`,
                  background: "#101828",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  right: size * 0.025,
                  top: size * 0.025,
                  width: size * 0.072,
                  height: size * 0.072,
                  border: `${Math.max(2, size * 0.012)}px solid #ffffff`,
                  background: "#101828",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  left: size * 0.025,
                  bottom: size * 0.025,
                  width: size * 0.072,
                  height: size * 0.072,
                  border: `${Math.max(2, size * 0.012)}px solid #ffffff`,
                  background: "#101828",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  right: size * 0.034,
                  bottom: size * 0.034,
                  width: size * 0.045,
                  height: size * 0.045,
                  background: "#ffffff",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  right: size * 0.09,
                  bottom: size * 0.034,
                  width: size * 0.025,
                  height: size * 0.025,
                  background: "#ffffff",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  right: size * 0.034,
                  bottom: size * 0.095,
                  width: size * 0.025,
                  height: size * 0.025,
                  background: "#ffffff",
                }}
              />
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: size,
      height: size,
    },
  );

  response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return response;
}
