#!/usr/bin/env node
/**
 * ANGLER BI — Weekly Blog Runner
 * ─────────────────────────────────────────────────────────
 * Scheduled by Cowork to run every Monday at 8am.
 * Picks the next article from the queue, runs the content
 * engine, then updates the blog index.
 *
 * Topics auto-rotate:
 *  - Week 1: AI in Business Intelligence / AI news
 *  - Week 2: BI fundamentals / data strategy
 *  - Week 3: Power BI / tooling deep dive
 *  - Week 4: Predictive analytics / use case
 *
 * Run manually: node weekly-runner.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const CONFIG_PATH  = path.join(__dirname, 'blog-config.json');
const ARTICLES_DIR = path.join(__dirname, '..', 'blog', 'articles');
const BLOG_INDEX   = path.join(__dirname, '..', 'blog', 'index.html');

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg.api_keys = {
    anthropic_api_key:   process.env.ANTHROPIC_API_KEY   || '',
    tavily_api_key:      process.env.TAVILY_API_KEY       || '',
    dataforseo_login:    process.env.DATAFORSEO_LOGIN     || '',
    dataforseo_password: process.env.DATAFORSEO_PASSWORD  || '',
    firecrawl_api_key:   process.env.FIRECRAWL_API_KEY    || '',
    openai_api_key:      process.env.OPENAI_API_KEY       || '',
    youtube_data_api_key: process.env.YOUTUBE_DATA_API_KEY || '',
  };
  return cfg;
}
function saveConfig(c) {
  const { api_keys, ...safe } = c;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(safe, null, 2));
}

// ── Topic rotation: AI/BI news when no keyword queue ─────────────────────────
const ROTATION_TOPICS = [
  { theme: 'AI in BI', query: 'latest AI advancements in business intelligence 2026' },
  { theme: 'BI Strategy', query: 'business intelligence best practices data strategy 2026' },
  { theme: 'Power BI', query: 'Power BI tips advanced features 2026' },
  { theme: 'Predictive Analytics', query: 'predictive analytics business use cases 2026' }
];

async function getWeeklyTopic(cfg, claude) {
  // First: use pipeline queue if populated
  const pending = cfg.content_pipeline?.queue?.find(q => q.status === 'pending');
  if (pending) return pending;

  // Fallback: generate a fresh AI/BI news topic via Tavily + Haiku
  const weekOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / (7 * 24 * 3600 * 1000));
  const rotation = ROTATION_TOPICS[weekOfYear % ROTATION_TOPICS.length];

  console.log(`📡  No queue — generating AI/BI news topic (${rotation.theme})...`);

  let news = [];
  const tavilyKey = cfg.api_keys.tavily_api_key;
  if (tavilyKey) {
    try {
      const resp = await axios.post('https://api.tavily.com/search', {
        api_key: tavilyKey,
        query: rotation.query,
        search_depth: 'advanced',
        max_results: 8,
        include_answer: true
      });
      news = resp.data.results || [];
    } catch (e) {
      console.warn('  ⚠️  Tavily search failed:', e.message);
    }
  }

  // Ask Haiku to synthesize a fresh angle
  const resp = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `You are an SEO strategist for Angler BI, a BI consulting firm in Miami.

Recent news headlines for "${rotation.theme}":
${news.map(n => `- ${n.title}`).join('\n') || '(No headlines available — use industry knowledge)'}

Suggest ONE timely blog post angle that:
1. Covers real recent developments (name specific tools, companies, or trends)
2. Ties back to business intelligence / data strategy
3. Is relevant to executives and data leaders
4. Has SEO potential (people are actively searching for this)

Return JSON: {"keyword": "2-5 word target keyword", "title": "SEO blog title 50-65 chars", "stage": "TOFU|MOFU|BOFU", "cluster": "${rotation.theme}", "angle": "one sentence describing the unique angle"}`
    }]
  });

  try {
    const text = resp.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const topic = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (topic) {
      console.log(`  Generated topic: "${topic.title}"`);
      return topic;
    }
  } catch (e) {}

  // Last resort fallback
  return {
    keyword: rotation.query,
    title: `${rotation.theme}: What Business Leaders Need to Know in 2026`,
    stage: 'TOFU',
    cluster: rotation.theme
  };
}

// ── Rebuild blog index ────────────────────────────────────────────────────────
function rebuildBlogIndex(cfg) {
  const published = cfg.content_pipeline?.published || [];
  if (!published.length || !fs.existsSync(BLOG_INDEX)) return;

  console.log('\n🔄  Updating blog/index.html...');

  let indexHtml = fs.readFileSync(BLOG_INDEX, 'utf8');

  // Build article cards HTML
  const cards = [...published].reverse().map(p => {
    const articleDir = path.join(ARTICLES_DIR, p.slug);
    const kitPath = path.join(articleDir, 'publish-kit.md');
    let meta = '';
    if (fs.existsSync(kitPath)) {
      const kit = fs.readFileSync(kitPath, 'utf8');
      const metaMatch = kit.match(/\*\*Meta Description\*\*: (.+)/);
      meta = metaMatch ? metaMatch[1] : '';
    }
    return `    <article class="blog-card">
      <div class="blog-card-body">
        <span class="blog-card-category">${p.cluster || 'Business Intelligence'}</span>
        <h3 class="blog-card-title"><a href="/blog/articles/${p.slug}/">${p.title}</a></h3>
        <p class="blog-card-excerpt">${meta}</p>
        <time class="blog-card-date">${new Date(p.published).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</time>
      </div>
    </article>`;
  }).join('\n');

  // Replace article grid content
  indexHtml = indexHtml.replace(
    /<!-- ARTICLES_START -->[\s\S]*?<!-- ARTICLES_END -->/,
    `<!-- ARTICLES_START -->\n${cards}\n    <!-- ARTICLES_END -->`
  );

  fs.writeFileSync(BLOG_INDEX, indexHtml);
  console.log(`  ✅  Blog index updated with ${published.length} articles`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Angler BI Weekly Blog Runner');
  console.log(`  ${new Date().toLocaleString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const cfg = loadConfig();

  if (!cfg.api_keys.anthropic_api_key) {
    console.error('❌  anthropic_api_key is required. Add it to blog-pipeline/blog-config.json');
    process.exit(1);
  }

  const claude = new Anthropic({ apiKey: cfg.api_keys.anthropic_api_key });

  // 1. Get this week's topic
  const topic = await getWeeklyTopic(cfg, claude);
  console.log(`\n📝  This week's article: "${topic.title || topic.keyword}"\n`);

  // 2. Run step3 content engine with the topic
  const step3 = path.join(__dirname, 'step3-content-engine.js');
  const envOverride = { ...process.env };

  // Inject topic override via temp file
  const tempTopic = path.join(__dirname, '.weekly-topic.json');
  fs.writeFileSync(tempTopic, JSON.stringify(topic));

  try {
    execSync(`node "${step3}" --keyword="${topic.keyword}"`, {
      stdio: 'inherit',
      env: envOverride,
      cwd: __dirname
    });
  } finally {
    if (fs.existsSync(tempTopic)) fs.unlinkSync(tempTopic);
  }

  // 3. Refresh pipeline if queue running low
  const refreshedCfg = loadConfig();
  const remaining = refreshedCfg.content_pipeline?.queue?.filter(q => q.status === 'pending') || [];
  if (remaining.length < 3) {
    console.log('\n🔄  Queue running low — re-running site intelligence to refresh pipeline...');
    try {
      execSync(`node "${path.join(__dirname, 'step2-site-intelligence.js')}"`, {
        stdio: 'inherit', cwd: __dirname
      });
    } catch (e) {
      console.warn('  ⚠️  Site intelligence refresh failed:', e.message);
    }
  }

  // 4. Rebuild blog index
  rebuildBlogIndex(loadConfig());

  console.log('\n✅  Weekly blog run complete!\n');
}

main().catch(err => {
  console.error('❌  Fatal error:', err.message);
  process.exit(1);
});
