import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tali",
  description: "Tali web foundation shell",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
