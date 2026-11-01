import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <h1>Sayfa bulunamadı</h1>
      <p>
        Aradığınız sayfa yok. <Link href="/bulgular">Bulgulara dönün</Link>.
      </p>
    </>
  );
}
