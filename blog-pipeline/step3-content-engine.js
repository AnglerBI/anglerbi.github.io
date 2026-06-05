#!/usr/bin/env node
/**
 * ANGLER BI — Blog Pipeline: Step 3 — Content Engine
 * ────────────────────────────────────────────────────
 * Takes the next pending article from the queue,
 * researches it, generates a full outline + article,
 * creates images, and outputs a publish-ready folder.
 *
 * Run: node step3-content-engine.js
 *      node step3-content-engine.js --keyword "power bi dashboard design"
 *
 * Prereq: npm install axios anthropic p-limit
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

const fs       = require('fs');
const path     = require('path');
const axios    = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const CONFIG_PATH  = path.join(__dirname, 'blog-config.json');
const ARTICLES_DIR = path.join(__dirname, '..', 'blog', 'articles');

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // Inject API keys from environment — never stored in the config file
  cfg.api_keys = {
    anthropic_api_key:   process.env.ANTHROPIC_API_KEY   || '',
    tavily_api_key:      process.env.TAVILY_API_KEY       || '',
    dataforseo_login:    process.env.DATAFORSEO_LOGIN     || '',
    dataforseo_password: process.env.DATAFORSEO_PASSWORD  || '',
    firecrawl_api_key:   process.env.FIRECRAWL_API_KEY    || '',
    google_ai_api_key:   process.env.GOOGLE_AI_API_KEY    || '',
    openai_api_key:      process.env.OPENAI_API_KEY       || '',
    youtube_data_api_key: process.env.YOUTUBE_DATA_API_KEY || '',
  };
  return cfg;
}
function saveConfig(cfg) {
  const { api_keys, ...safe } = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(safe, null, 2));
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── DataForSEO ─────────────────────────────────────────────────────────────────
async function dfsPost(endpoint, payload, cfg) {
  const { dataforseo_login: u, dataforseo_password: p } = cfg.api_keys;
  if (!u || !p) throw new Error('DataForSEO credentials missing');
  const r = await axios.post(`https://api.dataforseo.com/v3/${endpoint}`, payload,
    { auth: { username: u, password: p }, headers: { 'Content-Type': 'application/json' } });
  return r.data;
}

// ── Tavily Research ────────────────────────────────────────────────────────────
async function tavilySearch(query, cfg, maxResults = 5) {
  const key = cfg.api_keys.tavily_api_key;
  if (!key) {
    console.warn('  ⚠️  Tavily key missing — skipping web research for:', query);
    return [];
  }
  try {
    const resp = await axios.post('https://api.tavily.com/search', {
      api_key: key,
      query,
      search_depth: 'advanced',
      max_results: maxResults,
      include_answer: true
    });
    return resp.data.results || [];
  } catch (e) {
    console.warn('  ⚠️  Tavily search failed:', e.message);
    return [];
  }
}

// ── Firecrawl: scrape top 3 ranking articles ──────────────────────────────────
async function scrapeTopArticles(keyword, cfg) {
  const firecrawlKey = cfg.api_keys.firecrawl_api_key;
  if (!firecrawlKey) {
    console.warn('  ⚠️  Firecrawl key missing — skipping competitor content scrape.');
    return [];
  }

  console.log('  🔍  Fetching top 3 SERP results...');
  let serpUrls = [];
  try {
    const data = await dfsPost('serp/google/organic/live/advanced', [{
      keyword, language_code: 'en', location_code: 2840, depth: 3
    }], cfg);
    const items = data.tasks?.[0]?.result?.[0]?.items || [];
    serpUrls = items
      .filter(i => i.type === 'organic')
      .slice(0, 3)
      .map(i => i.url)
      .filter(Boolean);
  } catch (e) {
    console.warn('  ⚠️  SERP fetch failed:', e.message);
    return [];
  }

  console.log(`  📄  Scraping ${serpUrls.length} competitor articles via Firecrawl...`);
  const results = [];
  for (const url of serpUrls) {
    try {
      const resp = await axios.post('https://api.firecrawl.dev/v0/scrape',
        { url, pageOptions: { onlyMainContent: true } },
        { headers: { Authorization: `Bearer ${firecrawlKey}` }, timeout: 15000 }
      );
      const content = resp.data?.data?.markdown || '';
      const wordCount = content.split(/\s+/).length;
      const h2s = [...content.matchAll(/^## .+/gm)].map(m => m[0].replace('## ', ''));
      results.push({ url, wordCount, h2s, contentPreview: content.slice(0, 2000) });
    } catch (e) {
      console.warn(`  ⚠️  Failed to scrape ${url}:`, e.message);
    }
  }
  return results;
}

// ── SERP Gap Analysis (Haiku) ──────────────────────────────────────────────────
async function serpGapAnalysis(articles, keyword, claude) {
  if (!articles.length) return { covered: [], gaps: [], snippet_opportunity: '' };

  const resp = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Analyze these top-ranking articles for "${keyword}" and identify content gaps.

Articles:
${articles.map((a, i) => `Article ${i + 1} (${a.url})\nH2s: ${a.h2s.join(', ')}\nWord count: ${a.wordCount}\nPreview: ${a.contentPreview.slice(0, 500)}`).join('\n\n')}

Return JSON:
{
  "covered": ["topics all 3 articles cover"],
  "gaps": ["important topics NOT covered or poorly covered"],
  "snippet_opportunity": "best featured snippet angle for this keyword",
  "avg_word_count": 1500
}`
    }]
  });

  try {
    const text = resp.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { covered: [], gaps: [], snippet_opportunity: '' };
  } catch (e) {
    return { covered: [], gaps: [], snippet_opportunity: '' };
  }
}

// ── Build Full Outline (Sonnet) ───────────────────────────────────────────────
async function generateOutline(topic, research, gap, cfg, claude) {
  console.log('  📐  Generating article outline...');

  const { keyword, title, stage } = topic;
  const targetWords = research.avgWordCount ? Math.round(research.avgWordCount * 1.15) : 1800;
  const ctaMap = {
    TOFU: 'Subscribe to our BI newsletter for weekly insights',
    MOFU: 'Download our free BI Maturity Assessment',
    BOFU: 'Book a free discovery call with Angler BI'
  };

  const resp = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are creating an SEO content outline for ${cfg.business.name}.

Target keyword: ${keyword}
Title: ${title}
Funnel stage: ${stage || 'MOFU'}
Target word count: ${targetWords}

Business context:
- ${cfg.business.name}: ${cfg.business.description}
- Brand voice: ${cfg.brand_voice.tone}
- Writing style: ${cfg.brand_voice.writing_style}
- Avoid: ${cfg.brand_voice.avoid.join(', ')}

Research findings:
- Competitor gaps (write about these!): ${gap.gaps?.join(', ') || 'N/A'}
- Topics already covered: ${gap.covered?.join(', ') || 'N/A'}
- Featured snippet angle: ${gap.snippet_opportunity || 'N/A'}
- Recent news: ${research.news?.slice(0, 3).map(n => n.title).join('; ') || 'N/A'}

CTA for this funnel stage: "${ctaMap[stage || 'MOFU']}"

Product mention rule: ONE mention only, in a designated section, ONLY after the reader has felt the pain it solves. No marketing language. Natural framing only.

Section naming rules — the writer will follow the outline's H2 labels exactly, so make them human:
- No "The Bottom Line", "Key Takeaways", "In Conclusion", or "Final Thoughts" as H2 names.
- H2s should read like a journalist wrote them, not a content template. Specific, not generic.
- Do not suggest a section that would naturally produce a "Here's X, Y, and Z" preview paragraph.
- Do not plan consecutive bullet-list sections. Mix prose sections with structured ones.

Return a structured JSON outline:
{
  "title": "Final SEO title",
  "meta_description": "155-char meta description with keyword",
  "word_count_target": ${targetWords},
  "sections": [
    {
      "type": "intro",
      "h2": null,
      "word_count": 150,
      "notes": "Hook, problem statement, what reader will learn"
    },
    {
      "type": "section",
      "h2": "H2 heading",
      "h3s": ["optional H3 subheadings"],
      "word_count": 300,
      "notes": "What to cover, which research to use, tone guidance",
      "product_mention": false
    }
  ],
  "image_positions": [0, 3],
  "cta_section": "section index where CTA goes",
  "schema_type": "Article|HowTo|FAQPage"
}`
    }]
  });

  try {
    const text = resp.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    console.warn('  ⚠️  Outline parse error:', e.message);
    return null;
  }
}

// ── Write Full Article (Sonnet) ───────────────────────────────────────────────
async function writeArticle(outline, topic, research, cfg, claude) {
  console.log('  ✍️  Writing full article (Claude Sonnet)...');

  const newsContext = research.news?.slice(0, 5).map(
    n => `- ${n.title}: ${n.content?.slice(0, 200)}`
  ).join('\n') || 'No recent news available.';

  const resp = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: `Write a complete, publication-ready blog article for ${cfg.business.name}.

TARGET KEYWORD: ${topic.keyword}
TITLE: ${outline.title || topic.title}
WORD COUNT TARGET: ${outline.word_count_target || 1800}

OUTLINE TO FOLLOW:
${JSON.stringify(outline.sections, null, 2)}

RECENT RESEARCH TO INCORPORATE:
${newsContext}

BRAND VOICE: ${cfg.brand_voice.tone}
WRITING STYLE: ${cfg.brand_voice.writing_style}
AVOID: ${cfg.brand_voice.avoid.join(', ')}

PRODUCT MENTION RULE: ONE mention of Angler BI, naturally placed in the designated section only, after the reader has understood the problem. Frame it as a resource, not a pitch. No marketing language.

HUMANIZATION RULES — follow every one of these without exception:
- NO em dashes (—). Replace with a period, a comma, or restructure the sentence entirely.
- NO "Here's what X, Y, and Z" preview sentences at the start of a section. Just write the content.
- NO bold **Statement.** followed immediately by its own explanation as a paragraph break. Weave the point into prose.
- NO section titled "The Bottom Line", "Key Takeaways", "In Conclusion", or "Final Thoughts". End with a punchy paragraph, not a summary header.
- NO bullet lists where three or fewer items could read naturally as a sentence. Reserve lists for four or more genuinely enumerable items.
- NO transition words as sentence openers: Furthermore, Moreover, Additionally, In addition, It's worth noting, It's important to understand, This is particularly.
- NO "In today's [adjective] landscape/environment/world" openings.
- NO hedging language: arguably, somewhat, rather, it could be said, one might argue.
- NO passive voice where active works. "Companies ignore this" not "This is often ignored by companies."
- VARY sentence length aggressively. A three-word sentence next to a twenty-word one. Not every sentence the same rhythm.
- USE contractions naturally (don't, you'll, it's, they're). A human wrote this.
- WRITE opinions. Take a position. "This is wrong" not "Some experts believe this approach has limitations."
- SPECIFIC beats vague. Name the version, the date, the number, the company. Not "many organizations" — "most mid-size companies running Pro licenses."
- IMPERFECT transitions are fine. You don't need to connect every paragraph with a setup sentence.

FORMAT:
- Use ## for H2, ### for H3
- No introduction heading (just write the intro paragraph)
- Mark image placements as: [IMAGE: brief description]
- Mark CTA placement as: [CTA]
- Write in Markdown

Write the full article now:`
    }]
  });

  return resp.content[0].text;
}

// ── Extract paragraph context around each [IMAGE] marker ─────────────────────
function extractImageContexts(md) {
  const markers = [];
  const regex = /\[IMAGE: ([^\]]+)\]/g;
  let m;
  while ((m = regex.exec(md)) !== null) {
    const before = md.slice(0, m.index);
    const paragraphs = before
      .split(/\n\n+/)
      .map(p => p.trim())
      .filter(p => p && !p.startsWith('#') && !p.startsWith('['));
    const context = paragraphs.slice(-3).join('\n\n').slice(-800);
    markers.push({ position: markers.length, description: m[1], context });
  }
  return markers;
}

// ── Generate Images via Google Imagen 4 ──────────────────────────────────────
async function generateImages(articleMd, outline, topic, cfg, claude, articleDir) {
  const googleKey = cfg.api_keys.google_ai_api_key;

  console.log('  🎨  Generating image prompts...');
  const imageMarkers = extractImageContexts(articleMd);

  // Ask Haiku to write contextually relevant Imagen 4 prompts
  const promptResp = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `You are writing Google Imagen 4 image prompts for a professional BI consulting blog. Each image must be a visual metaphor for the specific section of text it illustrates — thematically connected but rendered abstractly.

${imageMarkers.map((m, i) => `IMAGE ${i}
Section text this image appears after:
"${m.context}"
`).join('\n---\n')}

RULES:
- Read the section text carefully. Identify the CORE CONCEPT then visualize THAT concept abstractly as a physical metaphor.
- NEVER render software UIs, dashboards, chat windows, search bars, or app interfaces. Translate those concepts into physical metaphors instead.
  Example: "deprecating an old tool" → crumbling geometric structure dissolving into teal particles that reform into clean sharp shapes
  Example: "AI interpreting messy data models" → tangled glowing filaments slowly organized into a precise geometric lattice
  Example: "data flowing between systems" → luminous teal streams converging into a single radiant node on a dark field
- Brand colors: deep navy blue (#0a1628) dominant background, electric teal (#07c3e8) for glow/accent.
- Style: photorealistic 3D render OR clean vector illustration. Professional, sophisticated.
- No text, labels, logos, people, hands, or screens.
- One cohesive scene per image. Not a split-screen or comparison layout.
- Each prompt under 80 words. Specific and visual.

Return a JSON array only:
[{"position": 0, "filename": "image-0.png", "prompt": "...", "alt_text": "short accessible description, no brand names"}]`
    }]
  });

  let imageMeta = [];
  try {
    const text = promptResp.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    imageMeta = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch (e) {
    imageMeta = [{
      position: 0,
      filename: 'image-0.png',
      prompt: `Abstract 3D data network visualization, glowing teal nodes connected by flowing data streams, deep navy blue background, layered geometric planes, particle field effect, professional business intelligence aesthetic, photorealistic render, no text, no screens, no people`,
      alt_text: 'Abstract data visualization with glowing network nodes'
    }];
  }

  if (!googleKey) {
    console.log('  ℹ️  No GOOGLE_AI_API_KEY — image prompts saved but images not generated.');
    return imageMeta;
  }

  const imagesDir = path.join(articleDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  // Generate each image via Imagen 3
  for (const img of imageMeta) {
    try {
      console.log(`  🖼️   Generating image ${img.position} via Imagen 3...`);
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-fast-generate-001:predict?key=${googleKey}`,
        {
          instances: [{ prompt: img.prompt }],
          parameters: {
            sampleCount: 1,
            aspectRatio: '16:9',
            safetyFilterLevel: 'block_some',
            personGeneration: 'allow_adult'
          }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );

      const b64 = resp.data?.predictions?.[0]?.bytesBase64Encoded;
      if (b64) {
        const filename = img.filename || `image-${img.position}.png`;
        const filepath = path.join(imagesDir, filename);
        fs.writeFileSync(filepath, Buffer.from(b64, 'base64'));
        img.localPath = `/blog/articles/${slugify(topic.title || topic.keyword)}/images/${filename}`;
        console.log(`  ✅  Image ${img.position} saved: ${filename}`);
      } else {
        console.warn(`  ⚠️  Image ${img.position}: no image data in response`);
      }
    } catch (e) {
      console.warn(`  ⚠️  Image ${img.position} generation failed:`, e.message);
    }
  }

  return imageMeta;
}

// ── Generate Schema Markup (Haiku) ────────────────────────────────────────────
async function generateSchema(outline, topic, cfg, claude) {
  const resp = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Generate JSON-LD schema markup for this blog article.

Type: ${outline.schema_type || 'Article'}
Title: ${outline.title || topic.title}
Keyword: ${topic.keyword}
Publisher: ${cfg.business.name}
URL: ${cfg.business.url}/blog/${slugify(topic.title || topic.keyword)}
Date: ${new Date().toISOString().split('T')[0]}

Return only the JSON-LD script block.`
    }]
  });

  return resp.content[0].text;
}

// ── Write HTML Article Page ────────────────────────────────────────────────────
function writeHtmlPage(article, outline, topic, images, schema, publishDate) {
  const slug = slugify(topic.title || topic.keyword);
  const title = outline?.title || topic.title;
  const meta  = outline?.meta_description || `${title} | Angler BI`;

  // Convert Markdown to basic HTML
  let content = article
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[IMAGE: ([^\]]+)\]/g, (_, desc) => {
      const img = images.find(i => i.prompt?.includes(desc.slice(0, 20)));
      return img?.localPath
        ? `<figure class="article-figure"><img src="${img.localPath}" alt="${img.alt_text || desc}" loading="lazy"><figcaption>${desc}</figcaption></figure>`
        : `<figure class="article-figure article-figure--placeholder" aria-label="${desc}"></figure>`;
    })
    .replace(/\[CTA\]/g, `
<div class="article-cta">
  <h3>Ready to turn your data into decisions?</h3>
  <p>Angler BI builds the intelligence infrastructure that makes confident decisions possible. And sustainable.</p>
  <a href="https://anglerbi.com/#contact" class="cta-btn">Book a Free Discovery Call</a>
</div>`)
    .split('\n\n')
    .map(p => p.startsWith('<') ? p : `<p>${p}</p>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | Angler BI</title>
  <meta name="description" content="${meta}">
  <link rel="icon" type="image/x-icon" href="/assets/favicon.ico">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/styles.css">
  <link rel="stylesheet" href="/css/blog.css">
  <script type="application/ld+json">
${schema}
  </script>
</head>
<body>
  <nav id="mainNav">
    <div class="nav-inner">
      <a href="/" class="nav-logo">
        <img src="/assets/AnglerLogo.svg" alt="Angler BI Logo" class="nav-logo-img">
        <span class="logo-mark">Angler</span><span class="logo-accent">BI</span>
      </a>
      <ul class="nav-links">
        <li><a href="/#services">Services</a></li>
        <li><a href="/#work">Work</a></li>
        <li><a href="/blog/">Blog</a></li>
        <li><a href="/#contact" class="nav-cta">Get In Touch</a></li>
      </ul>
    </div>
  </nav>

  <main class="article-main">
    <div class="article-container">
      <header class="article-header">
        <div class="article-meta">
          <span class="article-category">${topic.cluster || 'Business Intelligence'}</span>
          <span class="article-date">${publishDate}</span>
        </div>
        <h1 class="article-title">${title}</h1>
      </header>

      <article class="article-body">
        ${content}
      </article>

      <footer class="article-footer">
        <p>Published by <a href="/">Angler BI</a> — Business Intelligence Consulting, Miami FL</p>
        <a href="/blog/" class="back-link">← Back to Blog</a>
      </footer>
    </div>
  </main>

  <script src="/js/scripts.js"></script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Angler BI Blog Pipeline — Step 3: Content Engine');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const cfg = loadConfig();

  if (!cfg.api_keys.anthropic_api_key) {
    console.error('❌  anthropic_api_key is required. Add it to blog-pipeline/blog-config.json');
    process.exit(1);
  }

  const claude = new Anthropic({ apiKey: cfg.api_keys.anthropic_api_key });

  // Pick topic — CLI override or next in queue
  const cliKeyword = process.argv.find(a => a.startsWith('--keyword='))?.split('=')[1];
  let topic = cliKeyword
    ? { keyword: cliKeyword, title: cliKeyword, stage: 'MOFU', cluster: 'Manual' }
    : cfg.content_pipeline.queue?.find(q => q.status === 'pending');

  if (!topic) {
    console.log('✅  No pending topics in queue. Run step2-site-intelligence.js to refresh.');
    process.exit(0);
  }

  console.log(`\n📝  Writing article: "${topic.title || topic.keyword}"\n`);

  // Mark in progress
  if (topic.status) topic.status = 'in_progress';

  // ── Research Phase ──────────────────────────────────────────────────────────
  console.log('🔬  Research phase...');
  const [topArticles, newsResults, expertResults, mistakesResults] = await Promise.all([
    scrapeTopArticles(topic.keyword, cfg),
    tavilySearch(`latest news ${topic.keyword} 2025 2026`, cfg),
    tavilySearch(`expert opinion ${topic.keyword} best practices`, cfg),
    tavilySearch(`common mistakes ${topic.keyword} pitfalls`, cfg)
  ]);

  const avgWordCount = topArticles.length
    ? Math.round(topArticles.reduce((s, a) => s + a.wordCount, 0) / topArticles.length)
    : 1800;

  const research = {
    news: newsResults,
    expert: expertResults,
    mistakes: mistakesResults,
    avgWordCount
  };

  // ── Gap Analysis ────────────────────────────────────────────────────────────
  const gap = await serpGapAnalysis(topArticles, topic.keyword, claude);

  // ── Outline ─────────────────────────────────────────────────────────────────
  const outline = await generateOutline(topic, research, gap, cfg, claude);
  if (!outline) {
    console.error('❌  Failed to generate outline. Check API key and try again.');
    process.exit(1);
  }

  // ── Write Article ───────────────────────────────────────────────────────────
  const articleMd = await writeArticle(outline, topic, research, cfg, claude);

  // ── Set up article directory before image generation (Imagen saves files locally) ──
  const slug = slugify(outline.title || topic.title || topic.keyword);
  const publishDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const articleDir = path.join(ARTICLES_DIR, slug);
  fs.mkdirSync(articleDir, { recursive: true });
  fs.mkdirSync(path.join(articleDir, 'images'), { recursive: true });

  // ── Images + Schema ─────────────────────────────────────────────────────────
  const [images, schema] = await Promise.all([
    generateImages(articleMd, outline, topic, cfg, claude, articleDir),
    generateSchema(outline, topic, cfg, claude)
  ]);

  // article.md — pure content for CMS import
  fs.writeFileSync(path.join(articleDir, 'article.md'), articleMd);

  // article.html — ready for static site
  const html = writeHtmlPage(articleMd, outline, topic, images, schema, publishDate);
  fs.writeFileSync(path.join(articleDir, 'index.html'), html);

  // publish-kit.md
  const publishKit = `# Publish Kit: ${outline.title || topic.title}

## Meta Assets
- **Title**: ${outline.title || topic.title}
- **Meta Description**: ${outline.meta_description || ''}
- **Target Keyword**: ${topic.keyword}
- **Funnel Stage**: ${topic.stage || 'MOFU'}
- **Cluster**: ${topic.cluster || 'N/A'}
- **Target Word Count**: ${outline.word_count_target || 1800}
- **Schema Type**: ${outline.schema_type || 'Article'}
- **Publish Date**: ${publishDate}
- **Slug**: /blog/${slug}/

## Publishing Checklist
- [ ] Copy \`article.md\` content into your CMS (or deploy \`index.html\`)
- [ ] Upload images from \`images/\` folder
- [ ] Add JSON-LD schema from \`schema.json\`
- [ ] Update \`blog/index.html\` article listing
- [ ] Set canonical URL to https://anglerbi.com/blog/${slug}/
- [ ] Submit URL to Google Search Console after publish
- [ ] Share on LinkedIn and newsletter

## Image Alt Texts
${images.map((img, i) => `${i + 1}. ${img.alt_text || topic.keyword}`).join('\n')}

## Internal Linking Suggestions
- Link to /#services on first mention of any Angler BI service
- Link to other related blog articles once they exist

## Schema JSON
\`\`\`json
${schema}
\`\`\`
`;

  fs.writeFileSync(path.join(articleDir, 'publish-kit.md'), publishKit);
  fs.writeFileSync(path.join(articleDir, 'images', 'prompts.json'), JSON.stringify(images, null, 2));

  // ── Update pipeline ─────────────────────────────────────────────────────────
  const qIdx = cfg.content_pipeline.queue?.findIndex(q => q.keyword === topic.keyword);
  if (qIdx >= 0) cfg.content_pipeline.queue[qIdx].status = 'published';
  cfg.content_pipeline.published = cfg.content_pipeline.published || [];
  cfg.content_pipeline.published.push({
    keyword: topic.keyword,
    title: outline.title || topic.title,
    slug,
    published: new Date().toISOString(),
    path: `blog/articles/${slug}/`
  });
  saveConfig(cfg);

  console.log(`\n✅  Article complete! Files saved to: blog/articles/${slug}/`);
  console.log(`   • article.md      — Markdown content`);
  console.log(`   • index.html      — Publish-ready HTML page`);
  console.log(`   • publish-kit.md  — Meta, schema, checklist`);
  console.log(`   • images/         — Image prompts (+ generated images if OpenAI key provided)`);
  console.log(`\n   Next: update blog/index.html to include this article in the listing.\n`);
}

main().catch(err => {
  console.error('❌  Fatal error:', err.message);
  process.exit(1);
});
