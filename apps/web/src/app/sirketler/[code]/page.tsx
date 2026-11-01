import type { Metadata } from "next";

export const metadata: Metadata = { title: "Şirket" };

/** Company page (#82, #243). */
export default async function CompanyPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <h1>{decodeURIComponent(code).toLocaleUpperCase("tr-TR")}</h1>;
}
