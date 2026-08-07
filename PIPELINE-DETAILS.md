# شرح البايبلاين — Auto Scrape + Upload + Storage

> شرح مفصل، **كيفاش** و **علاش** كلشي كيخدّم، مبني على الكود الحالي (script.js / turso.js / config.json).

---

## 1. نظرة عامة

بايبلاين تلقائي كيشتغل على GitHub Actions (cron 10 مرات فالنهار) و كيعمل 4 حوايج:

1. **يسكريبي** أفلام جديدة من موقع `topcinemaa.co`
2. **يستخرج** رابط البث `m3u8` (HLS) من الفيلم
3. **يحمل** الفيديو + **يحوّلو** لـ MP4 صحيح بـ ffmpeg + **يرفعو** لـ 6 hosts
4. **يخزن** كلشي فـ 3 قواعد Turso (شاردنغ)

الهدف النهائي: **كل فيلم جديد يطلع على جميع السيرفرات بملفات حقيقية قابلة للتشغيل** (ماشي روابط مزيفة).

---

## 2. البنية — Flow شاملة

```
topcinemaa.co
      │  1. SCRAPE (Puppeteer stealth) — يجمع روابط أفلام جديدة
      ▼
 فيلم URL
      │  2. DECODE (Puppeteer) — يدخل صفحة المشاهدة، يطلع iframe ديال streamwish
      │                        ويتحط HLS response watcher
      ▼
 m3u8 master URL
      │  3. TMDB — يحسب tmdbId (via API أو hash fallback)
      │  4. DEDUP — movieExists؟ ← يلا موجود، SKIP (ما يتعادش)
      ▼
 يلا جديد:
      │  5. DOWNLOAD (axios) — يقرا master.m3u8 → sub-playlist → ينزّل 627 segment
      │                        ويكتبهم concatenated فـ file.ts (retry ×5 لكل segment)
      ▼
 file.ts (637MB)
      │  6. REMUX (ffmpeg) — تحويل الحاوية TS → MP4 (بلا إعادة ترميز، stream copy)
      ▼
 file.mp4
      │  7. UPLOAD (موازي) — نفس الملف يرفع لـ 6 hosts في نفس الوقت
      │        streamwish | earnvids | uqload | vinovo | clicknupload | mixdrop
      ▼
 ملفات + filecodes
      │  8. SAVE — Turso: DB1 (فهرس) + DB2/DB3 (بيانات حسب التكافؤ ديال tmdbId)
      ▼
 state.json (فيلم معالج) + result.json (التفاصيل)
```

---

## 3. كيفاش كيخدّم بالتفصيل

### الخطوة 1 — SCRAPE (`scrapeTopcinemaaMovies`)
- يشغّل متصفح headless بـ `puppeteer-extra` + `stealth` (باش ما يتعرفش أنه أتمتة).
- يبدا من `state.currentPage` (كيحفظ آخر صفحة فين وصل).
- يفحص صفحات `/movies/` بانتظام `BATCH_SIZE` (الافتراضي `1`).
- كل رابط كيتعامل معاه بلا تكرار عبر `canonicalUrl()` (يزيل `/` فالآخر ويحيد URL encoding).
- كيرفض الأفلام المعالجة سابقًا (`state.processedMovies`).
- **لماذا**: باش كل تشغيل ياخذ فيلم واحد جديد فقط، بلا ما يعيد فيلم قديم.

### الخطوة 2 — DECODE (`extractMovieMetadataAndStream`)
- يدخل صفحة الفيلم، يتعرف على عنوان الفيلم من الـ URL slug (أضمن من الـ h1 اللي غالبًا هو header ديال الموقع).
- يدخل صفحة `/watch/`، يبعت AJAX request لـ `Server.php` باش يلقى iframe ديال السيرفر.
- يتحط **response listener** اللي كيلقط أي طلب `.m3u8` — ديالك رابط البث.
- **لماذا الـ listener؟** لأن مفتاح البث كيتولد ديناميكيًا فالـ browser، ما يمكنش نطلبوه مباشرة.

