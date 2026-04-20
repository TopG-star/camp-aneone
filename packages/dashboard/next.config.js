/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@oneon/contracts"],
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
