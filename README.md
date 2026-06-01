# PPC Inbox Command Center

Paradise Patio Covers — Gmail + Google Drive business tool.

## Deploy to Vercel (step by step)

### 1. Get the code onto GitHub
- Go to https://github.com and create a free account if you don't have one
- Click **New repository**, name it `ppc-inbox-app`, set it to Private, click Create
- Upload all these files by dragging them into the GitHub file uploader

### 2. Deploy on Vercel
- Go to https://vercel.com and sign in with your GitHub account
- Click **Add New Project**
- Select your `ppc-inbox-app` repository
- Vercel auto-detects Vite — no settings to change
- Click **Deploy**

### 3. Add your Anthropic API key
- In Vercel dashboard → your project → **Settings** → **Environment Variables**
- Add: `VITE_ANTHROPIC_API_KEY` = your key from https://console.anthropic.com
- Go to **Deployments** and click **Redeploy**

### 4. Open on your phone
- Your app will be live at `https://ppc-inbox-app.vercel.app`
- On iPhone: open in Safari → Share → **Add to Home Screen**
- It will open full-screen like a native app

## Local development
```bash
npm install
npm run dev

```
