import type { Metadata } from "next";
import { getLang } from "@/lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "AnimeGo",
  description: "追你该追的那一话",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const lang = await getLang();
  return (
    <html lang={lang === "en" ? "en" : "zh-CN"}>
      <body>{children}</body>
    </html>
  );
}
