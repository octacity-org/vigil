import type { Metadata } from "next";

export const metadata: Metadata = { title: "Bulgu" };

/** Finding card (#83, #247). */
export default async function FindingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <h1>Bulgu {decodeURIComponent(id)}</h1>;
}
