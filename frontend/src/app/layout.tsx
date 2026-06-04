import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { WalletProvider } from '@/context/WalletContext';
import './globals.css';

export const metadata: Metadata = {
  title: 'SorobanPay — Decentralized Recurring Payments',
  description:
    'Non-custodial subscription and recurring payment protocol built on Stellar Soroban.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-950 text-white antialiased">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
