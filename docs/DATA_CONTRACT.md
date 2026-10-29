# Vigil — Veri Sözleşmesi ve Mimari Spesifikasyon (Tasarım Taslağı)

> **Durum:** Tasarım Taslağı (Faz 0 Ön İnceleme). 246 şirketlik kurtarılan örneklem üzerinde yapısal şablon analizi yapılmıştır; **ancak KAP web/PDF arayüzüyle bağımsız elle doğrulama, 776 şirketin tam ZIP testi ve 8 çeyreklik geçmiş veride eşik kalibrasyonu henüz tamamlanmamıştır.**
> **Amaç:** Kod tabanı, ayrıştırıcılar (parsers), sinyal motoru ve sunum/dokümantasyon için ortak referans belgesi.

---

## 1. Temel İlkeler (Değişmez Kurallar)

1. **Sıfır LLM Hesaplaması:** LLM hiçbir sayıyı toplamaz, bölmez, oranlamaz veya tablodan çıkarmaz. Tüm metrikler ve sinyaller deterministik motordan gelir.
2. **Nedensellik Uydurmama (No Causal Hallucination — Ne LLM'de Ne Kural Motorunda):** Ne LLM ne de deterministik motor *"marj TMS 29 amortismanı yüzünden düştü"* veya *"stok maliyeti arttığı için düştü"* gibi nedensel hikâyeler üretebilir. Motor sadece **matematiksel ayrıştırmayı (pay ve paydanın kendi YoY değişim oranlarını ve ilgili tablo satırlarını)** yan yana koyar.
3. **Tam İzlenebilirlik (Kanıt Zinciri):** Her sinyal; KAP bildirim numarasına (`disclosure_id`), **şablon rol kodu + satır kimliği ikilisine (`{family}_role_{code}-row-{n}`)**, dipnot referansına (`footnote_ref`), ham değere (`raw_value`) ve ölçek çarpanına (`scale_multiplier`) kadar izlenebilir. **Tek başına satır numarası (`row-58` vb.) şablonlar arası farklı kalemlere denk geldiği için asla tek başına kullanılmaz.**
4. **Nötr ve Olgusal Dil (SPK Uyumu):** Sinyal başlıklarında ve anlatımda *"Uyarı / Tehlike / Kötüleşme / Aslında Zararda"* gibi yönlendirici ifadeler kullanılmaz; *"Eşik Aşımı / YoY Sapma / Gözlem"* gibi nötr ve istatistiksel terimler kullanılır.
5. **Tetikleme (Eşik) ile Sıralama (Yüzdelik) Ayrımı:**
   * **Tetikleme (Sessizlik Kapısı):** Kota bazlı ("her çeyrek en uç %5") tetikleme **yapılmaz**; aksi halde sakin dönemlerde de sistem gürültü üretir ve *"eşiği aşan değişiklik yoksa sistem susar"* ilkesi bozulur. Tetikleme yalnızca sektöre göre kalibre edilmiş **mutlak önem eşiği** aşıldığında gerçekleşir.
   * **Sıralama:** Yalnızca eşiği aşmayı başaran sinyaller, kendi aralarında önceliklendirilmek üzere boyutsuz bir bağıl büyüklükle (` aşım oranı = |değer| / sektör_eşiği `) sıralanır. Eşiği aşan şirket yoksa 0 sinyal üretilir.

---

## 2. KAP Veri Kaynağı ve Dosya Yapısı Gerçekleri (2026/2 Test Bulguları)

### 2.1. İndirme Kanalı ve Kesinti Dayanıklılığı
* **Toplu İndirme Adresi:** `GET https://www.kap.org.tr/tr/api/financialTable/download/{year}/{quarter}` (`quarter` $\in \{1, 2, 3, 4\}$).
* **Ağ Kararsızlığı:** ~28,5 MB boyutundaki ZIP akışı sık sık yarıda kesilmektedir (testlerde 3,7 MB – 15 MB arasında kopmalar gözlenmiştir).
* **Zorunlu İndirici Gereksinimi:** İndirici (`downloader.py`) üstel geri çekilmeli yeniden deneme (exponential backoff retry) ve bozuk/yarım ZIP arşivlerinden tam inmiş `.xls` girdilerini kurtarma (stream recovery) yeteneğine sahip olmalı, kaybolan dosyaları raporlamalıdır. KAP `Range` başlığını yok sayar (29.10.2026'da ölçüldü); kaldığı yerden devam mümkün değildir, her deneme baştan indirir (#38).
* **Anlık Bildirim vs. Toplu Arşiv:** Toplu ZIP geçmiş dönem taraması ve Faz 0/1 doğrulaması içindir; anlık sinyal üretimi (Faz 2+) tekil bildirim akışı servisine (`disclosure/list/main`) dayanmalıdır.

### 2.2. Dosya Adlandırma Kuralı ve Çoklu Kod İstisnası
* **Format:** `{TICKER_GROUP}_{disclosure_id}_{year}_{quarter}.xls`
* **Tireli İşlem Kodları (24 / 246 dosyada doğrulandı):** Şirketin birden fazla pay tertibi veya borçlanma aracı kodu varsa dosya adında tire (`-`) ile birleşik gelir:
  * Örnekler: `A1CAP-ACP_1645514_2026_2.xls`, `GARAN-TGB_1639060_2026_2.xls`, `ATA-ATAYM_1651692_2026_2.xls`, `YKR-YKYAT_1639906_2026_2.xls`.
* **Kural:** Dosya adındaki ilk parça `raw_ticker_group` olarak saklanır; birincil Borsa İstanbul hisse kodu (`primary_ticker`) eşleme tablosu veya ilk kök kod üzerinden ayrıca çözümlenir.

### 2.3. HTML Yapısı ve Karakter Kodlaması
* Uzantı `.xls` olmasına rağmen içerik **`UTF-8` (`charset="utf-8"`)** kodlamalı HTML belgesidir (246 dosyanın tamamı geçerli UTF-8'dir; ayrıştırıcıda sadece eski arşiv yılları için `cp1254` yedek dönüşümü bulundurulur).
* Tek bir `.xls` dosyası içinde **700'den fazla iç içe `<table>` etiketi** bulunur (her kalem satırı kendi iç `<table><tr>...</tr></table>` bloğuna sarılmıştır).
* Bu nedenle düz `pandas.read_html()` veya basit `<tr>` regex'i **kullanılamaz**; ayrıştırma doğrudan XBRL CSS sınıfları üzerinden yapılmalıdır.

---

## 3. Şablon Aileleri ve XBRL Rol Kodları (`tbl_{family}_role_{code}`)

Kurtarılan 246 adet `2026/2` dosyasında **5 farklı şablon ailesi** tespit edilmiştir:

| Şablon Ailesi (`family`) | Dosya Sayısı (246 içinde) | Kapsadığı Şirket Türleri | Bilanço Rol Kodu (`21xxxx`) | Gelir Tablosu Rol Kodu (`31xxxx`) | Nakit Akışı Rol Kodu (`51/52xxxx`) |
| :--- | :---: | :--- | :---: | :---: | :---: |
| **`general`** | **214** | Sanayi, Ticaret, Hizmet, GYO, Teknoloji | `210015` | `310003` (141 şirket - Birleşik)<br>`310000` (72 şirket - Ayrı)<br>`310002` (1 şirket - `OBASE`) | `520003` (213 şirket - Dolaylı)<br>`510011` (1 şirket - Doğrudan) |
| **`banks`** | **14** | Mevduat ve Katılım Bankaları (`AKBNK`, `GARAN-TGB` vb.) | `210011` (12)<br>`210010` (2) | `310017` (12)<br>`310016` (2) | `510007` (12)<br>`510006` (2) |
| **`finance`** | **8** | Faktoring, Leasing, Finansman, Aracı Kurum | `210014` | `310020` | `510010` |
| **`holding`** | **5** | Holdingler (ör. `DOHOL`) | `210015` | `310004` | `520003` |
| **`insurance`** | **5** | Sigorta ve Emeklilik (`AGESA`, `ANHYT`, `ANSGR`) | `210004` | `310010` | `510004` |

**Evrensel Rol Kodu Kuralı:**
6 haneli rol kodunun ilk 2 hanesi tüm şablon ailelerinde tablo türünü belirler:
* `21xxxx`: Finansal Durum Tablosu (Bilanço) (`2105xx` = Nazım Hesaplar)
* `31xxxx`: Kar veya Zarar Tablosu (Gelir Tablosu)
* `41xxxx` / `42xxxx`: Diğer Kapsamlı Gelir Tablosu
* `51xxxx`: Nakit Akış Tablosu (Doğrudan Yöntem)
* `52xxxx`: Nakit Akış Tablosu (Dolaylı Yöntem)
* `61xxxx`: Özkaynaklar Değişim Tablosu

---

## 4. Hücre, Kolon ve Ölçek Yapısı

### 4.1. Ölçek Çarpanı (`Sunum Para Birimi`) — *Zorunlu Normalizasyon*
Her ana tablonun üstündeki `<table class="financial-header-table">` içinde `Sunum Para Birimi` ve `Finansal Tablo Niteliği` yer alır.
* **246 Dosyadaki Dağılım:**
  * `TL`: **187 şirket** (Çarpan = $1$)
  * `1.000 TL`: **44 şirket** (Çarpan = $1.000$)
  * `1.000.000 TL`: **15 şirket** (Çarpan = $1.000.000$)
* **Kritik Bulgu:** Hücre içindeki `<div class="... monetary-field-default" title="39369">` özniteliğindeki sayı **ölçeklenmemiştir** (`Sunum Para Birimi` `1.000.000 TL` ise `title="39369"` gerçekte $39.369.000.000\text{ TL}$'dir).
* **Kural:** Veritabanına hem `raw_value` (`39369`) hem `scale_multiplier` (`1000000`) hem de çarpılmış kanonik değer `normalized_value_tl` (`39369000000`) kaydedilir.

### 4.2. Deterministik Satır ve Kolon Sınıfları
KAP HTML çıktısında her veri satırı ve her dönem kolonu sabit CSS sınıflarına sahiptir:
* **Satır Kimliği (`row_id`):** `<tr class="{family}_role_{code}-row-{row_index} data-input-row ... presentation-enabled">`
  * Örn: `general_role_310003-row-3` tüm `310003` şirketlerinde deterministik olarak **`Hasılat`** satırıdır.
* **Kalem Adı (`label_tr`):** `<div class="gwt-Label multi-language-content content-tr">Hasılat</div>`
* **Dipnot Referansı (`footnote_ref`):** `<div class="taxonomy-footnote-value">18</div>`
* **Dönem Kolonları (`col-order-class-*`):**
  * **Bilanço (`21xxxx`):**
    * **Standart (`general`, `holding`, `insurance` — 2 veya 3 kolon):**
      * `col-order-class-4`: Cari Dönem (`30.06.2026` — `POINT_IN_TIME`)
      * `col-order-class-5`: Önceki Dönem (`31.12.2025` — `POINT_IN_TIME`, TMS 29 ile cari dönem alım gücüne endekslenmiş)
      * `col-order-class-6` *(Opsiyonel — TMS 1 Geçmişe Dönük Yeniden Düzenleme / Sınıflandırma olan şirketlerde, ör. `AYEN`, `BIOEN`, `BSOKE`)*: Bir Önceki Dönem (`31.12.2024` — `POINT_IN_TIME`). **Not:** Bilançoda `col-order-class-6` varlığı, şirketin geçmiş finansal tablolarında yeniden düzenleme/sınıflandırma yaptığını gösteren deterministik bir tripwire sinyalidir.
    * **Banka ve Finans (`banks`, `finance` — 6 kolonlu TP / YP / Toplam yapısı):**
      * `col-order-class-4`: Cari Dönem (`TP` — Türk Parası)
      * `col-order-class-5`: Cari Dönem (`YP` — Yabancı Para)
      * `col-order-class-6`: Cari Dönem (`Toplam` — Ana bilanço değeri)
      * `col-order-class-7`: Önceki Dönem (`TP` — Türk Parası)
      * `col-order-class-8`: Önceki Dönem (`YP` — Yabancı Para)
      * `col-order-class-9`: Önceki Dönem (`Toplam` — Ana karşılaştırmalı bilanço değeri)
  * **Gelir Tablosu (`31xxxx` — Q2 ve Q3 raporlarında 4 kolon):**
    * `col-order-class-4`: Cari Dönem Kümülatif (`01.01.2026 - 30.06.2026` — `YTD_CUMULATIVE`)
    * `col-order-class-5`: Önceki Dönem Kümülatif (`01.01.2025 - 30.06.2025` — `YTD_CUMULATIVE`, endekslenmiş)
    * `col-order-class-6`: Cari Dönem 3 Aylık Solo (`01.04.2026 - 30.06.2026` — `Q_STANDALONE`)
    * `col-order-class-7`: Önceki Dönem 3 Aylık Solo (`01.04.2025 - 30.06.2025` — `Q_STANDALONE`, endekslenmiş)
    * *(Not: Q1 ve Q4 raporlarında sadece `col-order-class-4` ve `col-order-class-5` bulunur.)*
  * **Nakit Akış Tablosu (`51xxxx` / `52xxxx`):**
    * `col-order-class-4`: Cari Dönem Kümülatif (`01.01.2026 - 30.06.2026` — `YTD_CUMULATIVE`)
    * `col-order-class-5`: Önceki Dönem Kümülatif (`01.01.2025 - 30.06.2025` — `YTD_CUMULATIVE`, endekslenmiş)
    * *(Not: Nakit akış tablosunda hiçbir çeyrekte 3 aylık solo kolon **yoktur**; her zaman yıl başından kümülatiftir.)*

---

## 5. Muhasebe, İstatistik ve Zaman Serisi Kuralları (TMS 29, Mevsimsellik, Dönemsellik)

### 5.1. TMS 29 (Enflasyon Muhasebesi) ve Çift Zamanlı (Bitemporal) Veri Modeli
Kurtarılan 246 dosyanın **219'unda** (`banks`, `insurance` ve birkaç özel finans şirketi hariç tamamında) `Net Parasal Pozisyon Kazançları (Kayıpları)` kalemi bulunmaktadır *(Not: 246 dosya yarım kalan ZIP'in ilk kısmından çıktığı için rastgele bir örneklem değildir; oranlar 776 şirketin tamamına genellenmemelidir)*.
* **Kural 1 — Çift Zaman Boyutu (`as_reported` vs. `restated`) ve Özel Hesap Dönemleri:**
  * Bir şirketin `2025/2` döneminde açıkladığı tablodaki rakam (`as_reported_in = 2025_2`) o raporun bilanço tarihindeki TL alım gücündedir.
  * Aynı şirketin `2026/2` tablosundaki "Önceki Dönem (`col-order-class-5` / `7`)" rakamı (`as_reported_in = 2026_2`) ise cari bilanço tarihindeki TL'ye endekslenmiş (`restated`) değerdir.
  * **Özel Hesap Dönemi Kuralı:** Her şirket takvim yılı (`01.01 - 30.06`) kullanmaz (ör. `MAVI` `2026_2` dosyasında dönem `01.02.2026 - 31.07.2026`, bilanço tarihi `31.07.2026`'dır). Bu nedenle hem `purchasing_power_date`, hem TÜFE endeks eşlemesi, hem de kesitsel dönem gruplaması çeyrek numarasından (`2026_2`) varsayılmaz; doğrudan kolon başlığındaki başlangıç ve bitiş tarihlerinden (`dd.mm.yyyy`) ayrıştırılır.
* **Kural 2 — Aynı Satın Alma Gücünde Karşılaştırma ve TÜİK TÜFE Endeksi Gereksinimi:**
  * YoY (Yıllık aynı çeyrek) karşılaştırmaları doğrudan **aynı bildirim içindeki Cari Dönem (`col-4`/`col-6`) ve Önceki Dönem (`col-5`/`col-7`)** kolonları üzerinden yapılır.
  * **Farklı Raporlar Arası TL Toplama/Çıkarma Yasağı:** Farklı çeyrek raporlarındaki TL tutarları farklı satın alma gücündedir; doğrudan toplanamaz (TTM) veya çıkarılamaz ($\text{Q4 Solo} = \text{12A} - \text{9A}$). Çeyrekler arası karşılaştırmalarda **boyutsuz oranlar (`TL / TL`)** kullanılır. 4. çeyrek solo ayrıştırması için dış veri kaynağı olarak resmi **TÜİK TÜFE endeks serisi** ($\text{Q4 Solo} = \text{12A}_{t_{\text{son}}} - \text{9A}_{t_{\text{Q3}}} \times \frac{\text{TÜFE}(t_{\text{son}})}{\text{TÜFE}(t_{\text{Q3}})}$) gerçek bilanço tarihlerine (`dd.mm.yyyy`) göre uygulanır.
* **Kural 3 — Parasal Pozisyon, Finansman Gideri ve Vergi Öncesi/Sonrası Bütünlüğü:**
  * `general_role_310003-row-52` / `310000-row-52` (`Net Parasal Pozisyon Kazançları (Kayıpları)`) **vergi öncesi** bir kalemdir; `row-59` (`Dönem Kârı (Zararı)`) ise **vergi sonrası** bir kalemdir. Ayrıca TL borçlu şirketlerde yüksek nominal `Finansman Giderleri` (`row-51`) ile borcun reel erimesini gösteren `Net Parasal Pozisyon Kazancı` (`row-52`) ekonomik olarak birbirinin karşılığıdır.
  * **Kesin Kural:** Vergi sonrası net kârdan vergi öncesi parasal pozisyon kazancı çıkarılarak *"parasal kazanç hariç gerçek kâr/zarar"* gibi yapay bir sayı **hesaplanmaz** ve *"şirket aslında zararda"* gibi yorumlar **yapılmaz**. Bunun yerine bileşenler yan yana, aynı dönemsellikte (`col-order-class-4`) ve toplam varlıklara/hasılata oranlanarak (ölçekten bağımsız) sunulur:
    1. `Sürdürülen Faaliyetler Dönem Kârı (Zararı)` (`general_role_310003-row-57` / `310000-row-57`) ve `Dönem Kârı (Zararı)` (`row-59`)
    2. `İşletme Faaliyetlerinden Nakit Akışları` (`general_role_520003-row-2` / `510011-row-2`)
    3. `Esas Faaliyet Kârı (Zararı)` (`general_role_310003-row-38` / `310000-row-38`) ve `Amortisman ve İtfa Gideri` (`general_role_520003-row-7`)
    4. `Finansman Gelir/Giderleri` (`row-50`, `row-51`) ve `Net Parasal Pozisyon Kazançları (Kayıpları)` (`row-52`)
* **Kural 4 — Matematiksel Ayrıştırma, Yapısal Değişiklik Bayrakları ve Sınırlar:**
  * **Nedensel Tahmin Yerine Pay/Payda Ayrıştırması ve Amortisman Kapsamı:** Motor *"sebep TMS 29 amortismanıdır"* gibi nedensel iddia **üretmez**; sadece `Hasılat` YoY değişimini ve `Satışların Maliyeti` YoY değişimini yan yana gösterir. Nakit akış tablosundaki `general_role_520003-row-7` (`Amortisman ve İtfa Gideri`) şirketin **toplam** (üretim + yönetim + pazarlama) 6 aylık kümülatif amortismanıdır; çeyreklik değildir ve tamamı `Satışların Maliyeti` içinde yer almaz (bu kırılım sadece PDF dipnotundadır). Bu nedenle `Toplam Amortisman / Satışların Maliyeti` gibi kapsamı farklı iki kalem birbirine **bölünmez**.
  * **Şablona Özgü Durdurulan Faaliyetler Bayrağı:** Satır numaraları şablon ailesine özgüdür (`holding_role_310004-row-58` ertelenmiş vergidir, `insurance_role_310010-row-58` hayat teknik gideridir!). Bu nedenle `Durdurulan Faaliyetler Dönem Kârı (Zararı)` kontrolü yalnızca tam şablon kimliğiyle yapılır:
    * `general`: `general_role_310003-row-58`, `general_role_310000-row-58`, `general_role_310002-row-58` (246 dosyada 5 şirket: `CLEBI`, `GRTHO`, `HURGZ`, `KORDS`, `TAVHL`)
    * `holding`: `holding_role_310004-row-60`
    * `banks`: `banks_role_310017-row-58` (`GARAN`)
  * **Kapsam Sınırı (Satın Alma ve Birleşmeler):** Gelir tablosundaki durdurulan faaliyet satırı yalnızca *elden çıkarılan/durdurulan* faaliyetleri gösterir. Nakit akış tablosundaki `Bağlı Ortaklık Edinimi Nakit Çıkışları` ise yalnızca *nakit karşılığı* alımları yakalar; **hisse karşılığı birleşmeleri ve nakit çıkışı olmayan konsolidasyon kapsamı değişikliklerini yakalayamaz**. Tam kapsam değişikliği tespiti için Faz 2'de KAP Özel Durum Açıklamaları (ÖDA) ve dipnotlar gereklidir.
  * **Bilanço 3. Kolon (`col-order-class-6`) ile Diğer Sinyallerin İlişkisi:** Bilançoda 3. kolonun (`Bir Önceki Dönem`) dolu olması (`BIOEN`, `BSOKE`) hem **Sinyal 3 (Yeniden Düzenleme Tripwire)** olarak tek başına raporlanır hem de aynı şirketin Sinyal 1 ve Sinyal 2 çıktısına **bilgilendirici bağlam etiketi (`prior_period_restated = true`)** olarak eklenir (diğer sinyalleri bastırmaz/gizlemez).
* **Kural 5 — Ekonomik Önem Eşiği (Tetikleme) ve Sıralama:**
  * **İstatistiksel Sektör Eşiği Kısıtı:** TMS 29 sonrası geçmiş (~11 çeyrek) ve BIST alt sektörlerindeki şirket sayısı (çoğu alt sektörde 3–10 şirket) otomatik varyans/standart sapma tahmini için yetersizdir.
  * **İki Koşullu Ekonomik Önem Eşiği:** Aşırı uyum (overfitting) ve gerçek vakaları kaçırma riskini önlemek için üç yerine **iki temel koşul** (`VE` ile bağlı) kullanılır:
    1. **Mutlak Puan Değişimi:** $|\Delta \text{Marj}| = |\text{Marj}_t - \text{Marj}_{t-1}| \ge X\text{ bps}$ (uzman görüşüyle belirlenen asgari puan farkı) **VE**
    2. **Saf Marj Etkisinin Büyüklüğü:** Hacim değişimi etkisini dışarıda bırakmak için brüt kâr farkı ($\Delta \text{Brüt Kâr}$) yerine **saf marj etkisi** hesaplanır:
       $$\text{Marj Etkisi (TL)} = |\text{Marj}_t - \text{Marj}_{t-1}| \times \text{Hasılat}_t$$
       Varlık yoğunluğuna göre sektörel yanlılık (aktif devir hızı farkı) yaratmamak adına payda olarak `Toplam Varlıklar` yerine **`Özkaynaklar` veya önceki dönem `|Esas Faaliyet Kârı|`** (veya sektöre göre ayarlı eşik) kullanılarak $\frac{\text{Marj Etkisi (TL)}}{\text{Payda}} \ge Z\%$ şartı aranır.
* **Kural 6 — Sektör Sınıflandırması Bağımlılığı (Henüz Doğrulanmadı):**
  * `.xls` dosyalarının içinden yalnızca **5 ana XBRL şablon ailesi (`general`, `banks`, `finance`, `holding`, `insurance`)** ve `row-6..29` (`Finans Sektörü Faaliyetleri`) bilgisi çıkmaktadır; şirketin BIST alt sektörü (`GYO`, `Aracı Kurum`, `Enerji`, `Perakende` vb.) `.xls` dosyasında **yazmaz**.
  * Bu nedenle KAP'ın şirket/sektör meta verisi servisi Faz 0'da ayrıca test edilip doğrulanmalıdır.

---

## 6. Kanonik Veri ve Sinyal Şemaları (Faz 0 Taslağı)

### 6.1. Ayrıştırılmış Kalem Şeması (`ParsedFinancialFact` — `KATMR_1651411_2026_2.xls` Örneği)
```json
{
  "company_code": "KATMR",
  "raw_ticker_group": "KATMR",
  "disclosure_id": 1651411,
  "year": 2026,
  "quarter": 2,
  "consolidation_type": "Konsolide",
  "template_family": "general",
  "role_code": "310003",
  "statement_type": "INCOME_STATEMENT",
  "row_id": "general_role_310003-row-3",
  "label_tr": "Hasılat",
  "canonical_metric": "revenue",
  "footnote_ref": "19",
  "column_class": "col-order-class-6",
  "period_type": "Q_STANDALONE",
  "period_label": "Cari Dönem 3 Aylık 01.04.2026 - 30.06.2026",
  "purchasing_power_date": "2026-06-30",
  "is_restated_comparative": false,
  "raw_value": 879599263,
  "scale_unit": "TL",
  "scale_multiplier": 1,
  "normalized_value_tl": 879599263
}
```

### 6.2. Sinyal Nesnesi Şeması (`SignalObject` — `KATMR_1651411_2026_2.xls` Örneği)
```json
{
  "signal_id": "sig_2026_2_KATMR_gross_margin_deviation",
  "company_code": "KATMR",
  "raw_ticker_group": "KATMR",
  "period": "2026-Q2",
  "disclosure_id": 1651411,
  "signal_type": "GROSS_MARGIN_DEVIATION",
  "neutral_title": "Ticari Brüt Marj YoY Solo Çeyrek Sapması",
  "severity_rank_score": 2.6,
  "summary_metrics": {
    "current_q_standalone_margin": 0.21543,
    "prior_year_q_standalone_restated_margin": 0.475035,
    "delta_bps": -2596,
    "current_q_revenue_tl": 879599263,
    "prior_year_q_revenue_restated_tl": 694991758
  },
  "evidence_chain": [
    {
      "metric": "commercial_gross_profit_current_q",
      "label_tr": "TİCARİ FAALİYETLERDEN BRÜT KAR (ZARAR)",
      "row_id": "general_role_310003-row-5",
      "disclosure_id": 1651411,
      "column_class": "col-order-class-6",
      "period_label": "Cari Dönem 3 Aylık 01.04.2026 - 30.06.2026",
      "raw_value": 189492068,
      "scale_unit": "TL",
      "normalized_value_tl": 189492068
    },
    {
      "metric": "revenue_current_q",
      "label_tr": "Hasılat",
      "row_id": "general_role_310003-row-3",
      "disclosure_id": 1651411,
      "column_class": "col-order-class-6",
      "period_label": "Cari Dönem 3 Aylık 01.04.2026 - 30.06.2026",
      "raw_value": 879599263,
      "scale_unit": "TL",
      "normalized_value_tl": 879599263
    },
    {
      "metric": "commercial_gross_profit_prior_year_q_restated",
      "label_tr": "TİCARİ FAALİYETLERDEN BRÜT KAR (ZARAR)",
      "row_id": "general_role_310003-row-5",
      "disclosure_id": 1651411,
      "column_class": "col-order-class-7",
      "period_label": "Önceki Dönem 3 Aylık 01.04.2025 - 30.06.2025",
      "raw_value": 330145727,
      "scale_unit": "TL",
      "normalized_value_tl": 330145727
    },
    {
      "metric": "revenue_prior_year_q_restated",
      "label_tr": "Hasılat",
      "row_id": "general_role_310003-row-3",
      "disclosure_id": 1651411,
      "column_class": "col-order-class-7",
      "period_label": "Önceki Dönem 3 Aylık 01.04.2025 - 30.06.2025",
      "raw_value": 694991758,
      "scale_unit": "TL",
      "normalized_value_tl": 694991758
    }
  ],
  "formula": "commercial_gross_profit (row-5) / revenue (row-3) [col-6 vs col-7]",
  "llm_constraints": {
    "allow_price_commentary": false,
    "allow_external_causal_claims": false
  }
}
```

---

## 7. Faz Bazlı Devam / Dur Kriterleri (Veri Doğruluğu + Sinyal İsabeti ve Yakalama)

### 7.1. Faz 0 Devam / Dur Kriteri (Ayrıştırma ve Somut Elle Doğrulama Kapsamı)
Faz 1'e geçiş için aşağıdaki 2 kriter **%100 başarıyla** sağlanmalıdır:
1. **KAP Web/PDF Bağımsız Elle Doğrulama (Somut Kapsam):** Her şablon varyantından en az 2 şirket (`general 310003`, `general 310000`, `banks`, `finance`, `holding`, `insurance` — toplam en az **12 şirket**), son **4–8 çeyrek** boyunca şirket başına **10 temel kalem** (`Sunum Para Birimi` ölçeği, `Cari/Önceki Dönem` ve `Kümülatif/3 Aylık Solo` kolonları dahil) doğrudan **KAP web sayfasındaki bildirimlere ve PDF raporlarına** bakılarak elle kontrol edildiğinde `%100` birebir tutuyor mu?
2. **Tam Arşiv ve Sektör Meta Verisi Testi:** Kesintiye dayanıklı indirici ile ~776 şirketin tamamını içeren tam ZIP arşivleri indirilebildi mi ve KAP resmi sektör sınıflandırması servisi doğrulandı mı?

### 7.2. Faz 1 Devam / Dur Kriteri (Sinyal İsabeti / Precision ve Yakalama / Recall Protokolü)
Sadece sayıların doğru okunması ürünün çalıştığını kanıtlamaz; üretilen sinyalin bir finans analisti için **gerçekten önemli (material)** olup olmadığı aşağıdaki metodolojiyle ölçülmelidir:
1. **Kalibrasyon (Ayarlama) ve Değerlendirme (Test) Setlerinin Ayrılması:** Eşikleri ($X, Z$) belirlemek için kullanılan geçmiş dönem/şirket kümesi ile başarıyı ölçmek için kullanılan değerlendirme kümesi birbirinden ayrı tutulur.
2. **Çift Etiketleyici ve Yazılı Kılavuz:** Neyin *"Gerçekten Önemli"*, neyin *"Gürültü / Olağan Mevsimsel Dalgalanma / Muhasebe Artefaktı"* sayılacağını tanımlayan yazılı bir etiketleme kılavuzu hazırlanır; vakalar mümkünse **iki bağımsız uzman** tarafından etiketlenir ve aralarındaki uyum (inter-annotator agreement) raporlanır.
3. **İsabet (Precision) ve Yakalama (Recall) Hedefleri Birlikte:**
   * **İsabet (Precision):** Değerlendirme setinde tetiklenen sinyallerin en az **`%70`'i** uzmanlarca *"Gerçekten Önemli"* bulunmalıdır *(Not: $n=50$ örneklemde `%70` isabetin `%95` güven aralığı yaklaşık $\pm 13$ puandır; örneklem büyüklüğü yorumlanırken bu hata payı dikkate alınır)*.
   * **Yakalama (Recall — Aşırı Sıkı Eşik Önlemi):** Eşikleri aşırı yükselterek kolayca `%70` isabete ulaşmayı (ve önemli olayları kaçırmayı) engellemek için, uzmanların geçmiş raporlardan önceden belirlediği **en az 20 bilinen önemli kırılma vakasının (seed set)** çoğunluğunun motor tarafından yakalanması şarttır.


