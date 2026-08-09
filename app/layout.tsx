import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Flight OTA — Prototype',
  description: 'Book a flight and pay on the Hyperswitch sandbox.',
};

// Minimal root layout: this task is the first to render a page at all, so
// there is no design system yet, just the bare shell the App Router
// requires.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
