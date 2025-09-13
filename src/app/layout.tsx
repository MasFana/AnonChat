import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'),
  title: {
    default: 'Anon Chat – Real‑time Anonymous Chat with Polls',
    template: '%s · Anon Chat'
  },
  description: 'Create disposable real‑time chat rooms with live polling. No sign up, no history – just instant anonymous conversations.',
  keywords: ['anonymous chat', 'real-time chat', 'live polls', 'ephemeral chat', 'no signup chat', 'SSE chat app', 'polling chat'],
  authors: [{ name: 'Anon Chat' }],
  creator: 'Anon Chat',
  publisher: 'Anon Chat',
  openGraph: {
    title: 'Anon Chat – Real‑time Anonymous Chat with Polls',
    description: 'Spin up a temporary anonymous room and chat with live sentiment polls. Fast. Ephemeral. Private.',
    url: '/',
    siteName: 'Anon Chat',
    locale: 'en_US',
    type: 'website'
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Anon Chat – Real‑time Anonymous Chat with Polls',
    description: 'Instant anonymous rooms. Real‑time messages. Live polls. Vanish without a trace.',
    creator: '@yourhandle'
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1
    }
  },
  alternates: {
    canonical: '/'
  },
  category: 'communication',
  applicationName: 'Anon Chat',
  generator: 'Next.js',
  viewport: {
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover'
  },
  manifest: '/manifest.webmanifest'
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased `}
      >
        {/* SEO: Add verification tags here (e.g. Google Search Console, Bing, etc.) */}
        {children}
        {/* Structured Data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'ChatApplication',
              name: 'Anon Chat',
              applicationCategory: 'CommunicationApplication',
              operatingSystem: 'Any',
              description: 'Anonymous real-time chat rooms with live polls and no sign up.',
              creator: { '@type': 'Organization', name: 'Anon Chat' },
              offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
              featureList: [
                'Anonymous ephemeral rooms',
                'Real-time messaging (SSE)',
                'Live polling',
                'No account required'
              ],
              url: process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
            }),
          }}
        />
      </body>
    </html>
  );
}