### الخطوة 3 — TMDB ID (`resolveTmdbId`)
- كينضف العنوان من الكلمات العربية الزائدة (`فيلم، مترجم، اون، لاين...`).
- يبحث فـ TMDB API (إذا `TMDB_API_KEY` موجود)؛ وإلا يستعمل **hash حتمي** (deterministic) على العنوان.
- **لماذا**: هو المفتاح اللي كيستخدم للتقسيم (sharding) فـ قاعدة البيانات.

### الخطوة 4 — DEDUP (`movieExists`)
- قبل ما يحمّل أي شيء، يفحص `movie_index` فـ DB1: `tmdb_id` أو العنوان المطابق.
- **مهم**: الأفلام اللي تسجلات قبل ما يتعاودوش ولا يحملوا — تقليل للوقت والفلوس.

### الخطوة 5 — DOWNLOAD (`downloadHlsToFile`)
- يقرا master playlist → يختار **أعلى variant بـ BANDWIDTH** (الفيديو الحقيقي، مش أول خط).
- **كشف مبكر (early-abort)**: بعد أول segment فقط، يحلّله بـ `ffprobe` — إذا كان كوديكس صورة (`png`/`mjpeg`...) معناها "سلايدشو صور" مش فيديو حقيقي → يوقف فورًا بلا ما ينزل 1GB.
- ينزل كل segment بـ `axios` مع هيدرات متصفح (Referer/Origin/UA) باش يتجاوز حماية CDN اللي كتحظر ffmpeg.
- **Retry ×5** لكل segment + **backpressure**.
- مثال حقيقي: 627 segment = **637MB** (The Currents — فيديو حقيقي).

### الخطوة 6 — REMUX + VALIDATE (`remuxTsToMp4` + `verifyFileIntegrity`)
استراتيجية من طبقتين + تحقق إجباري قبل الرفع:

**المسار 1 — Stream copy (سريع)**: إذا كان الإدخال أصلًا H.264 + AAC (الحالة العادية):
```
ffmpeg -y -i file.ts -c copy -bsf:a aac_adtstoasc -movflags +faststart file.mp4
```
- `-c copy`: بلا إعادة ترميز → سريع، خسارة صفر.
- `-bsf:a aac_adtstoasc`: يحول HE-AAC (ADTS) لـ AAC صالح فـ MP4.

**المسار 2 — Re-encode (مضمون 100%)**: يُستخدم إذا الإدخال مش H.264/AAC (مثل HEVC/VP9 أو صوت AC3/MP3)، أو إذا فشل التحقق من ناتج المسار 1، أو عند `FORCE_REENCODE=1`:
```
ffmpeg -y -i file.ts -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p \
       -c:a aac -b:a 128k -movflags +faststart file.mp4
```
- `libx264 -crf 23`: ترميز H.264 قياسي متوافق مع كل المتصفحات والأجهزة.
- `-pix_fmt yuv420p`: التوافق الكامل مع المتصفحات/الأجهزة.
- `-b:a 128k`: صوت AAC ثابت ومتوقع.

**التحقق (قبل الرفع)** — `verifyFileIntegrity(filePath)` بـ `ffprobe`:
- يتحقق أن في: فيديو صالح، مدة غير صفرية، بلا أخطاء صيغة.
- إذا فشل: يحذف الملف التالف (حفظ للـ bandwidth) ويمنع الرفع.
- إذا ffprobe غير متوفر: يعدّي بتحذير (لا يعطل البايبلاين).
- متغيرات تحكم: `FFMPEG_PRESET` (fast/medium)، `FFMPEG_CRF` (23-28)، `FORCE_REENCODE` (1 = إجبار إعادة الترميز).

**لماذا**: بدون تحويل/تحقق، الـ hosts كيستقبلو الملف لكن كيطلّعو encoding error أو يحذفوه (404) إذا كانت الحاوية مش معيارية.

