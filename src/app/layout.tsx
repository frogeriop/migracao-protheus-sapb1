import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
// import Sidebar
import { Sidebar } from "@/components/layout/Sidebar";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Migração Protheus -> SAP B1",
  description: "Ferramenta de migração de dados via Supabase",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body className={inter.className}>
        <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: 'var(--background)' }}>
          <Sidebar />
          <main style={{ flex: 1, padding: '2rem', overflowY: 'auto' }}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
