# Vigil

**Borsa İstanbul şirketlerinin finansal tablolarındaki önemli değişimleri KAP verisinden otomatik olarak bulan, her bulgunun hesabını adım adım gösteren açık kaynak bir analiz aracı.**

> ⚠️ **Yatırım tavsiyesi değildir.** Vigil al/sat önerisi, hedef fiyat ya da getiri tahmini üretmez. Yalnızca şirketlerin kamuya açıkladığı finansal tablolarda neyin değiştiğini raporlar.

Durum: **Taslak / Faz 0** · Model: açık kaynak, gönüllü ekip (7 kişi) · Lisans: Apache-2.0

---

## İçindekiler

1. [Projenin hikâyesi](#1-projenin-hikâyesi)
2. [Vigil ne yapar?](#2-vigil-ne-yapar)
3. [Veri kaynağı: KAP](#3-veri-kaynağı-kap)
4. [Dosya yapısı ve şablonlar](#4-dosya-yapısı-ve-şablonlar)
5. [Ölçek, dönem ve TMS 29](#5-ölçek-dönem-ve-tms-29)
6. [Finansal metodoloji](#6-finansal-metodoloji)
7. [Çalışılmış örnek: KATMR 2026/2](#7-çalışılmış-örnek-katmr-20262)
8. [Diğer doğrulanmış örnekler](#8-diğer-doğrulanmış-örnekler)
9. [Sinyaller](#9-sinyaller)
10. [Doğrulama](#10-doğrulama)
11. [Mimari](#11-mimari)
12. [LLM ve makine öğrenmesi](#12-llm-ve-makine-öğrenmesi)
13. [Ekip ve roller](#13-ekip-ve-roller)
14. [Yol haritası](#14-yol-haritası)
15. [Açık kaynak çalışma düzeni](#15-açık-kaynak-çalışma-düzeni)
16. [Mevcut kod durumu](#16-mevcut-kod-durumu)
17. [Bilinen sorunlar](#17-bilinen-sorunlar)
18. [Çapraz kontrolden çıkan dersler](#18-çapraz-kontrolden-çıkan-dersler)
19. [Açık kararlar](#19-açık-kararlar)
20. [Sunumlar ve kaynaklar](#20-sunumlar-ve-kaynaklar)

---

## 1. Projenin hikâyesi

- Fikir ilk olarak Octacity GitHub topluluğunda bir finans projesi olarak **Discussion #11**'de açıldı.
- Topluluk proje seçerken temel kriter **yapılabilirlik** oldu: verisine erişemediğimiz bir projeye başlamak anlamsız. Örneğin bankaların müşteri verisine dayanan fikirler bu yüzden elendi.
- Vigil bu kriteri geçiyor: borsa şirketleri finansal tablolarını yasal zorunluluk olarak KAP'a yüklüyor. Veri kamuya açık ve KAP, şirketlerin piyasayı bilgilendirdiği resmî kanal olduğu için bu servisi kapatamaz.
- Veri erişimi, KAP'ın toplu finansal tablo servisi bulunarak çözüldü (bkz. bölüm 3).
- Tasarım, Claude ve Gemini arasında çok turlu bir çapraz kontrolden geçirildi. Gemini kodu ve dokümanları, Claude sunumları ve finansal metodolojiyi üstlendi. Çapraz kontrolün amacı projeyi hızlandırmak değil, **eksiklikleri bulmaktı** (bkz. bölüm 18).
- Proje şu an **açık kaynak** olarak, gönüllü ve farklı üniversitelerden 7 kişilik bir ekiple yürütülüyor. Okul önceliklidir; plan buna göre esnek tutuldu.

---

## 2. Vigil ne yapar?

Her çeyrek yüzlerce şirket KAP'a finansal tablo yükler. Bir analistin hepsini okuyup "bu çeyrek nerede ne kırıldı?" sorusunu cevaplaması mümkün değil. Vigil bu taramayı yapar:

1. KAP'tan bütün şirketlerin bilanço, gelir tablosu ve nakit akış tablosunu indirir.
2. Tabloları ortak bir veri modeline çevirir ve tutarlılığını kontrol eder.
3. Önceden tanımlanmış finansal kurallara göre **önemli değişimleri** işaretler.
4. Her sinyal için kullanılan rakamları, hesap adımlarını ve kaynak satırı gösterir.

### Temel ilkeler

- **Kural tabanlı:** Sinyaller açık formüllerle üretilir; her sonucun hesabı yeniden yapılabilir.
- **Tahmin yok:** Bir ölçüt mevcut veriden hesaplanamıyorsa Vigil yaklaşık değer üretmez, "hesaplanamadı" der.
- **Önce tutarlılık:** Mutabakattan ve ara toplam kontrolünden geçmeyen kayıt sinyal üretmez.
- **Uydurma istatistik yok:** Dokümanlarda, sunumlarda ve çıktılarda yalnızca gerçek veriden hesaplanmış rakamlar kullanılır.

---

## 3. Veri kaynağı: KAP

### Toplu finansal tablo servisi

```
GET https://www.kap.org.tr/tr/api/financialTable/download/{yıl}/{çeyrek}
```

- Her çeyrek için tek bir zip arşivi döner; içinde şirket başına bir `.xls` dosyası bulunur.
- Dosyalar uzantıya rağmen **UTF-8 kodlu HTML**'dir. (İlk başta yanlışlıkla cp1254 sanıldı ve etiketler bozuk çıktı; düzeltildi, bozuk etiket sayısı 0'a indi.)
- Veri yasal olarak kamuya açıktır. Ham dosyalar depoya **konmaz**; herkes indirme betiğiyle kendisi indirir.

### İndirmede karşılaşılan sorunlar

| Sorun | Durum / çözüm |
|---|---|
| İndirmeler sık sık yarıda kesiliyor | Yarım zip'ten tam dosyalar kurtarılabiliyor: yerel başlıklar (`PK\x03\x04`) okunup her dosya `zlib.decompressobj(-15)` ile açılıyor. 2026/2 için 246 dosya bu yöntemle kurtarıldı |
| `checkFileExist` servisi | Güvenilir cevap vermiyor; dosyanın varlığı için kullanılmamalı |
| Bildirim listesi (`POST disclosure/list/main`) | Tarayıcıda çalışıyor, doğrudan istekte HTTP 400 dönüyor; doğru istek gövdesi henüz bulunamadı |

### Şirket araması

KAP'ın şirket sayfalarından tek tek belge çekmek de mümkün, ama toplu servis bütün şirketleri tek seferde verdiği için ana yöntem odur.

---

## 4. Dosya yapısı ve şablonlar

### Beş şablon ailesi

KAP beş ayrı tablo düzeni kullanır. **Aynı satır numarası farklı şablonlarda farklı anlama gelir.**

| Şablon | 2026/2 örneğinde dosya sayısı |
|---|---|
| Genel (sanayi, ticaret, hizmet) | 214 (310003: 141 · 310000: 72 · 310002: 1) |
| Banka | 14 |
| Finans | 8 |
| Holding | 5 |
| Sigorta | 5 |

**Örnek:** 58. satır genel şablonda "durdurulan faaliyetler", holdingde "ertelenmiş vergi", sigortada "hayat teknik gideri"dir. Bu yüzden satır eşleme, koddan değil finans bilgisinden çıkarılmalıdır.

### Tablo kodları

| Önek | Tablo |
|---|---|
| 21 | Bilanço |
| 31 | Gelir tablosu |
| 41 / 42 | Diğer kapsamlı gelir |
| 51 / 52 | Nakit akış tablosu (doğrudan / dolaylı) |
| 61 | Özkaynak değişim tablosu |

### Satır ve kolon kimlikleri

- Satır kimliği: `{şablon}_role_{kod}-row-{n}` (ör. `general_role_310003-row-42`)
- Değer kolonları: `col-order-class-4` … `col-order-class-9`
- Genel şablonda kolonlar cari dönem, önceki dönem ve (varsa) 3 aylık değerlerdir. Bilançoda **col-6 doluysa** önceki dönem rakamları yeniden düzenlenmiştir.
- Banka ve finans bilançolarında düzen farklıdır: TP / YP / Toplam kolonları vardır ve **col-6 cari dönem toplamıdır.**

---

## 5. Ölçek, dönem ve TMS 29

### Ölçek

- Şirketler TL, bin TL ya da milyon TL ile raporlar.
- Hücredeki `title` değeri **ölçeklenmemiş** değerdir (ilk başta yanlışlıkla ham TL sanıldı, düzeltildi). Birimle çarpılarak TL'ye çevrilir.
- 2026/2 örneği: TL ile 187, bin TL ile 44, milyon TL ile 15 dosya.
- Örnek: ADB-ADBNK'de `title` = 39369, birim milyon TL.

### Dönem türleri

- Nakit akış tablosu **her zaman kümülatiftir.**
- Gelir tablosu 2. ve 3. çeyrekte 3 aylık kolonlar da içerir.
- Bazı şirketlerin özel hesap dönemi vardır (ör. MAVI: 1 Şubat – 31 Temmuz).

### TMS 29 (enflasyon muhasebesi)

- 2023 yıl sonundan itibaren uygulanıyor; karşılaştırılabilir geçmiş yaklaşık **11 çeyrek**.
- Her rapor kendi dönem sonu satın alma gücüyle hazırlanır; karşılaştırma kolonları da yeniden ifade edilir. Bu yüzden aynı değerin "ilk raporlanan" ve "yeniden ifade edilmiş" iki hâli vardır → **bitemporal saklama** gerekir.
- **Karşılaştırma önce aynı rapor içinde yapılır.** Farklı raporlardaki TL tutarlarını birleştirmek için TÜFE serisi gerekir:
  `4. çeyrek = 12 aylık − 9 aylık × (TÜFE oranı)`
- Net parasal pozisyon kazancı/kaybı (genel şablonda satır 52) vergi öncesi bir kalemdir ve finansman gideriyle (satır 51) birlikte okunmalıdır. Çeyrekten çeyreğe çok sert oynayabilir (KATMR'de +320 → −260 mn TL).

---

## 6. Finansal metodoloji

### Üç tablo ne ölçer?

| Tablo | Ölçtüğü | Zaman |
|---|---|---|
| Bilanço | Varlıklar, borçlar, özkaynak | Bir an (dönem sonu) |
| Gelir tablosu | Hasılat, giderler, kâr | Bir dönem |
| Nakit akış tablosu | Kârın nakde dönüşümü, yatırım, finansman | Bir dönem (her zaman kümülatif) |

### Doğru karşılaştırmanın dört kuralı

1. **Aynı para:** TMS 29 sonrası aynı rapor içinde karşılaştır; raporlar arasında TÜFE ile düzelt.
2. **Stok–akış eşleşmesi:** Bilanço bir anı, gelir tablosu bir dönemi ölçer. Oranlarda yıllıklaştırma ve ortalama açıkça belirtilir.
3. **Aynı kapsam:** Ana ortaklık kârı ↔ ana ortaklık özkaynağı.
4. **Aynı dönem türü:** Kümülatif ile 3 aylık karıştırılmaz.

### Oranlardan önce dört mutabakat

| Kontrol | Formül |
|---|---|
| Bilanço dengesi | Toplam varlık = toplam kaynak |
| Kâr tutarlılığı | Bilançodaki net kâr = gelir tablosundaki ana ortaklık kârı |
| Nakit (dönem sonu) | Nakit akış tablosu dönem sonu nakdi = bilançodaki nakit |
| Nakit (dönem başı) | Nakit akış tablosu dönem başı nakdi = önceki bilançodaki nakit |

Bunlara ek olarak **her ara toplam kalemlerden yeniden hesaplanır.** Tutmayan kayıt sinyal üretmez.

### Bilançodan alınanlar

| Kalem | Not |
|---|---|
| Nakit ve nakit benzerleri | Net borç ve nakit oranı için |
| Ticari alacaklar | Alacak gün sayısı |
| Stoklar | Stok gün sayısı |
| Peşin ödenmiş giderler (kısa + uzun vade) | İşletme sermayesine dahil olup olmadığı açık karar |
| Dönen varlıklar, toplam varlıklar | Likidite ve ölçek |
| Finansal borçlar | Net borç |
| Ticari borçlar | Borç gün sayısı |
| Müşteri avansları | İşletme sermayesinde kritik olabilir (KATMR örneği) |
| Kısa vadeli yükümlülükler | Cari oran |
| Özkaynak (toplam ve ana ortaklık) | Kapsam kuralı |

### Temel tanımlar

| Ölçüt | Vigil tanımı |
|---|---|
| Net borç | Finansal borçlanmalar − nakit ve nakit benzerleri |
| Cari oran | Dönen varlıklar / kısa vadeli yükümlülükler |
| Likidite oranı | (Dönen varlıklar − stoklar) / kısa vadeli yükümlülükler |
| Nakit oranı | Nakit / kısa vadeli yükümlülükler |
| Alacak / stok / borç gün sayısı | Dönem sonu ve ortalama bakiyeyle, ikisi de gösterilir; yıllıklaştırma yöntemi yazılır |
| FAVÖK (varsayılan: tanım A) | Brüt kâr − faaliyet giderleri + amortisman |
| FAVÖK (tanım B, karşılaştırma için) | Esas faaliyet kârı + amortisman (esas faaliyetlerden diğer gelir/giderleri içerir) |
| Brüt marj | Brüt kâr / hasılat; **3 aylık** ve yıllık bazda |
| İşletme sermayesi değişimi | Bilanço farkından değil, **nakit akış tablosundan** |
| Serbest nakit akışı | Faaliyetlerden nakit akışı − yatırım harcamaları |
| Tahakkuk oranı | (Net kâr − faaliyetlerden nakit akışı) / ortalama toplam varlık |
| Yatırım / amortisman | Yatırım harcaması / amortisman |

### Bilanço farkı neden nakit akışındaki etkiye eşit değildir?

Bir kalemin bilançodaki değişimi ile nakit akış tablosundaki etkisi; değer düşüklüğü, vade farkı gibi **nakit dışı düzeltmeler** yüzünden farklı olabilir. Bu yüzden işletme sermayesi değişimi nakit akış tablosundan alınır ve fark açıklanabilir olmalıdır (KATMR'de kuruşu kuruşuna kapanıyor, bkz. bölüm 7).

### Vigil'in on finansal kuralı

1. Karşılaştırma önce aynı rapor içinde; raporlar arası TL için TÜFE.
2. Marj 3 aylık ve yıllık; kümülatif son çeyreği gizler.
3. Stok–akış eşleşmesinde yıllıklaştırma ve ortalama açıkça yazılır.
4. Kapsam tutarlı: ana ortaklık kârı ↔ ana ortaklık özkaynağı.
5. Net borç tanımı sabit ve açık: borçlanmalar − nakit.
6. FAVÖK tanımı sabit: brüt kâr − faaliyet giderleri + amortisman.
7. İşletme sermayesi değişimi nakit akış tablosundan.
8. Parasal pozisyon çıkarılmaz; finansman gideriyle okunur.
9. Mutabakat ve ara toplamlar oranlardan önce kontrol edilir.
10. Sektör bağlamı olmadan oran yorumlanmaz.

### Bu verilerden hesaplanamayanlar

| Ölçüt | Neden | Ne gerekir |
|---|---|---|
| Net borç / FAVÖK | Son 12 ay FAVÖK gerekir | Önceki yıl sonu raporu + TÜFE |
| 3 aylık FAVÖK | Amortisman yalnızca kümülatif | Önceki çeyrek raporu + TÜFE |
| 3 aylık nakit akışı | Nakit akışı yalnızca kümülatif | Önceki rapor + TÜFE |
| Stok kırılımı (hammadde, yarı mamul, mamul) | Dipnotta | PDF dipnotu |
| Esas faaliyetlerden diğer gelirlerin içeriği (kur farkı, vade farkı vb.) | Dipnotta | PDF dipnotu |
| Döviz pozisyonu | Dipnotta | PDF dipnotu |

---

## 7. Çalışılmış örnek: KATMR 2026/2

Kaynak: KAP bildirimi 1651411. Tutarlar **milyon TL**, Haziran 2026 satın alma gücüyle.

### Mutabakat

Dört mutabakatın dördü de tutuyor: varlık = kaynak; bilanço net kârı = gelir tablosu ana ortaklık kârı; nakit akış tablosu dönem sonu nakdi = bilanço nakdi; dönem başı nakdi = önceki bilanço nakdi.

### Bilanço

| Kalem | 30.06.2026 | 31.12.2025 |
|---|---:|---:|
| Nakit ve nakit benzerleri | 120,8 | 450,9 |
| Ticari alacaklar | 1.681,9 | 2.045,6 |
| Stoklar | 8.989,1 | 9.191,0 |
| Peşin ödenmiş giderler (KV + UV) | 2.297,9 | 2.666,7 |
| Dönen varlıklar | 12.903,6 | 14.263,3 |
| **Toplam varlıklar** | **14.795,4** | **16.069,1** |
| Finansal borçlar | 2.313,8 | 2.460,5 |
| Ticari borçlar | 543,9 | 812,5 |
| Müşteri avansları | 1.076,5 | 2.133,5 |
| Kısa vadeli yükümlülükler | 3.897,1 | 5.174,7 |
| **Özkaynak** (ana ortaklık 10.500,1) | **10.499,9** | **10.181,0** |
| **Net borç** | **2.193,0** | **2.009,6** |

**Gözlem:** Finansal borç %6 azaldı, ama nakit %73 düştüğü için net borç %9 arttı.

### Oranlar

| Oran | 2026 | 2025 |
|---|---:|---:|
| Cari oran | 3,31 | 2,76 |
| Likidite oranı | 1,00 | 0,98 |
| Nakit oranı | 0,03 | 0,09 |
| Net borç / özkaynak | 0,21 | 0,20 |
| Yükümlülük / varlık | 0,29 | 0,37 |

| Gün sayısı | Dönem sonu | Ortalama |
|---|---:|---:|
| Alacak | 197 | 218 |
| Stok | 1.577 | 1.594 |
| Borç | 95 | 119 |

**Gözlem:** Cari oran 3,31 güçlü görünüyor, ama nakit oranı 0,03. 1.577 günlük stok süresi, standart oranların bu şirkette tek başına anlamsız olduğunu gösteriyor; sektör bağlamı gerekli.

### Gelir tablosu

| Kalem | 6A 2026 | 6A 2025 |
|---|---:|---:|
| Hasılat | 1.558,9 | 1.434,0 |
| Brüt kâr | 518,3 | 662,1 |
| Faaliyet giderleri | −287,2 | −270,6 |
| Esas faaliyetlerden diğer (net) | 218,7 | 246,8 |
| **Esas faaliyet kârı** | **449,8** | **638,3** |
| Yatırım ve değer düşüklüğü (net, düzeltilmiş) | −11,3 | 84,8 |
| Finansman (net) | −188,9 | −168,3 |
| Net parasal pozisyon | 60,0 | 145,5 |
| **Vergi öncesi kâr** | **309,6** | **700,3** |
| Vergi | 9,0 | −127,7 |
| **Dönem kârı** (ana ortaklık 318,9) | **318,7** | **572,5** |

*"Yatırım ve değer düşüklüğü" satırı ayrıştırıcı hatasından etkilenen satırdır; burada ham dosyadan düzeltilmiş değeri gösteriliyor (bkz. bölüm 17).*

**Olağan dışı işaret:** 2025 2. çeyrek 3 aylık finansman gideri +13,5 (gider kaleminde pozitif). Dört hücre de dolu olduğu için bu ayrıştırıcı hatası değil, raporun kendisinden geliyor.

### FAVÖK: iki tanım

| | Hesap | Tutar | Marj |
|---|---|---:|---:|
| Tanım A | Brüt kâr − faaliyet giderleri + amortisman | 277,0 | %17,8 |
| Tanım B | Esas faaliyet kârı + amortisman | 495,8 | %31,8 |

Tanım B, tanım A'dan **%79** yüksek (2025'te %55). Fark, "esas faaliyetlerden diğer gelirler"den geliyor ve içeriği dipnotta.

### Marj: kümülatif son çeyreği gizler

| Brüt marj | 2026 | 2025 |
|---|---:|---:|
| 6 aylık (kümülatif) | %33,2 | %46,2 |
| 1. çeyrek (türetilmiş) | %48,4 | %44,9 |
| 2. çeyrek (3 aylık) | **%21,5** | %47,5 |

- 2. çeyrekte marj **26,0 puan** (−2.596 baz puan) düşmüş; 1. çeyrek ise geçen yıldan iyi.
- Marj etkisi ≈ **228,3 mn TL**.
- Bu etkinin "önemi" paydaya göre değişiyor:

| Payda | Marj etkisi / payda |
|---|---:|
| Toplam varlık | %1,5 |
| Özkaynak | %2,2 |
| Önceki yıl 2. çeyrek esas faaliyet kârı (\|278,9\|) | %81,9 |

Payda seçimi sonucu **50 kattan fazla** değiştiriyor. Bu yüzden payda bir analist kararı.

### Parasal pozisyon ve vergi öncesi kâr (çeyrek bazında)

| | 2026 1. çeyrek (türetilmiş) | 2026 2. çeyrek |
|---|---:|---:|
| Net parasal pozisyon | +320,2 | −260,2 |
| Vergi öncesi kâr | +542,6 | −233,0 |

### Nakit akışı: kârdan nakde köprü (6A 2026)

```
Dönem kârı                         318,9
+ Nakit dışı düzeltmeler            79,3
+ İşletme sermayesi değişimi      −453,4
= Faaliyetlerden üretilen nakit    −55,3
+ Diğer                             14,4
= Faaliyetlerden nakit akışı       −40,9
```

| İşletme sermayesi bileşeni | Etki |
|---|---:|
| Müşteri avansları | −1.057,0 |
| Peşin ödenmiş giderler | +368,8 |
| Ticari alacaklar | +289,5 |
| Stoklar | +201,9 |
| Ticari borçlar | −241,3 |
| Diğer | −15,4 |

**Gözlem:** Faaliyet nakit akışını en çok etkileyen kalem, müşteri avanslarındaki 1.057 mn TL'lik azalış.

### Nakit kalitesi

| Ölçüt | 2026 | 2025 |
|---|---:|---:|
| Faaliyetlerden nakit akışı | −40,9 | −957,0 |
| Serbest nakit akışı | −110,1 | −991,1 |
| Faaliyet nakit akışı / FAVÖK A | −%14,8 | −%211,4 |
| Yatırım harcaması / amortisman | 1,51 | 0,56 |
| Tahakkuk oranı (ortalama toplam varlığa göre) | %2,33 | — |

### Bilanço farkı ↔ nakit akışı mutabakatı

| Kalem | Sonuç |
|---|---|
| Stoklar, müşteri avansları, peşin ödenmiş giderler | Birebir tutuyor |
| Ticari alacaklar | 74,3 fark = değer düşüklüğü 61,8 + vade farkı 12,5 |
| Ticari borçlar | 27,4 fark = vade farkı düzeltmesi |

---

## 8. Diğer doğrulanmış örnekler

| Şirket | Bulgu |
|---|---|
| **MOGAN** | 2. çeyrek brüt marj −%86,2. Hasılat yıllık −%47,9, satışların maliyeti −%10,7. 6 aylık amortisman 5,85 mlr TL |
| **ADB-ADBNK** | `title` = 39369, birim milyon TL (ölçek örneği) |
| **BIOEN, BSOKE, AYEN** | Bilançoda yeniden düzenleme kolonu (col-6) dolu satır sayısı: BIOEN 71, BSOKE 65, AYEN 0 (S3 örneği) |
| **CLEBI, GRTHO, HURGZ, KORDS, TAVHL, GARAN** | Gerçekten durdurulan faaliyeti olan şirketler (58. satır kontrolü için) |

---

## 9. Sinyaller

İlk sürüm (v1) yalnızca **genel şablon** için çalışır. Banka, holding ve sigortanın kendi metodolojisi gerekir (örneğin bankada brüt marj kavramı yoktur).

| Sinyal | Ne ölçer | Nasıl |
|---|---|---|
| **S1 – Marj kırılması** | Ticari brüt marjda ani değişim | Brüt kâr / hasılat (genel şablonda satır 5 / satır 3), 3 aylık, geçen yılın aynı çeyreğine göre |
| **S2 – Kâr–nakit ayrışması** | Kârın nakde dönüşmemesi | Kâr ve nakit bileşenleri yan yana; tahakkuk oranı (ortalama toplam varlığa göre) |
| **S3 – Yeniden düzenleme** | Önceki dönem rakamlarının değiştirilmesi | Bilançoda yeniden düzenleme kolonunun (col-6) dolu olması |

### Tetikleme

İki koşulun **birlikte** sağlanması gerekir:

```
|Δmarj| ≥ X
(|Δmarj| × hasılat) / payda ≥ Z
```

- İkinci koşul, marj değişiminin TL etkisini ölçer. (İlk tasarımdaki payda formülü kendini tekrar eden, totolojik bir formüldü; bu yüzden marj etkisine dayalı koşulla değiştirildi.)
- **Sıralama tetiklemeden ayrıdır.**
- **Kota yoktur.** Bir çeyrekte hiç sinyal çıkmayabilir. (Gemini'nin önerdiği "her çeyrek N sinyal" yaklaşımı bu yüzden reddedildi.)
- X, Z ve payda analist kararıdır. Eşikler koda gömülmez, yapılandırma dosyasından okunur.

### Sinyal çıktısı

Her sinyal şunları içerir:

- Şirket, dönem, sinyal türü
- Kullanılan rakamlar ve hesap adımları
- Her rakamın kaynağı (dosya, tablo, satır, kolon)
- Mutabakat durumu
- Hesaplanamayan ölçütler ve nedenleri

---

## 10. Doğrulama

| Ölçüt | Hedef |
|---|---|
| İsabet (precision) | 50 sinyallik örneklemde ≥ %70 (n=50'de ±13 puan belirsizlik) |
| Yakalama (recall) | Önceden seçilmiş 20 bilinen olay |
| Etiketçi uyumu | İki bağımsız etiketçi; uyum oranı raporlanır |

**Kurallar**

- Etiketçiler eşikleri belirleyen kişilerden olmaz.
- Eşikler ayarlandıysa sonraki ölçüm **yeni bir örneklemle** yapılır; aynı örnekleme göre ayar yapmak sonucu şişirir.
- Etiketler ve örneklem depoda yayımlanır.
- İsabet %70'in altındaysa Faz 2'ye dönülür.

---

## 11. Mimari

```
KAP ─► Veri hattı ─► Ayrıştırıcı ─► Veritabanı ─► Hesap ve sinyal motoru ─► API ─► Arayüz
                                                            │
                                                  LLM açıklama katmanı
```

| Katman | Önerilen teknoloji | Görev |
|---|---|---|
| Veri hattı | Python, GitHub Actions | İndirme, zip kurtarma, ham arşiv, TÜFE serisi, zamanlanmış indirme |
| Ayrıştırıcı | Python | Beş şablon → ortak veri modeli; ölçek, dönem türü, özel hesap dönemleri |
| Veritabanı | Başlangıçta DuckDB, sonra PostgreSQL | Bitemporal şema: ilk raporlanan ve yeniden ifade edilmiş değerler |
| Hesap ve sinyal motoru | Python, pandas | Oranlar, net borç, FAVÖK, gün sayıları, 3 aylık türetme, S1–S3 |
| API | FastAPI | Şirket, dönem, sinyal ve hesap adımı uç noktaları; her sayının kaynağı |
| Arayüz | Next.js / React, Recharts veya ECharts | Sinyal listesi, şirket sayfası, sinyal kartı, "hesaplanamadı" durumları |
| LLM | Claude (Haiku 5.5 toplu işler, Sonnet 5.5 zor vakalar) | Açıklama, şablon eşleme önerisi, dipnot çıkarma |

---

## 12. LLM ve makine öğrenmesi

Vigil'de klasik makine öğrenmesine çok az yer var:

- Etiketli veri yok denecek kadar az (doğrulamada ~50 etiket).
- TMS 29 nedeniyle karşılaştırılabilir geçmiş ~11 çeyrek; zaman serisi modelleri için çok kısa.
- Sinyallerin hesabı tek tek gösterilebilmeli; bu yüzden bilerek kural tabanlı tasarlandı.

Asıl yapay zekâ işi **LLM** tarafında. Bu yüzden ekipteki rolün adı "ML" değil, **"LLM / yapay zekâ mühendisi"**.

### Yapılacaklar (kullanışlılık sırasıyla)

| # | İş | Tür | Faz | Güvenlik ağı / ölçüm |
|---|---|---|---|---|
| 1 | **Şablon satır eşleme asistanı:** satır etiketlerini embedding ile ortak kalem listesine eşleyip güven skoruyla önermek | Embedding, benzerlik araması | 0–1 | Her eşleme insan onayından geçer; elle çıkarılan haritanın bir kısmı test seti olur |
| 2 | **Sinyal açıklaması:** sade Türkçe metin | LLM | 4 | Model sayı üretmez; metindeki her sayı kaynakla otomatik karşılaştırılır; "al/sat/hedef fiyat" dili filtrelenir; 50–100 sinyallik değerlendirme seti |
| 3 | **PDF dipnotlarından veri çıkarma:** stok kırılımı, döviz pozisyonu, diğer gelirlerin içeriği | LLM, belge işleme | 5 | Çıkarılan toplam, tablodaki ilgili kalemle tutmalı |
| 4 | Benzer şirket kümeleme (sektör kıyası için) | Klasik ML, deneysel | 5 | Kümeler finans uzmanının onayından geçer |
| 5 | Anomali tespiti (ör. Isolation Forest) | Klasik ML, deneysel | 5 | Tek başına sinyal olarak yayımlanmaz; yalnızca analiste "kurallar kaçırmış olabilir" listesi |
| 6 | Sıralama modeli | Klasik ML | Çok sonra | En az birkaç yüz etiket birikmeden denenmez |

1. madde en önemlisi: projenin kritik yolundaki en yorucu işe (şablon eşleme) doğrudan yardım ediyor.

### Yapılmayacaklar

- **Fiyat ya da getiri tahmini:** Veri yetersiz ve Vigil'i yatırım tavsiyesi alanına sokar.
- **Gelecek çeyrek kâr/hasılat tahmini:** TMS 29 kırılması ve kısa geçmiş nedeniyle güvenilmez.
- **"Hile tahmini" modeli:** Türkiye'de doğrulanmış vaka sayısı model eğitmek için çok az. Beneish M-skoru gibi bilinen göstergeler ML değil, formül olarak hesap motoruna eklenebilir.

Ekipte ML deneyimi isteyen biri varsa: Vigil bir **veri mühendisliği ve LLM projesi**dir. 4. ve 5. maddeler ayrı bir deneysel çalışma olarak üstlenilebilir, ama ana ürünün parçası olmaz.

---

## 13. Ekip ve roller

Proje açık kaynak; işe alım yok. Ekip şu an 7 kişi, farklı üniversitelerden, okul öncelikli. Kişiler numarayla yazıldı; uygun profile göre eşleştirilecek.

### 7 kişilik dağılım

| Kişi | Ana rol | Ek sorumluluk | Uygun profil |
|---|---|---|---|
| **1** | Finans uzmanı, metodoloji sahibi | Proje lideri | İşletme, iktisat, muhasebe; projeyi en çok sahiplenen |
| **2** | Veri mühendisi | DevOps (CI, zamanlanmış indirme, yedek) | Python, SQL, otomasyon |
| **3** | Backend: ayrıştırıcı | Veritabanı şeması (2 ile birlikte) | Python; titiz |
| **4** | Backend: hesap ve sinyal motoru, API | Teknik lider, kod incelemesi koordinasyonu | Python, pandas, FastAPI; finansa meraklı |
| **5** | QA ve veri kalitesi | Şablon eşlemede finans uzmanına destek | Finansal tabloları rahat okuyan; kod şart değil |
| **6** | Frontend | UI/UX | React / Next.js |
| **7** | LLM / yapay zekâ | Veri hattında 2'ye destek (Faz 0–1); isteğe bağlı ML deneyleri (Faz 5) | Python, LLM API'leri |

### Rol ayrıntıları

**Finans uzmanı (1)**
- Altı açık kararı verip gerekçesini yazar.
- Beş şablonun satır anlam haritasını çıkarır (5 ile).
- Sinyal tanımlarını finansal olarak savunur; backend hesaplarını gözden geçirir.
- "Hesaplanamaz" listesini yönetir.
- Faz 0–2'de en yoğun rol. Mümkünse ayda bir saat ayıracak deneyimli bir danışman (öğretim üyesi ya da sektörden bir analist) bulunmalı.

**Veri mühendisi (2)**
- KAP indirme, yarım zip kurtarma, yeniden deneme.
- Ham dosyaları değiştirmeden ve indirme zamanıyla saklama.
- TÜFE serisi (7 ile), bitemporal şema (3 ile).
- Yeni çeyrek yayımlandığında otomatik indirme.

**Ayrıştırıcı (3)**
- Kolon kayması hatasını düzeltmek (ilk iş).
- Beş şablon → ortak veri modeli; ölçek, dönem türü, özel hesap dönemleri.
- Kümülatiften 3 aylık türetme.

**Hesap, sinyal ve API (4)**
- Oranlar, net borç, FAVÖK, gün sayıları.
- S1–S3, iki koşullu tetikleme, sıralama, duyarlılık raporu.
- Eşikler yapılandırma dosyasında.
- API: her sayının kaynağını döndürür.

**QA ve veri kalitesi (5)**
- **Altın veri seti:** 5–10 şirketin raporlarını elle çıkarıp ayrıştırıcı çıktısıyla karşılaştırmak.
- Ara toplam ve mutabakat testlerinin sonuçlarını izlemek.
- CI'da testlerden biri kırılırsa birleştirmeyi engellemek.

**Frontend (6)**
- Sinyal listesi; şirket sayfası (3 aylık / kümülatif geçişi); sinyal kartı (rakam, hesap adımları, kaynak).
- "Hesaplanamadı" durumları boş ya da sıfır gibi görünmez, nedenini yazar.
- Her sayfada yatırım tavsiyesi uyarısı.
- API hazır olmadan mock veriyle başlar.

**LLM / yapay zekâ (7)**
- Bkz. bölüm 12.

**Danışmanlar (ekip dışı, isteğe bağlı)**
- Deneyimli finans analisti: metodoloji kararlarının gözden geçirilmesi.
- Hukuk: SPK yatırım danışmanlığı sınırı, KAP kullanım koşulları, uyarı metinleri. Bir hukuk öğrencisi yeterli.

### Bağımsızlık kuralları

1. Ayrıştırıcıyı yazan (3), altın veri setini hazırlamaz; onu 5 hazırlar. Kolon kayması hatası bu ayrım olmadığı için gözden kaçtı.
2. Etiketçiler (6 ve 7), eşikleri belirleyenler (1 ve 4) değildir.
3. Kod incelemesi çaprazdır:

| Değişen kısım | İnceleyen |
|---|---|
| Ayrıştırıcı (3) | 2 |
| Veri hattı (2) | 3 |
| Sinyal motoru (4) | Kod: 3 · Finansal doğruluk: 1 |
| Frontend (6) | 4 (API uyumu) |
| LLM katmanı (7) | 4 · Metinler: 1 |

### Yedekler

| Rol | Yedeği |
|---|---|
| 1 | 5 |
| 2 | 7 |
| 3 | 4 |
| 4 | 3 |
| 6 | Yok; Faz 4'e kadar kritik değil |

### Dikkat

- **Kişi 1'in yükü Faz 0–2'de en ağır.** Şablon eşlemenin bir kısmı 5'e devredildi. Yine ağır gelirse proje liderliği 4'e geçebilir.
- **Kritik yol 3 → 5 → 4.** Haftalık toplantıda ilk bakılacak yer.
- **Sonradan katılanlar için en uygun işler:** frontend (mock veriyle), altın veri seti, etiketleme, LLM açıklama katmanı.

---

## 14. Yol haritası

Süreler gönüllü ve okul temposuna göredir; Ocak'taki final haftalarında iş durabilir. Her fazın bitiş ölçütü, kimsenin orada olmasına gerek kalmadan kontrol edilebilecek şekilde yazılmıştır.

| Faz | Süre | İçerik | Bitiş ölçütü |
|---|---|---|---|
| **−1 Altyapı** | 1–2 hafta | Lisans, README uyarısı, CONTRIBUTING, CI iskeleti, etiketler, karar kaydı klasörü | Depo katkıya hazır |
| **0 Veri doğruluğu** | 2–3 hafta | Ayrıştırıcı düzeltmesi; ara toplam ve mutabakat testleri; altın veri seti; şablon satır haritası | Altın veri setinde %100 eşleşme; her dosya ya bütün kontrollerden geçiyor ya da hangisinden kaldığı kayıtlı |
| **1 Arşiv** | 3–4 hafta | 2023 yıl sonundan bugüne bütün çeyrekler; bitemporal saklama; TÜFE; 3 aylık türetme; özel hesap dönemleri | Her şirket ve çeyrek için mutabakat oranı raporlanmış; eksik/bozuk dosyalar listelenmiş |
| **2 Kararlar ve sinyal v1** | 3–4 hafta | Altı kararın verilmesi; genel şablon için S1, S2, S3; duyarlılık raporu | Karar kayıtları tamam; geçmişte sinyal listesi üretilmiş |
| **3 Doğrulama** | 2–3 hafta | 50 sinyallik isabet; 20 olaylık yakalama; etiketçi uyumu | İsabet ≥ %70 (değilse Faz 2'ye dönülür) |
| **4 Çıktı** | 3–4 hafta | API; arayüz; LLM açıklama ve sayı kontrolü; uyarı metinleri; yayın | Dış bir analist her sinyalin hesabını kaynağa bakarak yeniden yapabiliyor |
| **5 Genişleme** | Sürekli | Banka, holding, sigorta; PDF dipnotları; son 12 ay ölçütleri; sektör kıyası | — |

**Ara hedef:** 2026/3 dönemi raporları KAP'ta yayımlandığında yeni çeyreğin indirilip hatasız işlenmesi ilk canlı testtir.

### Fazlara göre kişi görevleri

| Faz | 1 Finans | 2 Veri | 3 Ayrıştırıcı | 4 Sinyal/API | 5 QA | 6 Frontend | 7 LLM |
|---|---|---|---|---|---|---|---|
| −1 | README uyarısı, karar kaydı klasörü | CI iskeleti, repo düzeni | Kod yapısını toparlama | CONTRIBUTING, inceleme kuralları | Test planı | Wireframe | Lisans ve KAP kullanım koşulları araştırması |
| 0 | Şablon satır haritası | İndirme, zip kurtarma | **Kolon kayması düzeltmesi**, ölçek, dönem türü | Ara toplam ve mutabakat test kodu | **Altın veri seti** | Altın veri setine destek | **Şablon eşleme asistanı**, TÜFE serisi |
| 1 | Altı kararı Discussions'ta açma | Arşiv, bitemporal saklama | 3 aylık türetme, özel dönemler | Veri modeli, API iskeleti | Arşiv mutabakat raporu | Mock veriyle şirket sayfası | Dipnot PDF yapısını inceleme |
| 2 | **Altı kararı verme** | Otomatik çeyrek indirme | Diğer şablonlara hazırlık | **S1, S2, S3**, eşikler, duyarlılık | Sinyallerin elle kontrolü | Sinyal listesi ve kartı (mock) | Açıklama prompt'u, değerlendirme seti |
| 3 | Örneklem ve olay seçimi | Yayın hazırlığı | Hata düzeltmeleri | Eşik ayarı | Sonuç raporu | **Etiketçi A** | **Etiketçi B** |
| 4 | Uyarı ve metin onayı | Yayın (sunucu, Vercel) | API desteği | API'nin tamamlanması | Uçtan uca test | **Arayüz–API bağlantısı** | **LLM açıklama, sayı kontrolü** |
| 5 | Yeni şablon metodolojisi | Yeni veri kaynakları | Banka/holding/sigorta ayrıştırma | Yeni şablon sinyalleri | Yeni şablonlar için altın veri | Sektör kıyası ekranı | Dipnot çıkarma; isteğe bağlı ML deneyleri |

### Rollerin fazlara göre yükü

| Faz | Veri | Backend | Frontend | LLM | Finans | QA | DevOps |
|---|---|---|---|---|---|---|---|
| 0 | ●●● | ●● | — | ● | ●● | ●●● | ● |
| 1 | ●●● | ● | — | ● | ● | ●● | ● |
| 2 | ● | ●●● | ● (mock) | ● | ●●● | ● | — |
| 3 | — | ● | ● | ● | ●● | ●● | — |
| 4 | — | ●● | ●●● | ●●● | ● | ● | ●● |
| 5 | ●● | ●● | ● | ●● | ●●● | ● | — |

### Bağımlılıklar

```
Ayrıştırıcı düzeltmesi ─► Altın veri seti ─► Arşiv ─► Sinyal v1 ─► Doğrulama ─► Çıktı
                                                    ▲
Analist kararları ──────────────────────────────────┘
```

Analist kararları Faz 0'da başlamalı; sinyal işini bekleten en uzun iş budur.

### Riskler

| Risk | Önlem |
|---|---|
| Finans bilgisi eksik kalır | Proje Faz 1'den öteye geçemez; finans katkıcısı bulmak ilk öncelik (bkz. bölüm 15) |
| KAP servisi değişir veya kısıtlanır | Ham dosyalar yerel arşivde saklanır |
| Sınav dönemleri | Her fazın bitiş ölçütü var; yarım iş kayıt altında kalır |
| Tek kişiye bağımlılık | Yedek kişi ve karar kayıtları |
| "Yatırım tavsiyesi" algısı | Uyarı metinleri Faz 4'ten önce hukuk açısından gözden geçirilir |

---

## 15. Açık kaynak çalışma düzeni

### Ekip yapısı

- **Çekirdek ekip (maintainer):** Depoya yazma yetkisi olanlar. PR inceler, kararları kayda geçirir. Üç alanın (metodoloji, veri/ayrıştırıcı, sinyal) her birinin bir sahibi olur.
- **Katkıcılar:** Herkes. Bir issue alır, PR açar, bırakıp gidebilir. Proje buna göre kurulur: işler küçük parçalara bölünür, bitiş ölçütleri CI'da kontrol edilir.

### Altyapı

- **Lisans:** Kod için MIT veya Apache-2.0 (öneri: Apache-2.0, patent maddesi nedeniyle). KAP ham dosyaları depoya konmaz; indirme betiği verilir. Altın veri setindeki elle çıkarılmış küçük örnekler depoda kalabilir.
- **Uyarı:** README'nin en üstünde ve her çıktıda yatırım tavsiyesi uyarısı. Açık kaynak olmak SPK yatırım danışmanlığı sınırını ortadan kaldırmaz.
- **CONTRIBUTING.md:** Kurulum, veri indirme, "yaklaşık değer üretilmez" kuralı, on finansal kural, sahipsiz iş kuralı.
- **Metodoloji tartışmaları:** GitHub Discussions. **Uygulama işleri:** Issues.
- **Karar kayıtları (ADR):** `docs/kararlar/` altında her karar ayrı dosya: ne seçildi, alternatifler, gerekçe, ilgili tartışma. Altı açık karar ilk altı kayıt olur.
- **Etiketler:** `good first issue`, `finans-bilgisi` (kod gerekmez), `veri`, `sinyal`, `metodoloji-karari`, `yardım-aranıyor`.
- **CODEOWNERS:** Ayrıştırıcıya dokunan PR'ı veri sahibi, sinyale dokunanı metodoloji sahibi onaylar.
- **CI kapısı:** Ara toplam, mutabakat ve altın veri seti testlerinden biri kırılırsa birleştirme yapılmaz.
- **Yapay zekâ ile yazılan kod** kabul edilir; ancak testleri kodu yazan kişi ya da araç yazmaz.
- **Sahipsiz işler:** İki hafta sessiz kalan issue nazikçe tekrar boşa çıkarılır.
- **Belirsiz issue açılmaz:** Yalnızca sahibi olan ve kapsamı net yazılmış işler issue olur.
- **Doğrulama sonuçları açık:** Etiketler ve örneklem depoda yayımlanır.

### Kod bilmeden katkı

- Altın veri setine şirket eklemek (bir raporu elle çıkarmak)
- Şablon satır anlamlarını eşlemek
- Metodoloji tartışmalarına görüş yazmak
- Sinyal etiketlemek

### Finans bilen katkıcı bulmak

Kod bilen gönüllü bulmak, finans bilen gönüllü bulmaktan kolaydır:

- Üniversitelerin finans, ekonomi ve yatırım kulüplerine **somut bir soruyla** gidilir ("Projeye katıl" değil, "Şu tartışmada FAVÖK tanımı hakkında görüşün ne?").
- İktisat, işletme ve muhasebe hocalarına bitirme projesi ya da dönem ödevi olarak önerilir. Altı karar ve şablon eşleme ödev olmaya çok uygun.
- Finans katkısının kod gerektirmediği açıkça yazılır.

---

## 16. Mevcut kod durumu

Prototip kod Gemini tarafından yazıldı ve #1 ile repoya taşındı. İşler [issue listesinde](https://github.com/octacity-org/vigil/issues) fazlara göre takip ediliyor.

| Dosya | İçerik | Durum |
|---|---|---|
| `data/raw/2026_2/*.xls` | Kurtarılan 246 dosya | Depoda değil; herkes yerelde indirir (bkz. bölüm 15) |
| `docs/DATA_CONTRACT.md` | Veri sözleşmesi taslağı: UTF-8, kurallar, KATMR örneği, Faz 0/1 ölçütleri | Güncel |
| `README.md` | Proje tanımı | Bu dosyayla değiştirilebilir |
| `src/vigil/downloader.py` | KAP indirme ve zip kurtarma | Çalışıyor |
| `src/vigil/parser.py` | HTML → tablo | **Kolon kayması hatası var** (bölüm 17) |
| `src/vigil/signals.py` | Sinyal hesapları | Elle yazılmış şirket listesi var (bölüm 17) |
| `tests/test_parser_and_signals.py` | 7 test | Döngüsel (bölüm 17) |
| `SIGNAL_REPORT_2026_2.md` | Örnek sinyal raporu | Silindi (doğrulanmamış rakamlar içeriyordu) |

---

## 17. Bilinen sorunlar

### Ayrıştırıcı kolon kayması (düzeltildi, #14)

**Durum:** #14 ile düzeltildi. Her hücre artık kendi kapanış etiketine kadar okunuyor; 2026/2'nin 246 dosyasında yanlış kolonda değer kalmadı. KATMR 42. satır altın veri testinde, boş hücreden sonra dolu hücre gelen durum da sentetik bir testte (`tests/test_parser_cells.py`) kontrol ediliyor. Aşağısı hatanın kaydı olarak duruyor.

Eski `src/vigil/parser.py` içindeki `VALUE_CELL_RE` hücre sınırını aşıyordu:

```python
VALUE_CELL_RE = re.compile(
    r'<td\s+class="taxonomy-context-value\s+(col-order-class-\d+)[^"]*"[^>]*>.*?'
    r'title="([-+]?\d+(?:[.,]\d+)?)"', re.S)
```

Tembel `.*?` boş bir hücrenin `</td>` etiketinde durmuyor; sonraki hücrenin `title` değerini alıp boş hücrenin kolonuna yazıyor (bir kolon sola kayma).

- **Etki:** 118.624 değerin 1.045'i (%0,88) yanlış kolonda; 246 dosyanın 103'ü etkileniyor.
- **Örnek:** KATMR `general_role_310003-row-42` (−36.464.628) ham HTML'de 2025 kolonlarında (col-5, col-7); ayrıştırıcı 2026 kolonlarına (col-4, col-6) yazıyor. Gelir tablosu ara toplamı bu yüzden 36,5 mn TL tutmuyor. Nakit akış tablosunda 117, 131 ve 136. satırlar da aynı şekilde kaymış.
- **Düzeltme:** Önce her hücreyi kendi kapanış etiketine kadar ayır, `title`'ı yalnızca o hücrenin içinde ara:

  ```
  <td\s+class="taxonomy-context-value\s+(col-order-class-\d+)[^"]*"[^>]*>(.*?)</td>
  ```

- **Ek test:** Her tablo için ara toplamları kalemlerden yeniden hesaplayan bir test. Bu hata ancak böyle yakalanabiliyor.
- **Neden yakalanmadı:** "246/246 dosya, 0 hata" sonucu dosyaların **okunabildiğini** ölçüyordu, değerlerin doğru kolona yazıldığını değil. Testler ayrıştırıcının kendi çıktısına dayanıyordu.

### Diğer

- **Döngüsel testler:** `tests/test_parser_and_signals.py` içindeki beklenen değerler ayrıştırıcının kendi çıktısından alınmış. Altın veri setiyle değiştirilmeli.
- **Elle yazılmış şirket listesi:** `src/vigil/signals.py` içinde `KNOWN_NON_REAL_SECTOR_TICKERS` (34 şirket). Gerçek sektör dışı şirketler şablon türünden otomatik belirlenmeli.
- **Bildirim listesi servisi:** `POST disclosure/list/main` doğrudan istekte HTTP 400 dönüyor.
- **Teknik sunumda eski ifade:** *Vigil — Teknik ve Finansal Tasarım* sunumunda hâlâ "0 hata" ifadesi geçiyor; düzeltilmeli.

---

## 18. Çapraz kontrolden çıkan dersler

Tasarım Claude ve Gemini arasında çapraz kontrol edildi. Yakalanan hatalar:

| Hata | Kimde | Ders |
|---|---|---|
| Dosyaların cp1254 sanılması (UTF-8'di) | Claude | Kodlama varsayılmaz, kontrol edilir |
| `title`'ın ham değer sanılması (ölçeklenmemişti) | Claude | Birim her dosyada okunur |
| Totolojik payda formülü | Claude (Gemini yakaladı) | Formüller bir örnekle elle sınanır |
| Ara toplam farkının şirkete atfedilmesi (ayrıştırıcı hatasıydı) | Claude | Önce ham dosyaya bakılır |
| 58. satırın bütün şablonlarda aynı sanılması | Gemini | Satır anlamı şablona göre değişir |
| "Aslında zararda" hesabında vergi öncesi ile vergi sonrası rakamların karıştırılması | Gemini | Aynı kâr basamağı karşılaştırılır |
| Kota tabanlı tetikleme (her çeyrek N sinyal) | Gemini | Önemli olan yoksa sinyal de yoktur |
| Döngüsel testler | Gemini | Beklenen değer bağımsız kaynaktan gelir |
| Doğrulanmamış MOGAN iddiası ("FAVÖK +%60") | Gemini | Her rakam kaynağından hesaplanır |
| Elle yazılmış şirket listesi | Gemini | Sınıflandırma veriden türetilir |
| Uydurma örnek sinyal rakamları | Gemini | Örnekler de gerçek veriden gelir |
| Güncel Claude modellerinin var olmadığı iddiası | Gemini | Model bilgisi güncel kaynaktan doğrulanır |
| Ayrıştırıcı kolon kayması | Her ikisi de "0 hata" dedi | Okunabilirlik ≠ doğruluk |

---

## 19. Açık kararlar

Finans uzmanı tarafından verilecek ve `docs/kararlar/` altında kaydedilecek:

1. **FAVÖK:** Tanım A (çekirdek faaliyet) varsayılan olsun mu?
2. **Net borç:** Kiralama yükümlülükleri ve finansal yatırımlar dahil mi?
3. **İşletme sermayesi:** Müşteri avansları ve peşin ödenmiş giderler dahil mi?
4. **Yıllıklaştırma:** 6 aylık × 2 mi, son 12 ay (TÜFE ile) mi?
5. **Önem eşiği:** Payda ne olacak; X ve Z değerleri?
6. **Sektör kıyası:** Oranlar hangi gruba göre kıyaslanacak? (KATMR'nin 1.577 günlük stok süresi gibi)

Bu seçimler neyin "önemli" sayılacağını belirler. KATMR örneğinde tek bir tanım seçimi sonucu %79, tek bir payda seçimi 50 kattan fazla değiştiriyor.

---

## 20. Sunumlar ve kaynaklar

Sunumlar şu an özel; ekiple paylaşmak için her birinin Share menüsünden erişim açılmalı.

| Sunum | İçerik | Link |
|---|---|---|
| Vigil — Ekip sunumu | Projenin tanıtımı, veri sözleşmesi, haftalık plan | <https://claude.ai/artifact/LV4m7ieBjYcAxKoEirvThy> |
| Vigil — Teknik ve Finansal Tasarım (29 slayt) | Dosya yapısı, satır kimlikleri, şemalar, sinyal tasarımı | <https://claude.ai/artifact/VTQUXyRvvoVnod6w66M5u7> |
| Vigil — Finansal Analiz Metodolojisi (24 slayt) | Bölüm 6–7'nin KATMR üzerinden slayt slayt anlatımı | <https://claude.ai/artifact/26hmHnvxRvYSEqZd46Luis> |

**Metodoloji sunumunun akışı:** kapak → üç tablo → dört kural → TMS 29 → kapsam → mutabakat → bilanço → net borç → oranlar → işletme sermayesi → gelir tablosu → FAVÖK → marj dönemi → parasal pozisyon → nakit köprüsü → bilanço/nakit farkları → nakit kalitesi → sinyal 1 → sinyal 2 → hesaplanamayanlar → veri tutarlılığı → on kural → açık kararlar → ek.

**Diğer kaynaklar**

- KAP: <https://www.kap.org.tr>
- `docs/DATA_CONTRACT.md` — veri sözleşmesi taslağı
- Octacity GitHub topluluğu — Discussion #11 (projenin ilk fikri)
