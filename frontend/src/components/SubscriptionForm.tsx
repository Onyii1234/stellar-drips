'use client';

/**
 * SubscriptionForm.tsx
 *
 * Full subscription creation form with inline validation,
 * loading state, success and error notifications.
 *
 * Requirements: 10.1–10.9
 */

import { useState, type FormEvent } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { buildAndSubmitSubscribe } from '@/lib/transaction_builder';
import {
  validateSubscriptionForm,
  isFormValid,
  DEFAULT_INTERVAL_SECONDS,
  type FieldErrors,
} from '@/lib/validation';
import { CONTRACT_ID, NETWORK_PASSPHRASE, RPC_URL } from '@/constants/network';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SuccessData {
  txHash: string;
  merchant: string;
  token: string;
  amount: string;
  interval: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SubscriptionForm() {
  const { publicKey } = useWallet();

  // Form field state
  const [merchantAddress, setMerchantAddress] = useState('');
  const [tokenAddress, setTokenAddress]       = useState('');
  const [amount, setAmount]                   = useState('');
  const [interval, setInterval]               = useState(
    String(DEFAULT_INTERVAL_SECONDS), // Req 10.8 — pre-populate 30 days
  );

  // Submission state — isSubmitting controls BOTH button disable AND spinner (Req 10.7)
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors]   = useState<FieldErrors>({});
  const [txError, setTxError]           = useState<string | null>(null);
  const [successData, setSuccessData]   = useState<SuccessData | null>(null);

  // ── Submit handler ────────────────────────────────────────────────────────

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    // Clear previous results
    setTxError(null);
    setSuccessData(null);

    // Req 10.9 — validate before any Freighter/RPC call
    const errors = validateSubscriptionForm({
      merchantAddress,
      tokenAddress,
      amount,
      interval,
    });
    setFieldErrors(errors);
    if (!isFormValid(errors)) return; // halt — do not call Transaction_Builder

    if (!publicKey) return; // guard (button should be disabled anyway)

    // Req 10.7 — disable button + spinner simultaneously
    setIsSubmitting(true);

    try {
      const result = await buildAndSubmitSubscribe(
        {
          subscriber: publicKey,
          merchant:   merchantAddress.trim(),
          token:      tokenAddress.trim(),
          amount:     Number(amount),
          interval:   Number(interval),
        },
        CONTRACT_ID,
        publicKey,
        NETWORK_PASSPHRASE,
        RPC_URL,
      );

      // Req 10.5 — success notification with subscription details
      setSuccessData({
        txHash:   result.txHash,
        merchant: merchantAddress.trim(),
        token:    tokenAddress.trim(),
        amount:   amount,
        interval: interval,
      });
    } catch (err) {
      // Req 10.6 — classify error by source
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.toLowerCase().includes('signing failed') || raw.toLowerCase().includes('rejected')) {
        setTxError('Transaction rejected: you declined the signing request in Freighter.');
      } else if (raw.toLowerCase().includes('timeout')) {
        setTxError('Transaction timed out waiting for confirmation. Please try again.');
      } else {
        setTxError(`Transaction failed: ${raw}`);
      }
    } finally {
      // Req 10.7 — clear BOTH disabled state and spinner at the same moment
      setIsSubmitting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="w-full max-w-lg mx-auto bg-gray-900 rounded-2xl shadow-xl p-8 text-white">
      <h2 className="text-2xl font-bold mb-2">Create Subscription</h2>
      <p className="text-gray-400 text-sm mb-6">
        Authorize a recurring on-chain payment using your Freighter wallet.
      </p>

      {/* ── Success notification ── */}
      {successData && (
        <div
          role="alert"
          className="mb-6 rounded-lg bg-green-900/60 border border-green-600 p-4 text-sm"
        >
          <p className="font-semibold text-green-300 mb-1">✓ Subscription created</p>
          <p className="text-gray-300 break-all">Tx: {successData.txHash}</p>
          <p className="text-gray-300 mt-1 break-all">
            Merchant: {successData.merchant}
          </p>
          <p className="text-gray-300">
            Amount: {successData.amount} — Interval: {successData.interval}s
          </p>
          <p className="text-gray-300 break-all">Token: {successData.token}</p>
        </div>
      )}

      {/* ── Error notification ── */}
      {txError && (
        <div
          role="alert"
          className="mb-6 rounded-lg bg-red-900/60 border border-red-600 p-4 text-sm text-red-200"
        >
          <p className="font-semibold mb-1">Transaction error</p>
          <p>{txError}</p>
          <p className="mt-2 text-gray-400 text-xs">
            Your form data has been preserved — review and retry.
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-5">

        {/* Merchant address */}
        <div>
          <label
            htmlFor="merchantAddress"
            className="block text-sm font-medium text-gray-300 mb-1"
          >
            Merchant address
          </label>
          <input
            id="merchantAddress"
            type="text"
            placeholder="GABC…"
            value={merchantAddress}
            onChange={(e) => setMerchantAddress(e.target.value)}
            disabled={isSubmitting}
            aria-describedby={fieldErrors.merchantAddress ? 'err-merchant' : undefined}
            aria-invalid={!!fieldErrors.merchantAddress}
            className="w-full rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-sm
                       text-white placeholder-gray-500 focus:outline-none focus:ring-2
                       focus:ring-blue-500 disabled:opacity-50"
          />
          {fieldErrors.merchantAddress && (
            <p id="err-merchant" role="alert" className="mt-1 text-xs text-red-400">
              {fieldErrors.merchantAddress}
            </p>
          )}
        </div>

        {/* Token address */}
        <div>
          <label
            htmlFor="tokenAddress"
            className="block text-sm font-medium text-gray-300 mb-1"
          >
            Token contract address
          </label>
          <input
            id="tokenAddress"
            type="text"
            placeholder="CABC…"
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value)}
            disabled={isSubmitting}
            aria-describedby={fieldErrors.tokenAddress ? 'err-token' : undefined}
            aria-invalid={!!fieldErrors.tokenAddress}
            className="w-full rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-sm
                       text-white placeholder-gray-500 focus:outline-none focus:ring-2
                       focus:ring-blue-500 disabled:opacity-50"
          />
          {fieldErrors.tokenAddress && (
            <p id="err-token" role="alert" className="mt-1 text-xs text-red-400">
              {fieldErrors.tokenAddress}
            </p>
          )}
        </div>

        {/* Amount */}
        <div>
          <label
            htmlFor="amount"
            className="block text-sm font-medium text-gray-300 mb-1"
          >
            Amount <span className="text-gray-500">(token units)</span>
          </label>
          <input
            id="amount"
            type="number"
            min="1"
            step="1"
            placeholder="100"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={isSubmitting}
            aria-describedby={fieldErrors.amount ? 'err-amount' : undefined}
            aria-invalid={!!fieldErrors.amount}
            className="w-full rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-sm
                       text-white placeholder-gray-500 focus:outline-none focus:ring-2
                       focus:ring-blue-500 disabled:opacity-50"
          />
          {fieldErrors.amount && (
            <p id="err-amount" role="alert" className="mt-1 text-xs text-red-400">
              {fieldErrors.amount}
            </p>
          )}
        </div>

        {/* Interval */}
        <div>
          <label
            htmlFor="interval"
            className="block text-sm font-medium text-gray-300 mb-1"
          >
            Interval <span className="text-gray-500">(seconds)</span>
          </label>
          <input
            id="interval"
            type="number"
            min="86400"
            max="31536000"
            step="1"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            disabled={isSubmitting}
            aria-describedby={fieldErrors.interval ? 'err-interval' : undefined}
            aria-invalid={!!fieldErrors.interval}
            className="w-full rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-sm
                       text-white placeholder-gray-500 focus:outline-none focus:ring-2
                       focus:ring-blue-500 disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-gray-500">
            Default: 2592000 s (30 days). Range: 86400 s – 31536000 s.
          </p>
          {fieldErrors.interval && (
            <p id="err-interval" role="alert" className="mt-1 text-xs text-red-400">
              {fieldErrors.interval}
            </p>
          )}
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={isSubmitting || !publicKey}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-blue-600
                     hover:bg-blue-500 active:bg-blue-700 disabled:opacity-50
                     disabled:cursor-not-allowed px-4 py-3 text-sm font-semibold
                     transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          {/* Req 10.7 — spinner and disabled clear together in finally block */}
          {isSubmitting && (
            <svg
              className="animate-spin h-4 w-4 text-white"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12" cy="12" r="10"
                stroke="currentColor" strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v8H4z"
              />
            </svg>
          )}
          {isSubmitting ? 'Submitting…' : 'Authorize Subscription'}
        </button>
      </form>
    </div>
  );
}
