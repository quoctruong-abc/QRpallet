import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "SVN Warehouse",
    short_name: "SVN Warehouse",
    description: "Hệ thống planning, xuất tem pallet, quét QR và nhập kho SVN.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#155eef",
    lang: "vi",
    icons: [
      {
        src: "/pwa/icon/192",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/pwa/icon/512",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
