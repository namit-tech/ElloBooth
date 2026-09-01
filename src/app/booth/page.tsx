import type { Metadata } from 'next';
import Booth from './Booth';

export const metadata: Metadata = {
  title: 'Photo Booth',
  // The booth runs on a venue screen; keep it out of search results.
  robots: { index: false, follow: false },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  userScalable: false,
};

export default function BoothPage() {
  return <Booth />;
}
