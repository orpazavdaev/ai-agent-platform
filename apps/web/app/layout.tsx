import type { ReactNode } from "react";
import { Source_Sans_3, Space_Mono, Syne } from "next/font/google";
import "./globals.css";

const display = Syne({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-display",
});

const sans = Source_Sans_3({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const mono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-mono",
});

export const metadata = {
  title: "CodePilot",
  description: "Investigate software engineering tasks with a local agent.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${display.variable} ${sans.variable} ${mono.variable} ${sans.className}`}
      >
        {children}
      </body>
    </html>
  );
}
