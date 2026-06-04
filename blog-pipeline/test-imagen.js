#!/usr/bin/env node
/**
 * Regenerate Imagen 4 images for an existing article.
 * Run: node test-imagen.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const ARTICLE_DIR = path.join(__dirname, '..', 'blog', 'articles', 'power-bi-copilot-features-2026');
const ARTICLE_MD  = path.join(ARTICLE_DIR, 'article.md');
const IMAGES_DIR  = path.join(ARTICLE_DIR, 'images');
const INDEX_HTML  = path.join(ARTICLE_DIR, 'index.html');
const SLUG        = 'power-bi-copilot-features-2026';

// Extract the 3 paragraphs of article text immediately before each [IMAGE] marker
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

async function main() {
  const googleKey    = process.env.GOOGLE_AI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!googleKey)    { console.error('❌  GOOGLE_AI_API_KEY missing in .env'); process.exit(1); }
  if (!anthropicKey) { console.error('❌  ANTHROPIC_API_KEY missing in .env'); process.exit(1); }

  const claude     = new Anthropic({ apiKey: anthropicKey });
  const articleMd  = fs.readFileSync(ARTICLE_MD, 'utf8');
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const imageMarkers = extractImageContexts(articleMd);
  console.log(`\n📄  Found ${imageMarkers.length} image marker(s)\n`);

  // Generate contextually relevant Imagen 4 prompts via Haiku
  console.log('🎨  Writing Imagen 4 prompts via Claude Haiku...');
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
- Read the section text carefully. Identify the CORE CONCEPT (e.g. data flowing between systems, AI making sense of chaos, old structures being replaced, a tangle of mismatched parts). Then visualize THAT concept abstractly.
- NEVER try to render software UIs, dashboards, chat windows, search bars, or app interfaces. Imagen gets these badly wrong. Translate those concepts into physical metaphors instead.
  Example: "deprecating an old tool" → crumbling geometric structure dissolving into flowing teal particles that reform into clean sharp shapes
  Example: "AI interpreting messy data models" → tangled glowing filaments slowly being organized into a precise geometric lattice
  Example: "Copilot understanding your data" → a radiant teal orb at the center of a vast node network, beams of light tracing pathways outward
- Brand colors: deep navy blue (#0a1628) dominant background, electric teal (#07c3e8) for glow/accent. Blue-teal palette only.
- Style: photorealistic 3D render OR clean vector illustration. Professional, sophisticated.
- No text, labels, logos, people, hands, or screens.
- One cohesive scene. Not a split-screen or comparison layout.
- Each prompt must be under 80 words. Specific and visual.

Return a JSON array only:
[{"position": 0, "filename": "image-0.png", "prompt": "...", "alt_text": "short accessible description, no brand names"}]`
    }]
  });

  let imageMeta = [];
  try {
    const text  = promptResp.content[0].text;
    const found = text.match(/\[[\s\S]*\]/);
    imageMeta   = found ? JSON.parse(found[0]) : [];
    console.log(`  ✅  ${imageMeta.length} prompt(s) generated`);
    imageMeta.forEach(img => console.log(`     ${img.position}: "${img.prompt.slice(0, 80)}..."`));
    console.log();
  } catch (e) {
    console.warn('  ⚠️  Prompt parse failed — using fallback');
    imageMeta = imageMarkers.map((m, i) => ({
      position: i,
      filename: `image-${i}.png`,
      prompt: `Abstract 3D data network, glowing teal nodes connected by flowing streams, deep navy blue background, layered geometric planes, particle field, photorealistic render, no text, no screens, no people`,
      alt_text: 'Abstract data visualization'
    }));
  }

  // Generate each image via Imagen 4
  for (const img of imageMeta) {
    console.log(`🖼️   Generating image ${img.position}...`);
    try {
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${googleKey}`,
        {
          instances:  [{ prompt: img.prompt }],
          parameters: { sampleCount: 1, aspectRatio: '16:9', safetyFilterLevel: 'block_some', personGeneration: 'allow_adult' }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );

      const b64 = resp.data?.predictions?.[0]?.bytesBase64Encoded;
      if (b64) {
        const buf      = Buffer.from(b64, 'base64');
        const filepath = path.join(IMAGES_DIR, img.filename);
        fs.writeFileSync(filepath, buf);
        img.localPath  = `/blog/articles/${SLUG}/images/${img.filename}`;
        console.log(`  ✅  Saved ${img.filename} (${Math.round(buf.length / 1024)}KB)\n`);
      } else {
        console.warn(`  ⚠️  No image data for position ${img.position}\n`);
      }
    } catch (e) {
      console.error(`  ❌  ${e.response?.data?.error?.message || e.message}\n`);
    }
  }

  // Update index.html — swap old img srcs with new ones (images already in place)
  const success = imageMeta.filter(i => i.localPath);
  if (!success.length) { console.log('⚠️  No images generated.'); return; }

  console.log('📝  Updating index.html...');
  let html = fs.readFileSync(INDEX_HTML, 'utf8');

  for (const img of success) {
    const oldSrc = `/blog/articles/${SLUG}/images/${img.filename}`;
    const newFig = `<figure class="article-figure"><img src="${img.localPath}" alt="${img.alt_text}" loading="lazy"></figure>`;

    // Replace the whole existing figure for this image (src already matches, just refresh alt text and strip figcaption)
    const figRe = new RegExp(
      `<figure class="article-figure"><img src="${oldSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>[^<]*(?:<figcaption>[^<]*</figcaption>)?</figure>`,
      'g'
    );
    const before = html;
    html = html.replace(figRe, newFig);
    console.log(html !== before
      ? `  ✅  Updated figure ${img.position}`
      : `  ⚠️  Figure ${img.position} not found by src — may need manual check`
    );
  }

  fs.writeFileSync(INDEX_HTML, html);
  console.log('\n✅  Done!\n');
  success.forEach(i => console.log(`  • ${i.localPath}`));
}

main().catch(e => { console.error('❌  Fatal:', e.message); process.exit(1); });
