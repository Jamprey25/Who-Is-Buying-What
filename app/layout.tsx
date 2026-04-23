import "./globals.css";
import type { ReactNode } from "react";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";

const fontSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jet",
  display: "swap",
});

export const metadata = {
  title: "Who Is Buying What",
  description: "Live M&A deal feed from SEC EDGAR",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="scroll-smooth">
      <body
        suppressHydrationWarning
        className={`${fontSans.variable} ${fontMono.variable} bg-slate-950 font-sans text-slate-100 antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
