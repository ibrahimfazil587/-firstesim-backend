# FirstESIM — Backend + Admin Panel + QR

ئەم starter ـە ئەو flow ـەی تۆ دەوێت دروست دەکات:

کڕیار → Order → ناردنی پسوڵە → Admin Panel → پشتڕاستکردنەوە → Upload QR → کڕیار QR دەبینێت.

## دامەزراندن
پێویستە Node.js لە computer/server ـێکدا هەبێت.

```bash
npm install
ADMIN_KEY="کلیلێکی زۆر بەهێز" npm start
```

Admin:
`/admin.html`

Customer order lookup:
`/customer.html`

## گرنگ
GitHub Pages تەنها static files ـە و ئەم backend ـەی Node.js لەسەری جێبەجێ نابێت.
بۆ production پێویستە backend ـەکە لە hosting ـێکی server-side دابنرێت و database ـی production بەکاربهێنرێت.

ئەم starter ـە بۆ تاقیکردنەوەی flow ـە؛ بۆ بڵاوکردنەوەی واقعی پێویستە authentication، database، storage، HTTPS، backup و payment verification ـی production زیاد بکرێن.
