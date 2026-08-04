# 🛠️ كيفاش تصايب مشروع بحال هذا من الصفر (من زيرو لـ 100%)

> هذا ملف تعليمي كامل: خطوة بخطوة، كيفاش تبني نظام استخراج + تحميل + رفع فيديوهات من أي موقع بث، مثل اللي عندنا دابا.
> كل مرحلة فيها: **الفكرة** → **الكود** → **كيفاش تجربو**.

---

## 🗺️ الخريطة الكاملة — 3 نظم فـ مشروع واحد

```
┌─────────────────────────────────────────────────────────┐
│  ① Backend API (Express + Puppeteer)                    │
│     → يستخرج .m3u8 من صفحات البث                       │
│     → Proxy يتجاوز CORS و 403                          │
├─────────────────────────────────────────────────────────┤
│  ② GitHub Actions Pipeline                              │
│     → يستخرج → يحمل ب ffmpeg → يرفع لـ 7 hosts         │
│     → يرجع result.json                                 │
├─────────────────────────────────────────────────────────┤
│  ③ React Player                                         │
│     → hls.js يستقبل الـ m3u8 ويعاود تشغيلو             │
└─────────────────────────────────────────────────────────┘
```

---

# ⚙️ المرحلة ① — Backend API (Express + Puppeteer)

## 1.1 إعداد المشروع

```bash
mkdir stream-project
cd stream-project
npm init -y
npm install express puppeteer-extra puppeteer-extra-plugin-stealth axios
npx puppeteer browsers install chrome   # تثبيت Chrome للمتصفح المخفي
```

## 1.2 السيرفر الأساسي (فهم من بعد تنفيذ)

```js
const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());   // ⭐ يخفي الأثر: navigator.webdriver

const app = express();
app.use(express.json());

app.listen(3000, () => console.log('Server on :3000'));
```

## 1.3 الـ Extraction — القطعة الأساسية

**الفكرة:** ما نبحثوش على الـ video فـ HTML. **نستمع للشبكة** — أي طلب يطلبو الـ player من CDN، نلتقطوه.

```js
async function extractM3u8(pageUrl) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await browser.newPage();
    const found = new Set();

    // ⭐ الاستماع للشبكة
    page.on('response', (res) => {
      const url = res.url();
      const type = (res.headers()['content-type'] || '').toLowerCase();

      // نلتقط: .m3u8 / master.txt / content-type mpegurl
      if (url.includes('.m3u8') || url.includes('master.txt') ||
          type.includes('mpegurl') || type.includes('m3u8')) {
        found.add(url);
        console.log('[HLS]', url);
      }
    });

    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // ⭐ نشغل الفيديو (muted) باش الـ CDN يبدا يبعت الـ playlist
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) { v.muted = true; v.play().catch(() => {}); }
    });

    await new Promise(r => setTimeout(r, 5000));  // نعطيوه وقت

    return found.size > 0 ? [...found][0] : null;
  } finally {
    await browser.close();
  }
}
```

**نصائح أساسية للـ extraction:**
| الحالة | الحل |
|---|---|
| الـ m3u8 مخفي بـ `.txt` | التقط من الـ Content-Type ماشي غير الامتداد |
| الـ video ما بداش | `video.play()` مختوم (autoplay policy) |
| anti-bot يكتشفنا | stealth plugin + User-Agent حقيقي |
| الصفحة بطيئة | `waitUntil: 'networkidle2'` + timeout كبير |

## 1.4 الـ Proxy — باش نتجاوزو 403 و CORS

**الفكرة:** المتصفح ديال العميل ما يطلبش من الـ CDN مباشرة. يطلب من سيرفرنا، والسيرفر كايتجاوب مع الـ CDN ب headers صحيحة (Referer + Origin).

```js
app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  const referer = req.query.referer;

  const headers = {
    'Referer': referer,               // ⭐ المصدر المطلوب
    'Origin': new URL(referer).origin, // ⭐ المصدر المطلوب
    'User-Agent': 'Mozilla/5.0 ... Chrome/124.0.0.0',
  };

  const response = await axios({
    url: target, headers, responseType: 'stream',
    maxContentLength: Infinity, maxBodyLength: Infinity,
  });

  // إذا كان m3u8 → نعيد كتابة URLs داخله باش تجري عبر الـ proxy
  // إذا كان .ts → نمرره كما هو
  response.data.pipe(res);
});
```

**إعادة كتابة الـ m3u8 (مهم جداً):**

```js
// داخل الـ playlist، كل segment:
//   segment_001.ts
// يتحول إلى:
//   /proxy?url=https://cdn.../segment_001.ts&referer=...
const lines = body.split('\n').map((line) => {
  if (line.trim().startsWith('#')) return line;   // tags، نتركها
  const full = new URL(line, m3u8Url).href;        // URL كامل
  return `/proxy?url=${encodeURIComponent(full)}&referer=${referer}`;
});
```

## 1.5 الـ Player — HTML بـ hls.js

```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<video id="video" controls autoplay></video>

<script>
  var hls = new Hls();
  hls.loadSource('/proxy?url=...m3u8');   // عبر الـ proxy ديالنا
  hls.attachMedia(document.getElementById('video'));
</script>
```

---

# 🔄 المرحلة ② — GitHub Actions Pipeline

## 2.1 الملف `.github/workflows/process-video.yml`

```yaml
name: Process Video

on:
  workflow_dispatch:
    inputs:
      url:
        description: 'Link dyal صفجة البث'
        required: true

jobs:
  process:
    runs-on: ubuntu-latest
    timeout-minutes: 180
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install FFmpeg + Chrome libs
        run: |
          sudo apt-get update
          sudo apt-get install -y ffmpeg libnss3 libasound2t64 libgbm1

      - run: npm install
      - run: npx puppeteer browsers install chrome

      - run: node script.js
        env:
          TARGET_URL: ${{ github.event.inputs.url }}

      - uses: actions/upload-artifact@v4
        with:
          name: result
          path: result.json
```

