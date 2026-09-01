import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Elloindia Photo Booth',
  description: 'Multi-tenant AI photo booth platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
