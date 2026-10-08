/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@oneon/contracts"],
  async headers() {
    return [
      {
        // The dashboard is never framed (spec §6.5).
        source: "/:path*",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }],
      },
    ];
  },
  async rewrites() {
    const agentServer = process.env.AGENT_SERVER_URL ?? "http://localhost:4000";
    return [
      {
        // Proxy all /api/* EXCEPT /api/auth/* (NextAuth) to agent-server
        source: "/api/:path((?!auth).*)",
        destination: `${agentServer}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
