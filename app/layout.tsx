import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Fraunces, IBM_Plex_Sans, Geist_Mono } from 'next/font/google';
import './globals.css';

const display = Fraunces({
  subsets: ['latin'], weight: ['400', '600'], variable: '--font-display', display: 'swap',
});
const body = IBM_Plex_Sans({
  subsets: ['latin'], weight: ['400', '500'], variable: '--font-body', display: 'swap',
});
const mono = Geist_Mono({
  subsets: ['latin'], weight: ['400'], variable: '--font-outlier', display: 'swap',
});

export const metadata: Metadata = {
  title: 'Flight OTA — Prototype',
  description: 'Book a flight and pay on the Hyperswitch sandbox.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
