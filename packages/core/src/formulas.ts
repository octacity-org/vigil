// Subtotal formulas: total row, the label that must be on that row, and its component rows.
// Carried over unchanged from the Python implementation in the TypeScript port (decision 0010).
// Each formula held in every 2026/2 filing that reports its components (#15, #16, #17).

/** [total row, expected label, component rows] */
export type Formula = readonly [number, string, readonly number[]];

export const INCOME_STATEMENT_ROLES = ["310003", "310000", "310002"] as const;
export const INCOME_STATEMENT_COLUMNS = [
  "col-order-class-4",
  "col-order-class-5",
  "col-order-class-6",
  "col-order-class-7",
] as const;
// Income statement (#15). Values carry their sign (costs are negative), so every subtotal is a plain sum of its
// components. Row numbers are the same in the general income statement variants 310003, 310000 and 310002.
export const INCOME_STATEMENT_SUBTOTALS: readonly Formula[] = [
  [5, "TİCARİ FAALİYETLERDEN BRÜT KAR (ZARAR)", [3, 4]],
  [6, "Finans Sektörü Faaliyetleri Hasılatı", [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]],
  [17, "Finans Sektörü Faaliyetleri Maliyeti", [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]],
  [29, "FİNANS SEKTÖRÜ FAALİYETLERİNDEN BRÜT KAR (ZARAR)", [6, 17]],
  [31, "BRÜT KAR (ZARAR)", [5, 29, 30]],
  [38, "ESAS FAALİYET KARI (ZARARI)", [31, 32, 33, 34, 35, 36, 37]],
  [49, "FİNANSMAN GELİRİ (GİDERİ) ÖNCESİ FAALİYET KARI (ZARARI)", [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48]],
  [53, "SÜRDÜRÜLEN FAALİYETLER VERGİ ÖNCESİ KARI (ZARARI)", [49, 50, 51, 52]],
  [54, "Sürdürülen Faaliyetler Vergi (Gideri) Geliri", [55, 56]],
  [57, "SÜRDÜRÜLEN FAALİYETLER DÖNEM KARI (ZARARI)", [53, 54]],
  [59, "DÖNEM KARI (ZARARI)", [57, 58]],
  [59, "DÖNEM KARI (ZARARI)", [61, 62]],
];

