# RideCompare — Deploy to Railway

Railway gives you a free hosted URL in about 5 minutes. No credit card required.

---

## Step 1 — Put the code on GitHub

1. Go to https://github.com and create a free account if you don't have one.
2. Click **New repository**, name it `ride-compare`, make it **Private**, click **Create**.
3. Download and install **GitHub Desktop** from https://desktop.github.com
4. In GitHub Desktop: **File → Add Local Repository** → select the `ride-compare-server` folder.
5. Click **Publish repository** → uncheck "Keep this private" if you want, then **Publish**.

---

## Step 2 — Deploy on Railway

1. Go to https://railway.app and sign in with your GitHub account.
2. Click **New Project → Deploy from GitHub repo**.
3. Select your `ride-compare` repository.
4. Railway will detect the Dockerfile and start building. Takes about 3–5 minutes.
5. Once deployed, click **Settings → Networking → Generate Domain**.
   You'll get a URL like `https://ride-compare-production-xxxx.up.railway.app`
6. Open that URL on your phone or desktop — your app is live!

---

## Step 3 — If prices don't load (login required)

Uber and Lyft may require you to be logged in to show prices.
If the app shows "Login required", do the following once:

### Get your Uber cookies
1. Open Chrome on your computer and go to https://m.uber.com
2. Log in normally.
3. Press **F12** to open DevTools → click **Network** tab.
4. Reload the page (Ctrl+R or Cmd+R).
5. Click any request in the list that goes to `m.uber.com`.
6. On the right, under **Request Headers**, find the line starting with `Cookie:`.
7. Copy everything after `Cookie:` — it's a long string of `name=value; name=value; ...`

### Get your Lyft cookies
Same steps but on https://ride.lyft.com after logging in.

### Add cookies to Railway
1. In Railway, open your project → **Variables** tab.
2. Add a new variable: **Name** = `UBER_COOKIES`, **Value** = the cookie string you copied.
3. Add another: **Name** = `LYFT_COOKIES`, **Value** = the Lyft cookie string.
4. Railway will automatically restart your server with the new values.

> **Note:** Session cookies expire periodically (usually weeks or months).
> If prices stop loading again, repeat this process to refresh them.

---

## Add to your phone home screen

### iPhone (Safari)
1. Open your Railway URL in Safari.
2. Tap the **Share** button (box with arrow) → **Add to Home Screen**.
3. The app appears on your home screen and works like a native app.

### Android (Chrome)
1. Open your Railway URL in Chrome.
2. Tap the **three-dot menu** → **Add to Home screen**.

---

## Costs

Railway's free Hobby tier includes $5/month of free credits, which is more than enough
for personal use. The app uses minimal resources.

---

## Troubleshooting

**"Application failed to respond"** — The container is still building. Wait 2 minutes and reload.

**"No prices found"** — Uber or Lyft changed their webpage layout. The scraper selectors
may need updating. Open an issue or contact whoever set this up.

**Prices stop loading after a few weeks** — Your session cookies expired. Repeat Step 3.
