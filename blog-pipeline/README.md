# Angler BI — Blog Pipeline

Automated content system: picks a topic, researches it, writes a full SEO article, generates images via Google Imagen 4, and publishes to the site.

---

## Setup

```bash
cd blog-pipeline
npm install
cp .env.example .env   # then fill in your keys
```

### Required API Keys (in `.env`)

| Key | Purpose | Get It |
|-----|---------|--------|
| `ANTHROPIC_API_KEY` | Article writing via Claude Sonnet | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| `TAVILY_API_KEY` | Real-time web research | [app.tavily.com](https://app.tavily.com) |
| `GOOGLE_AI_API_KEY` | Image generation via Imagen 4 | [aistudio.google.com](https://aistudio.google.com/app/apikey) |

### Recommended

| Key | Purpose |
|-----|---------|
| `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` | Keyword research & SERP analysis |
| `FIRECRAWL_API_KEY` | Competitor content scraping |

> ⚠️ **Never commit `.env`** — it's gitignored. All keys load from environment at runtime.

---

## Commands

| Command | What it does |
|---------|-------------|
| `npm run onboard` | Scrapes site, saves business profile to `blog-config.json` |
| `npm run intelligence` | Keyword research → fills `content_pipeline.queue` |
| `npm run write` | Writes the next queued article |
| `npm run weekly` | Full weekly run: picks topic, writes, updates blog index |

---

## Weekly Automation

Runs every **Monday at 8am** via the Cowork scheduled task.

Prompt lives at: `blog-pipeline/cowork-task-prompt.md`

The task:
1. Reads `blog-config.json` for the next queued topic (or generates one from the weekly rotation)
2. Researches the topic via web search
3. Writes the full article + generates 2 Imagen 4 images
4. Creates `blog/articles/{slug}/` with `index.html`, `article.md`, `publish-kit.md`, `images/`
5. Updates `blog/index.html` with the new article card
6. Commits and pushes to `main` → GitHub Pages auto-deploys

Run manually: `npm run weekly`

---

## Weekly Topic Rotation (when queue is empty)

| Week | Theme |
|------|-------|
| 1 | AI in Business Intelligence |
| 2 | BI Strategy / Data Governance |
| 3 | Power BI Tips & Features |
| 4 | Predictive Analytics / ML Use Cases |

Override any run: `node step3-content-engine.js --keyword="your keyword"`

---

## Article Output Structure

```
blog/articles/{slug}/
  index.html       — publish-ready HTML (served by GitHub Pages)
  article.md       — raw Markdown (CMS import / reference)
  publish-kit.md   — meta description, keyword, checklist
  images/
    image-0.png    — Imagen 4 generated header image
    image-1.png    — Imagen 4 generated inline image
```

---

## Utility Scripts

| Script | Purpose |
|--------|---------|
| `test-imagen.js` | Regenerate images for an existing article |