export const BALANCE_SHEET_ROLES = ["210015"] as const;
export const BALANCE_SHEET_COLUMNS = ["col-order-class-4", "col-order-class-5", "col-order-class-6"] as const;
// Balance sheet (#16). Every group in the general balance sheet (210015, also used by the holding template) is the
// sum of the rows below it (12,885 comparisons in 2026/2). Column 6 is the restated comparative column, when present.
export const BALANCE_SHEET_SUBTOTALS: readonly Formula[] = [
  [6, "Finansal Yatırımlar", [7, 8, 9, 10, 11, 16, 19, 20, 21]],
  [11, "Gerçeğe Uygun Değer Farkı Kar/Zarara Yansıtılan Finansal Varlıklar", [12, 13, 14, 15]],
  [16, "Gerçeğe Uygun Değer Farkı Diğer Kapsamlı Gelire Yansıtılan Finansal Varlıklar", [17, 18]],
  [22, "Ticari Alacaklar", [23, 24]],
  [25, "Finans Sektörü Faaliyetlerinden Alacaklar", [26, 27]],
  [29, "Diğer Alacaklar", [30, 31]],
  [32, "Müşteri Sözleşmelerinden Doğan Varlıklar", [33, 34, 35]],
  [37, "Türev Araçlar", [38, 39]],
  [43, "Peşin Ödenmiş Giderler", [44, 45]],
  [49, "Diğer Dönen Varlıklar", [50, 51]],
  [52, "ARA TOPLAM", [4, 5, 6, 22, 25, 28, 29, 32, 36, 37, 40, 41, 42, 43, 46, 47, 48, 49]],
  [55, "TOPLAM DÖNEN VARLIKLAR", [52, 53, 54]],
  [57, "Finansal Yatırımlar", [58, 59, 60, 61, 62, 67, 70, 71]],
  [62, "Gerçeğe Uygun Değer Farkı Kar/Zarara Yansıtılan Finansal Varlıklar", [63, 64, 65, 66]],
  [67, "Gerçeğe Uygun Değer Farkı Diğer Kapsamlı Gelire Yansıtılan Finansal Varlıklar", [68, 69]],
  [73, "Ticari Alacaklar", [74, 75]],
  [76, "Finans Sektörü Faaliyetlerinden Alacaklar", [77, 78]],
  [79, "Diğer Alacaklar", [80, 81]],
  [82, "Müşteri Sözleşmelerinden Doğan Varlıklar", [83, 84, 85]],
  [87, "Türev Araçlar", [88, 89]],
  [95, "Maddi Duran Varlıklar", [96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107]],
  [109, "Maddi Olmayan Duran Varlıklar", [110, 111, 112, 113, 114, 115, 116, 117, 118]],
  [119, "Peşin Ödenmiş Giderler", [120, 121]],
  [125, "Diğer Duran Varlıklar", [126, 127]],
  [
    128,
    "TOPLAM DURAN VARLIKLAR",
    [57, 72, 73, 76, 79, 82, 86, 87, 90, 91, 92, 93, 94, 95, 108, 109, 119, 122, 123, 124, 125],
  ],
  [129, "TOPLAM VARLIKLAR", [55, 128]],
  [132, "Kısa Vadeli Borçlanmalar", [133, 138]],
  [133, "İlişkili Taraflardan Kısa Vadeli Borçlanmalar", [134, 135, 136, 137]],
  [138, "İlişkili Olmayan Taraflardan Kısa Vadeli Borçlanmalar", [139, 140, 141, 142]],
  [143, "Uzun Vadeli Borçlanmaların Kısa Vadeli Kısımları", [144, 149]],
  [144, "İlişkili Taraflardan Uzun Vadeli Borçlanmaların Kısa Vadeli Kısımları", [145, 146, 147, 148]],
  [149, "İlişkili Olmayan Taraflardan Uzun Vadeli Borçlanmaların Kısa Vadeli Kısımları", [150, 151, 152, 153]],
  [154, "Diğer Finansal Yükümlülükler", [155, 156, 157]],
  [158, "Ticari Borçlar", [159, 160]],
  [161, "Finans Sektörü Faaliyetlerinden Borçlar", [162, 163]],
  [165, "Diğer Borçlar", [166, 167]],
  [168, "Müşteri Sözleşmelerinden Doğan Yükümlülükler", [169, 170, 171]],
  [173, "Türev Araçlar", [174, 175]],
  [177, "Ertelenmiş Gelirler (Müşteri Sözleşmelerinden Doğan Yükümlülüklerin Dışında Kalanlar)", [178, 179]],
  [181, "Kısa Vadeli Karşılıklar", [182, 183, 184]],
  [185, "Diğer Kısa Vadeli Yükümlülükler", [186, 187]],
  [188, "ARA TOPLAM", [132, 143, 154, 158, 161, 164, 165, 168, 172, 173, 176, 177, 180, 181, 185]],
  [191, "TOPLAM KISA VADELİ YÜKÜMLÜLÜKLER", [188, 189, 190]],
  [193, "Uzun Vadeli Borçlanmalar", [194, 199]],
  [194, "İlişkili Taraflardan Uzun Vadeli Borçlanmalar", [195, 196, 197, 198]],
  [199, "İlişkili Olmayan Taraflardan Uzun Vadeli Borçlanmalar", [200, 201, 202, 203]],
  [204, "Diğer Finansal Yükümlülükler", [205, 206, 207]],
  [208, "Ticari Borçlar", [209, 210]],
  [211, "Finans Sektörü Faaliyetlerinden Borçlar", [212, 213]],
  [215, "Diğer Borçlar", [216, 217]],
  [218, "Müşteri Sözleşmelerinden Doğan Yükümlülükler", [219, 220, 221]],
  [223, "Türev Araçlar", [224, 225]],
  [227, "Ertelenmiş Gelirler (Müşteri Sözleşmelerinden Doğan Yükümlülüklerin Dışında Kalanlar)", [228, 229]],
  [230, "Uzun Vadeli Karşılıklar", [231, 232, 233, 234, 235]],
  [238, "Diğer Uzun Vadeli Yükümlülükler", [239, 240]],
  [
    241,
    "TOPLAM UZUN VADELİ YÜKÜMLÜLÜKLER",
    [193, 204, 208, 211, 214, 215, 218, 222, 223, 226, 227, 230, 236, 237, 238],
  ],
  [242, "TOPLAM YÜKÜMLÜLÜKLER", [191, 241]],
  [
    244,
    "Ana Ortaklığa Ait Özkaynaklar",
    [245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 269, 284, 290, 291, 292, 293, 294],
  ],
  [
    256,
    "Kar veya Zararda Yeniden Sınıflandırılmayacak Birikmiş Diğer Kapsamlı Gelirler (Giderler)",
    [257, 258, 264, 265, 266, 267, 268],
  ],
  [258, "Yeniden Değerleme ve Ölçüm Kazançları (Kayıpları)", [259, 260, 261, 262, 263]],
  [
    269,
    "Kar veya Zararda Yeniden Sınıflandırılacak Birikmiş Diğer Kapsamlı Gelirler (Giderler)",
    [270, 271, 275, 279, 280, 281, 282, 283],
  ],
  [271, "Riskten Korunma Kazançları (Kayıpları)", [272, 273, 274]],
  [275, "Yeniden Değerleme ve Sınıflandırma Kazançları (Kayıpları)", [276, 277, 278]],
  [284, "Kardan Ayrılan Kısıtlanmış Yedekler", [285, 286, 287, 288, 289]],
  [296, "TOPLAM ÖZKAYNAKLAR", [244, 295]],
  [297, "TOPLAM KAYNAKLAR", [242, 296]],
];

