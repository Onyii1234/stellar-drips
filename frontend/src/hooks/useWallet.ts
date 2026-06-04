'use client';

/**
 * useWallet.ts
 *
 * Hook for consuming WalletContext.
 * Must be used inside a <WalletProvider> tree.
 *
 * Requirements: 9.5, 9.6
 */

import { useContext } from 'react';
import { WalletContext, type WalletContextValue } from '@/context/WalletContext';

/**
 * Returns the wallet context value.
 * Throws a descriptive error when called outside <WalletProvider>.
 */
export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (ctx === null) {
    throw new Error(
      'useWallet must be used within a <WalletProvider>. ' +
        'Wrap your app (or page) with <WalletProvider> in app/layout.tsx.',
    );
  }
  return ctx;
}
