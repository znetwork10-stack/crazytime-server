# 🎰 Crazy Time Live Scraper Server

שרת Node.js שגורף תוצאות חיות מ-trackcasinos.com באמצעות Puppeteer (Chrome headless).

## למה צריך את זה?
האתרים שמציגים תוצאות Crazy Time משתמשים ב-JavaScript rendering — אי אפשר לגרוף אותם ישירות מהדפדפן בגלל CORS וגם כי ה-HTML הראשוני ריק. שרת זה מריץ דפדפן אמיתי, מחכה ש-JS יטען את התוצאות, ואז מחזיר אותן כ-JSON נקי.

## 🚀 דיפלוי על Render.com (חינם, 5 דקות)

1. **צור חשבון**: היכנס ל-[render.com](https://render.com) והתחבר עם GitHub.

2. **העלה את הקוד ל-GitHub**:
   ```bash
   cd ct-server
   git init
   git add .
   git commit -m "Initial commit"
   gh repo create ct-server --public --source=. --push
   ```
   (או צור repo ב-GitHub UI ודחוף ידנית)

3. **ב-Render**: לחץ "New +" → "Web Service" → בחר את ה-repo.

4. **הגדרות**:
   - Runtime: **Node**
   - Build Command: `npm install && npx puppeteer browsers install chrome`
   - Start Command: `npm start`
   - Plan: **Free**
   - Environment Variable: הוסף `PUPPETEER_CACHE_DIR` = `/opt/render/.cache/puppeteer`

5. **Deploy** → המתן ~5 דק׳. תקבל URL כמו `https://crazytime-scraper.onrender.com`

## 📡 שימוש

```bash
# Health check
curl https://YOUR-APP.onrender.com/api/health

# Get latest results
curl https://YOUR-APP.onrender.com/api/results

# Force refresh
curl https://YOUR-APP.onrender.com/api/refresh
```

תגובה לדוגמה:
```json
{
  "results": [
    {"result": "1", "time": "21:03:14"},
    {"result": "Coin Flip", "time": "21:03:42"},
    {"result": "5", "time": "21:04:12"}
  ],
  "lastUpdate": "2026-04-24T21:04:30.123Z",
  "error": null
}
```

## ⚙️ עדכון הדשבורד

בקובץ ה-React (Artifact), שנה את `SERVER_URL` לכתובת שקיבלת מ-Render.

## 🐛 בעיות נפוצות

- **"Free plan נרדם אחרי 15 דק'"**: אם יש לך 5$/חודש שווה לשלם על plan Starter שלא נרדם. או השתמש ב-cron-job.org שיעשה ping כל 10 דק' לכתובת `/api/health`.
- **"Puppeteer install נכשל"**: ודא שה-Build Command כולל `npx puppeteer browsers install chrome`.
- **"אין תוצאות"**: ייתכן שהאתר שינה את ה-DOM. בדוק את הלוגים ב-Render — ה-`debug` field יראה מה Puppeteer רואה.

## 🔒 אזהרת אחריות
כלי זה לחילוץ נתונים פומביים בלבד. כיבוד תנאי השימוש של trackcasinos.com באחריותך. עשה שימוש מתון (rate limit מובנה: בקשה כל 8 שניות).
