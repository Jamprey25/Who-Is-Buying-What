"use client";

import { useAcquisitionFeed } from "../src/hooks/useAcquisitionFeed";

export default function HomePage() {
  const { deals, isConnected } = useAcquisitionFeed();

  return (
    <main>
      <p>{isConnected ? "Live" : "Connecting…"}</p>
      <ul>
        {deals.map((deal) => (
          <li key={deal.id}>
            {deal.acquirer} → {deal.target}
            {deal.transactionValueUSD !== null && (
              <> (${(deal.transactionValueUSD / 1e9).toFixed(2)}B)</>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
