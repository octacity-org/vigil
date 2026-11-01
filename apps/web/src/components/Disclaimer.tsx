/**
 * The disclaimer shown on every page (#85). The text is the Turkish wording agreed in `docs/legal.md` §3;
 * a test keeps the two identical, so change it there first.
 */

export const DISCLAIMER_TR =
  "Vigil yatırım tavsiyesi vermez. Burada yer alan bilgiler, şirketlerin Kamuyu Aydınlatma Platformu'nda (KAP) " +
  "yayımladığı finansal tablolardan hesaplanmıştır ve yatırım danışmanlığı kapsamında değildir. Alım, satım veya " +
  "elde tutma önerisi, hedef fiyat ya da getiri tahmini içermez. Hesaplamalarda hata olabilir; her bulgu kaynağıyla " +
  "birlikte gösterilir ve karar vermeden önce asıl bildirimle karşılaştırılmalıdır.";

export function Disclaimer() {
  return (
    <aside role="note" aria-label="Yasal uyarı" className="disclaimer">
      <p>{DISCLAIMER_TR}</p>
    </aside>
  );
}
