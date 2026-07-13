import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";
const codespaceName = process.env.CODESPACE_NAME;
const port = process.env.PORT ?? "3000";

const forwardingDomain =
  process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ??
  "app.github.dev";

const codespaceHost = codespaceName
  ? `${codespaceName}-${port}.${forwardingDomain}`
  : null;

const developmentOrigins = [
  `localhost:${port}`,
  `127.0.0.1:${port}`,
  ...(codespaceHost ? [codespaceHost] : []),
];

const nextConfig: NextConfig = {
  ...(isDevelopment
    ? {
        allowedDevOrigins: developmentOrigins,

        experimental: {
          serverActions: {
            allowedOrigins: developmentOrigins,
          },
        },
      }
    : {}),
};

export default nextConfig;