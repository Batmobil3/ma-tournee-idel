import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);

  return {
    metadataBase,
    title: "Ma Tournée IDEL",
    description:
      "Les tournées du matin et du soir, patient après patient, simplement.",
    applicationName: "Ma Tournée IDEL",
    manifest: "./manifest.webmanifest",
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "Ma Tournée",
    },
    formatDetection: {
      telephone: false,
    },
    icons: {
      icon: "./icon-192.png",
      apple: "./apple-touch-icon.png",
    },
    openGraph: {
      type: "website",
      locale: "fr_FR",
      title: "Ma Tournée IDEL",
      description: "Votre journée, sans détour. Deux tournées, un patient à la fois.",
      images: [{ url: "/og.jpg", width: 945, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Ma Tournée IDEL",
      description: "Votre journée, sans détour. Deux tournées, un patient à la fois.",
      images: ["/og.jpg"],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#173b38",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