## 2.2 التحميل بـ ffmpeg

```js
const { spawn } = require('child_process');

function download(m3u8Url, referer) {
  return new Promise((resolve, reject) => {
    // ⭐ Referer مطلوب باش الـ CDN ما يعطي 403
    const headers = `Referer: ${referer}\r\nUser-Agent: Mozilla/5.0\r\n`;

    const args = [
      '-y', '-headers', headers, '-i', m3u8Url,
      '-c', 'copy',                    // بدون إعادة ترميز = أسرع
      '-bsf:a', 'aac_adtstoasc',       // إصلاح الصوت TS→MP4
      'output.mp4',
    ];

    const proc = spawn('ffmpeg', args);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg failed')));
  });
}
```

## 2.3 الـ upload للـ hosts (XFileSharing standard)

**الفكرة:** أغلب مواقع الرفع عندها نفس البنية (XFileSharing). خطوتين:

```js
// ① احصل على الـ upload server
const server = await axios.get(`${apiBase}/upload/server`, {
  params: { key: API_KEY },
});
// → { result: "https://s1.host.com/upload/01" }

// ② ارفع الملف (Streaming — مهم لملفات 1GB+)
const form = new FormData();
form.append('file', fs.createReadStream('output.mp4'));  // ⭐ stream ماشي readFileSync
form.append('key', API_KEY);

const res = await axios.post(server.data.result, form, {
  headers: form.getHeaders(),
  maxContentLength: Infinity,   // ⭐ لملفات كبيرة
  maxBodyLength: Infinity,      // ⭐ لملفات كبيرة
  timeout: 3600000,             // ⭐ ساعة
});
```

**لماذا stream؟** `fs.readFileSync` كايحمل الملف كامل فالـ RAM — ملف 2GB = انهيار Node. أما `createReadStream` كايقسم الملف ويتصيفط chunk بـ chunk.

## 2.4 الفرق بين الـ hosts (من تجربتنا)

| Host | الـ field ديال الـ key | الـ Response shape |
|---|---|---|
| StreamWish / EarnVids / Uqload | `key` | `{ files: [{ filecode }] }` |
| DoodStream | `api_key` | `{ result: { filecode } }` |
| Vinovo | `api_key` | `{ result: [{ embed_url, download_url, filecode }] }` |
| ClicknUpload | `sess_id` + `utype=prem` + `file_0` | `[{ file_code, file_status }]` |
| MixDrop | `email` + `key` | `{ result: { fileref, url, embedurl } }` |

> **درس مهم:** حتى غا الدوكس الرسمية، كا نتستاهل live كل host قبل ما نكتب الكود. فاش كايكتبو الدوكس `key` وكايكون الواقع `api_key` — التجربة هي الحقيقة.

## 2.5 الـ Cleanup

```js
fs.unlinkSync('output.mp4');  // ⭐ حرر الـ storage ديال الـ runner
```

---

# ⚛️ المرحلة ③ — React Player

```jsx
import Hls from 'hls.js';
import { useRef, useEffect } from 'react';

export default function Player({ m3u8Url }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (!Hls.isSupported()) return;
    const hls = new Hls();
    hls.loadSource(m3u8Url);       // مرّر من خلال الـ proxy
    hls.attachMedia(videoRef.current);
    return () => hls.destroy();
  }, [m3u8Url]);

  return <video ref={videoRef} controls autoPlay style={{ width: '100%' }} />;
}
```

---

# 🧠 الدروس الجوهرية (الـ fundamentals)

## 1. Network Interception > DOM scraping

```js
// ❌ ضعيف: البحث فـ HTML
const src = document.querySelector('video').src;  // كايجي blob: ولا فارغ

// ✅ قوي: الاستماع للشبكة
page.on('response', res => { ... });  // كايلقط حتى الـ URLs المخفية
```

## 2. الـ Stealth — كيفاش يخفي الأثر

| الأثر | لاش كايكتشفونا |
|---|---|
| `navigator.webdriver` | بغينا نصبحو `undefined` |
| الـ UA ديال HeadlessChrome | نبدلوه بـ UA حقيقي |
| الـ automation لوغو | `--disable-blink-features=AutomationControlled` |

## 3. الـ 403 — كيفاش يتجاوز

```
المتصفح → سيرفرنا (بلا مشاكل) → CDN ب Referer صحيح → 200 OK
```

## 4. الملفات الكبيرة — القواعد الثلاثة

```js
fs.createReadStream()  // ① stream ماشي readFileSync
maxContentLength: Infinity  // ②
maxBodyLength: Infinity     // ③
timeout: 3600000            // ساعة، ماشي 30 ثانية
```

## 5. الـ try/catch لكل host

```js
for (const host of HOSTS) {
  try { await upload(host); }      // كل host معزول
  catch (e) { console.error(e); }  // فشل واحد ما يوقفش الباقي
}
```

---

# 🎯 الخلاصة — المخطط الذهني

```
تبني نظام مثل هذا = 4 قدرات:

① استماع للشبكة          → page.on('response')
② تزييف الهوية           → stealth + UA + Referer
③ تحويل الملفات          → ffmpeg -c copy
④ رفع متعدد بالموازاة     → XFileSharing generic + try/catch
```

إذا فهمت هاد الأربعة، تقدر تصايب أي نظام استخراج/رفع فيديوهات في العالم. كل موقع كايكون غير مشكلة صغيرة في التطبيق، لكن الفكرة نفسها باقية نفسها.