### الخطوة 7 — UPLOAD (موازي)
- كل الـ hosts المستهدفين كيتشغلو بـ `Promise.all` (نفس الملف يرفع ليهم فـ نفس الوقت).
- كل host عندو طريقة رفع خاصة (فالقسم 5).
- Timeout ديال الرفع: `3600000ms` (ساعة) لكل محاولة، و 3 محاولات مع تأخير.

### الخطوة 8 — SAVE (Turso)
- `initTables()`: يضمن الجداول موجودة (schema v1 append-only).
- `saveMovieRecord()`: يضيف **row جديدة** فـ DB1 (فهرس) و فـ DB2 أو DB3 (حسب `tmdbId % 2`).
- الفيديوهات + `hosts_json` (كل النتائج) كيتخزنو JSON فـ `movie_data`.

---

## 4. ملفات المشروع

| ملف | الدور |
|------|-------|
| `script.js` | البايبلاين الرئيسي (740 سطر) |
| `turso.js` | اتصال بـ 3 قواعد + initTables + saveMovieRecord + movieExists |
| `config.json` | الـ hosts (API + key + type) + قواعد البيانات (url + token) |
| `state.json` | `currentPage` + قائمة الأفلام المعالجة |
| `result.json` | نتيجة آخر تشغيل (تفاصيل uploads) |
| `check-hosts.js` | تحليل من DB: نسبة نجاح/فشل كل host |
| `reset.js` | يمسح الجداول + يعيد تهيئة state |
| `.github/workflows/process-movies.yml` | cron 10x/day + تثبيت ffmpeg + تشغيل script |

---

## 5. طرق الرفع لكل Host (config → type)

| Host | type | الطريقة |
|------|------|---------|
| streamwish | `xfs` | GET `/upload/server` بـ key → POST file بـ `key` |
| earnvids | `xfs` | نفس الشيء |
| uqload | `xfs` | نفس الشيء |
| doodstream | `dood` | نفس الشيء لكن **يتطلب حساب premium صالح** |
| vinovo | `vinovo` | GET `/upload/server` بـ `key` → POST بـ `api_key` |
| clicknupload | `clickn` | GET `/upload/server` → POST بـ `sess_id` + `utype=prem` + حقل `file_0` |
| mixdrop | `mixdrop` | POST مباشر لـ `ul.mixdrop.ag/api` بـ `email` + `key` (ما عندوش remote upload) |

**خاصية `remote`**: `remote: true` = host كياخذ رابط m3u8 ويحملو هو بنفسو (`/upload/url`). `remote: false` = نحن نحملو ونرفعو الملف الحقيقي.

---

## 6. قواعد Turso (شاردنغ)

- **DB1 `movie_index`**: id AUTOINCREMENT، tmdb_id، title، target_db، created_at
- **DB2 / DB3 `movie_data`**: id AUTOINCREMENT، tmdb_id، title، movie_url، hls_url، hosts_json، created_at
- **توزيع**: `tmdbId` زوجي → DB2، فردي → DB3.
- **Append-only**: كل حفظ = row جديدة (ما يتعمر أي شيء، التاريخ كامل).
- **Dedup**: `movieExists` فـ DB1 قبل أي تحميل.

---

## 7. GitHub Actions (cron)

- `schedule`: ساعات `2,4,7,9,11,14,16,18,20,22` (10 مرات/يوم).
- يثبت `ffmpeg` + مكتبات Chrome، ثم `npm ci` ثم `node script.js`.
- بـ `BATCH_SIZE` (افتراضي `1`) — فيلم واحد كل تشغيل.
- بعد النجاح، `git-auto-commit` كيحدّث `state.json` و `result.json` تلقائيًا.

---

## 8. التاريخ / ليش الـ local upload هو الحل النهائي

1. **بدايات**: remote upload (`/upload/url`) — نرسل رابط m3u8 والـ host يحمل لوحدو.
   - المشكل: الـ hosts كيرجعو `filecode` لكن **ما كيخلقوش ملف فعلي**.
   - الدليل: كل الـ filecodes رجعو `Not found` / `404`، و `storage_used: 0`.
   - النتيجة: "Video encoding error" فجميع السيرفرات.
