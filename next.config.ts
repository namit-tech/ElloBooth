import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['mongoose'],
  experimental: {
    // Kiosk uploads a full-resolution capture as base64.
    serverActions: { bodySizeLimit: '30mb' },
  },
};

export default nextConfig;