export const CASH_FLOW_ROLES = ["520003"] as const;
export const CASH_FLOW_COLUMNS = ["col-order-class-4", "col-order-class-5"] as const;
// Cash flow statement (#17), indirect method (520003, general and holding templates). Row 53 (disposals of
// non-current assets) covers rows 54-58 only; rows 59-61 (disposals of assets held for sale, associates,
// subsidiaries) sit directly under row 6. Row 205 is the effect of exchange rate changes on cash; 119, 161, 202 and
// 203 are inflation effects.
export const CASH_FLOW_SUBTOTALS: readonly Formula[] = [
  [
    2,
    "İŞLETME FAALİYETLERİNDEN NAKİT AKIŞLARI",
    [102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119],
  ],
  [3, "Dönem Karı (Zararı)", [4, 5]],
  [
    6,
    "Dönem Net Karı (Zararı) Mutabakatı İle İlgili Düzeltmeler",
    [7, 8, 19, 28, 29, 30, 31, 36, 37, 38, 39, 40, 41, 48, 51, 52, 53, 59, 60, 61, 62, 63, 64],
  ],
  [8, "Değer Düşüklüğü (İptali) İle İlgili Düzeltmeler", [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]],
  [19, "Karşılıklar İle İlgili Düzeltmeler", [20, 21, 22, 23, 24, 25, 26, 27]],
  [31, "Faiz (Gelirleri) ve Giderleri İle İlgili Düzeltmeler", [32, 33, 34, 35]],
  [41, "Gerçeğe Uygun Değer Kayıpları (Kazançları) İle İlgili Düzeltmeler", [42, 43, 44, 45, 46, 47]],
  [48, "Özkaynak Yöntemiyle Değerlenen Yatırımların Dağıtılmamış Karları ile İlgili Düzeltmeler", [49, 50]],
  [
    53,
    "Duran Varlıkların Elden Çıkarılmasından Kaynaklanan Kayıplar (Kazançlar) İle İlgili Düzeltmeler",
    [54, 55, 56, 57, 58],
  ],
  [
    65,
    "İşletme Sermayesinde Gerçekleşen Değişimler",
    [66, 67, 68, 71, 72, 75, 79, 80, 81, 82, 83, 84, 87, 88, 89, 93, 96, 97, 98, 99],
  ],
  [68, "Ticari Alacaklardaki Azalış (Artış) ile İlgili Düzeltmeler", [69, 70]],
  [72, "Faaliyetlerle İlgili Diğer Alacaklardaki Azalış (Artış) ile İlgili Düzeltmeler", [73, 74]],
  [75, "Müşteri Sözleşmelerinden Doğan Varlıklardaki Azalış (Artış) İle İlgili Düzeltmeler", [76, 77, 78]],
  [84, "Ticari Borçlardaki Artış (Azalış) ile İlgili Düzeltmeler", [85, 86]],
  [89, "Müşteri Sözleşmelerinden Doğan Yükümlülüklerdeki Artış (Azalış) İle İlgili Düzeltmeler", [90, 91, 92]],
  [93, "Faaliyetler ile İlgili Diğer Borçlardaki Artış (Azalış) ile İlgili Düzeltmeler", [94, 95]],
  [99, "İşletme Sermayesinde Gerçekleşen Diğer Artış (Azalış) ile İlgili Düzeltmeler", [100, 101]],
  [102, "Faaliyetlerden Elde Edilen Nakit Akışları", [3, 6, 65]],
  [
    120,
    "YATIRIM FAALİYETLERİNDEN KAYNAKLANAN NAKİT AKIŞLARI",
    [
      121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 133, 136, 137, 138, 139, 140, 141, 142, 143, 144, 147, 150, 151,
      152, 153, 154, 155, 156, 157, 158, 159, 160, 161,
    ],
  ],
  [130, "Maddi ve Maddi Olmayan Duran Varlıkların Satışından Kaynaklanan Nakit Girişleri", [131, 132]],
  [133, "Maddi ve Maddi Olmayan Duran Varlıkların Alımından Kaynaklanan Nakit Çıkışları", [134, 135]],
  [144, "Verilen Nakit Avans ve Borçlar", [145, 146]],
  [147, "Verilen Nakit Avans ve Borçlardan Geri Ödemeler", [148, 149]],
  [
    162,
    "FİNANSMAN FAALİYETLERİNDEN NAKİT AKIŞLARI",
    [
      163, 164, 165, 168, 169, 173, 177, 178, 183, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201,
      202,
    ],
  ],
  [165, "Pay ve Diğer Özkaynağa Dayalı Araçların İhracından Kaynaklanan Nakit Girişleri", [166, 167]],
  [
    169,
    "İşletmenin Kendi Paylarını ve Diğer Özkaynağa Dayalı Araçlarını Almasıyla İlgili Nakit Çıkışları",
    [170, 171, 172],
  ],
  [
    173,
    "İşletmenin Kendi Paylarını ve Diğer Özkaynağa Dayalı Araçlarını Satmasından Kaynaklanan Nakit Girişleri",
    [174, 175, 176],
  ],
  [178, "Borçlanmadan Kaynaklanan Nakit Girişleri", [179, 180, 181, 182]],
  [183, "Borç Ödemelerine İlişkin Nakit Çıkışları", [184, 185, 186, 187]],
  [
    204,
    "YABANCI PARA ÇEVRİM FARKLARININ ETKİSİNDEN ÖNCE NAKİT VE NAKİT BENZERLERİNDEKİ NET ARTIŞ (AZALIŞ)",
    [2, 120, 162, 203],
  ],
  [206, "NAKİT VE NAKİT BENZERLERİNDEKİ NET ARTIŞ (AZALIŞ)", [204, 205]],
  [209, "DÖNEM SONU NAKİT VE NAKİT BENZERLERİ", [206, 207, 208]],
];
