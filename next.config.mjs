/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['pg', 'mongodb'],
  devIndicators: false,
};
export default nextConfig;
