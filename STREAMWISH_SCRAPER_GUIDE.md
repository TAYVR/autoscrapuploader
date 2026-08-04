# 🎬 StreamWish Movie Scraper Guide (Pagination & StreamWish Frame Only)

دليل ومجزوءة كود بالـ Python كتقوم بسكراب **الأفلام فقط** عبر التنقل فـ الـ **Pagination**، وتستخرج **رابط الـ Iframe الخاص بـ StreamWish حصرياً**.

---

## 📋 مميزات هذا السكربت:
1. **الأفلام فقط:** استهداف تصفح `/movies/` وتصفية الروابط التي تحتوي على `فيلم-`.
2. **الـ Pagination:** التناوب على الصفحات تلقائياً (`page/1/`, `page/2/`, ...).
3. **تحديد StreamWish حصرياً:** فحص سيرفرات المشاهدة عبر AJAX وتصفية السيرفر الخاص بـ **StreamWish**.
4. **تخزين نقي:** حفظ النتيجة فـ `streamwish_movies.json`.

---

## 💻 1. الكود الكامل للسكربت (`streamwish_scraper.py`)

```python
import json
import time
import random
import logging
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, unquote

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class StreamWishMovieScraper:
    def __init__(self, base_url="https://topcinemaa.co"):
        self.base_url = base_url
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
            "Referer": "https://www.google.com/"
        })

    def fetch(self, url, retries=3):
        """طلب الصفحة مع مهلة عشوائية لتفادي البلوك"""
        time.sleep(random.uniform(1.5, 3.5))
        for attempt in range(retries):
            try:
                resp = self.session.get(url, timeout=15)
                if resp.status_code == 200:
                    return resp.text
            except Exception as e:
                logger.error(f"Error fetching {url}: {e}")
                time.sleep(1)
        return None

    def get_movie_links_from_page(self, page_number):
        """1️⃣ جلب روابط الأفلام فقط من صفحة الـ Pagination"""
        page_url = f"{self.base_url}/movies/" if page_number == 1 else f"{self.base_url}/movies/page/{page_number}/"
        logger.info(f"🔎 Scanning Page {page_number}: {page_url}")
        
        html = self.fetch(page_url)
        if not html:
            return []

        soup = BeautifulSoup(html, "html.parser")
        links = []
        cards = soup.select("div.Block--Item a, div.Small--Box a, .box-item a, article a, .movie-item a")
        
        for a in cards:
            href = a.get("href")
            if not href:
                continue
            abs_url = urljoin(self.base_url, href)
            # تصفية الأفلام فقط (تستبعد الترقيم، الأقسام والمسلسلات)
            if "/%d9%81%d9%8a%d9%84%d9%85-" in abs_url or "/فيلم-" in unquote(abs_url):
                if not any(x in abs_url for x in ["/page/", "/category/", "/genre/", "/series/"]):
                    links.append(abs_url)

        return list(set(links))

    def extract_iframe_url(self, data_id, server_num, referer):
        """حل رابط الـ iframe عبر AJAX"""
        ajax_url = f"{self.base_url}/wp-content/themes/movies2023/Ajaxat/Single/Server.php"
        headers = {
            "X-Requested-With": "XMLHttpRequest",
            "Referer": referer,
            "Origin": self.base_url,
        }
        try:
            resp = self.session.post(ajax_url, data={"id": data_id, "i": server_num}, headers=headers, timeout=10)
            if resp.status_code == 200:
                soup = BeautifulSoup(resp.text, "html.parser")
                iframe = soup.find("iframe")
                if iframe:
                    return iframe.get("src")
        except Exception as e:
            logger.error(f"Error AJAX for server {server_num}: {e}")
        return None

    def get_streamwish_url(self, movie_url):
        """2️⃣ الدخول لصفحة الفيلم واستخراج رابط StreamWish حصرياً"""
        html = self.fetch(movie_url)
        if not html:
            return None, None

        soup = BeautifulSoup(html, "html.parser")

        # استخراج عنوان الفيلم
        title_tag = soup.select_one("h1.post-title, .MasterSingleMeta h1, h1")
        title = title_tag.get_text(strip=True) if title_tag else "Unknown Movie"

        # التحقق من وجود زر "مشاهدة" ينقل لصفحة السيرفرات
        watch_a = soup.select_one("a.watch, a[href*='/watch/']")
        watch_url = urljoin(self.base_url, watch_a.get("href")) if watch_a else movie_url
        
        if watch_url != movie_url:
            html = self.fetch(watch_url)
            if not html:
                return title, None
            soup = BeautifulSoup(html, "html.parser")

        # البحث فـ السيرفرات عن StreamWish
        server_items = soup.select(".watch--servers--list ul li, .servers-list li, li[data-id][data-server]")
        
        streamwish_iframe = None
        for item in server_items:
            server_name = item.get_text(strip=True)
            server_id = item.get("data-id")
            server_num = item.get("data-server")

            if server_id and server_num:
                # فحص هل اسم السيرفر يحتوي على StreamWish
                if "streamwish" in server_name.lower() or "wish" in server_name.lower():
                    iframe_src = self.extract_iframe_url(server_id, server_num, watch_url)
                    if iframe_src:
                        streamwish_iframe = iframe_src
                        break

        # فحص إضافي: إذا لم يجد الاسم صراحةً، يجرب السيرفرات ويتحقق من رابط الـ iframe
        if not streamwish_iframe:
            for item in server_items:
                server_id = item.get("data-id")
                server_num = item.get("data-server")
                if server_id and server_num:
                    iframe_src = self.extract_iframe_url(server_id, server_num, watch_url)
                    if iframe_src and ("streamwish" in iframe_src.lower() or "strwish" in iframe_src.lower()):
                        streamwish_iframe = iframe_src
                        break

        return title, streamwish_iframe

    def scrape_movies(self, start_page=1, max_pages=5):
        """3️⃣ الـ Loop الرئيسي للتنقل عبر الـ Pagination"""
        results = []
        
        for current_page in range(start_page, max_pages + 1):
            movie_links = self.get_movie_links_from_page(current_page)
            if not movie_links:
                logger.info(f"No movies found on page {current_page}. Stopping.")
                break

            for link in movie_links:
                logger.info(f"🎬 Processing: {link}")
                title, streamwish_url = self.get_streamwish_url(link)
                
                if streamwish_url:
                    logger.info(f"✅ Found StreamWish: {streamwish_url}")
                    results.append({
                        "title": title,
                        "streamwish_url": streamwish_url,
                        "movie_url": link
                    })
                else:
                    logger.warning(f"⚠️ No StreamWish server for: {title}")

        # حفظ النتائج
        with open("streamwish_movies.json", "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)

        logger.info(f"🎉 Done! Scraped {len(results)} movies with StreamWish links.")
        return results


if __name__ == "__main__":
    scraper = StreamWishMovieScraper()
    # سكراب أول 5 صفحات كمثال (تقدر تبدل max_pages للعدد لي بغيتي)
    scraper.scrape_movies(start_page=1, max_pages=5)
```

---

## ⚙️ كيف يعمل السكربت؟

1. **`get_movie_links_from_page(page)`**:
   - يدخل لـ `https://topcinemaa.co/movies/page/{page}/`
   - يستخرج روابط الأفلام الحقيقية فقط ويستبعد المسلسلات والأقسام.

2. **`get_streamwish_url(movie_url)`**:
   - يدخل لصفحة الفيلم أو صفحة المشاهدة الخاصة به.
   - يقرأ سيرفرات المشاهدة (`li` elements).
   - يبعث Request لـ AJAX Endpoint (`Server.php`) للحصول على الـ `iframe`.
   - يتحقق من السيرفر هل هو **StreamWish** (`streamwish` فـ اسم السيرفر أو فـ رابط الـ iframe).

3. **`scrape_movies(start_page, max_pages)`**:
   - يتنقل أوتوماتيكياً فـ **Pagination** من الصفحة الأولى لـ الصفحة المحددة.
   - يحفظ فقط الأفلام لي فيها رابط **StreamWish** فـ ملف `streamwish_movies.json`.