2. **تحليل**: الـ hosts ديال remote **ما كيشيفو ماشي m3u8** — كيحتاجو رابط فيديو مباشر (.mp4). الـ m3u8 هو playlist، ماشي فيديو.
3. **الحل**: نحن نحملو الفيديو محليًا (الوصول للمصدر مفتوح: master + segments = 200 بلا referer) ثم نحولوه لـ MP4 صحيح ثم نرفعوه كملف.
4. **النتيجة** (تجربة حقيقية — فيلم The Currents 2025):
   - 637MB download → remux → رفع لـ 6 hosts.
   - كل host ولّد `player_img` (صورة من الفيديو) + `file_length: 25` + نفس الحجم 668MB.
   - **الملفات حقيقية وقابلة للتشغيل** — 6/7 نجاح.
5. **doodstream وحده فاشل**: حساب عندو premium انتهى يوم 2026-08-03 → API كيرفض (`You are not allowed to upload files`). معطّل فـ config حتى يتجدد.

---

## 9. كيفاش تتحقق من النتيجة

### من الداتابيز (لحظي)
```bash
node check-hosts.js
```

### من API ديال أي host (يتأكد واش الملف موجود فعلًا)
```bash
node -e "const a=require('axios');a.get('https://streamhgapi.com/api/file/info?key=KEY&file_code=FILECODE').then(r=>console.log(r.data.result))"
```
- الملف موجود إذا ظهر `file_length` + `size` + `player_img`.

### روابط الاختبار (شوف الـ frames فالـ browser)
| Host | Embed URL |
|------|-----------|
| streamwish | `https://streamwish.fun/e/FILECODE` |
| earnvids | `https://earnvids.com/e/FILECODE` |
| uqload | `https://uqload.to/e/FILECODE` |
| vinovo | `https://vinovo.to/e/FILECODE` |
| clicknupload | `https://clicknupload.click/FILECODE` |
| mixdrop | `https://mixdrop.top/e/FILECODE` |

---

## 10. التشغيل المحلي (Windows)

```powershell
# 1. تثبيت ffmpeg إذا ما كانش
winget install --id Gyan.FFmpeg -e

# 2. تشغيل فيلم واحد
$env:BATCH_SIZE = "1"
$env:TARGET_BASE_URL = "https://topcinemaa.co/"
node script.js
```

---

## 11. Troubleshooting

| المشكل | السبب | الحل |
|--------|-------|------|
| `You are not allowed to upload files` (dood) | premium منتهي | جدّد الاشتراك ثم حيد `"enabled": false` من config |
| "مصدر صور PNG" (early-abort) | الأفلام الجديدة فـ topcinemaa/streamwish كايتقدّمو كـ سلايدشو صور (BANDWIDTH < 1Mbps) | **مشكل من المصدر** — ما يمكنش لأي remux/encode يصلحو. البايبلاين كيكشفو فـ أول segment ويسجل الفيلم كـ skipped. انتظر فيلم حقيقي. |
| كل hosts "Video encoding error" | رفع remote بـ m3u8 | تأكد `remote: false` لكل hosts (local upload) |
| الملف ماشي موجود فـ DB | نفس الفيلم مسجل قبل | `check-hosts.js` + `movieExists` |
| `ORIG_HEAD broken` (git) | ref تلف | اكتب `ref: refs/heads/main` فـ `.git/ORIG_HEAD` |
| الفيلم "قاصر" (مدة قصيرة) | topcinemaa عرض نسخة مختصرة | بلا حل من جهتنا — مصدر الموقع |
| Local download فاشل | segment فاشل من 5 محاولات | يعاود تلقائيًا فالتشغيل الجاي |

---

## 12. إعادة البدء من الصفر

```bash
node reset.js   # يمسح الجداول + state
```
> انتبه: بعدها كل الأفلام القديمة كتعاود ترفع من جديد (dedup كيضيع).
