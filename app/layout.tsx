import type { ReactNode } from "react";

export const metadata = {
  title: "Who Is Buying What",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
