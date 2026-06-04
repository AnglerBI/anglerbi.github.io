#!/usr/bin/env node
/**
 * ANGLER BI — Blog Pipeline: Step 2 — Site Intelligence
 * ────────────────────────────────────────────────────────
 * Runs three keyword sources in parallel, deduplicates,
 * scores opportunities, and builds topical clusters.
 *
 * Run: node step2-site-intelligence.js
 * Prereq: npm install axios anthropic p-limit
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

const fs       = require('fs');
const path     = require('path');
const axios    = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const pLimit   = require('p-limit');

const CONFIG_PATH = path.join(__dirname, 'blog-config.json');

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg.api_keys = {
    anthropic_api_key:    process.env.ANTHROPIC_API_KEY    || '',
    tavily_api_key:       process.env.TAVILY_API_KEY        || '',
    dataforseo_login:     process.env.DATAFORSEO_LOGIN      || '',
    dataforseo_password:  process.env.DATAFORSEO_PASSWORD   || '',
    firecrawl_api_key:    process.env.FIRECRAWL_API_KEY     || '',
    openai_api_key:       process.env.OPENAI_API_KEY        || '',
    youtube_data_api_key: process.env.YOUTUBE_DATA_API_KEY  || '',
  };
  return cfg;
}
function saveConfig(cfg) {
  const { api_keys, ...safe } = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(safe, null, 2));
}

// ── DataForSEO ────────────────────────────────────────────────────────────────
async function dfsPost(endpoint, payload, cfg) {
  const { dataforseo_login: u, dataforseo_password: p } = cfg.api_keys;
  if (!u || !p) throw new Error('DataForSEO credentials missing');
  const r = await axios.post(`https://api.dataforseo.com/v3/${endpoint}`, payload,
    { auth: { username: u, password: p }, headers: { 'Content-Type': 'application/json' } });
  return r.data;
}

// ── Source 1: Your existing rankings ─────────────────────────────────────────
async function getOwnRankings(cfg) {
  console.log('📊  Fetching own rankings (top 100 by traffic value)...');
  try {
    const data = await dfsPost('dataforseo_labs/google/ranked_keywords/live', [{
      target: cfg.seo.domain,
      language_code: 'en',
      location_code: 2840,
      limit: 100,
      order_by: ['etv,desc']
    }], cfg);
    const items = data.tasks?.[0]?.result?.[0]?.items || [];
    return items.map(i => ({
      keyword: i.keyword_data?.keyword,
      volume: i.keyword_data?.keyword_info?.search_volume || 0,
      kd: i.keyword_data?.keyword_properties?.keyword_difficulty || 0,
      source: 'own_rankings'
    })).filter(k => k.keyword);
  } catch (e) {
    console.warn('  ⚠️  Own rankings unavailable:', e.message);
    return [];
  }
}

// ── Source 2: Competitor keywords ─────────────────────────────────────────────
async function getCompetitorKeywords(cfg) {
  if (!cfg.competitors?.length) {
    console.log('  ⚠️  No competitors in config — skipping competitor keyword harvest.');
    return [];
  }
  console.log(`📊  Fetching competitor keywords (top 200 per competitor × ${cfg.competitors.length})...`);
  const limit = pLimit(3);
  const results = await Promise.all(
    cfg.competitors.map(comp => limit(async () => {
      try {
        const data = await dfsPost('dataforseo_labs/google/ranked_keywords/live', [{
          target: comp.domain,
          language_code: 'en',
          location_code: 2840,
          limit: 200,
          order_by: ['etv,desc']
        }], cfg);
        const items = data.tasks?.[0]?.result?.[0]?.items || [];
        return items.map(i => ({
          keyword: i.keyword_data?.keyword,
          volume: i.keyword_data?.keyword_info?.search_volume || 0,
          kd: i.keyword_data?.keyword_properties?.keyword_difficulty || 0,
          source: `competitor:${comp.domain}`
        })).filter(k => k.keyword);
      } catch (e) {
        console.warn(`  ⚠️  ${comp.domain} keyword fetch failed:`, e.message);
        return [];
      }
    }))
  );
  return results.flat();
}

// ── Source 3: Seed expansion (Claude Haiku → DataForSEO) ─────────────────────
async function expandSeeds(cfg, claude) {
  console.log('🌱  Expanding seed keywords with Claude Haiku...');
  const seeds = cfg.seo.seed_keywords;

  // Generate 30 seed phrases from ICP pain points
  const seedResponse = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are an SEO keyword researcher for a BI consulting firm.

Business: ${cfg.business.name} — ${cfg.business.description}
ICP Pain Points: ${cfg.icp.pain_points.join(', ')}
Services: ${cfg.services.map(s => s.name).join(', ')}
Existing seeds: ${seeds.join(', ')}

Generate 30 additional seed keyword phrases (2-5 words each) that this ICP would search for when experiencing these pain points. Focus on informational and commercial intent. One per line, no numbering.`
    }]
  });

  const newSeeds = seedResponse.content[0].text.trim().split('\n')
    .map(s => s.trim()).filter(s => s.length > 0 && s.length < 80);

  const allSeeds = [...new Set([...seeds, ...newSeeds])].slice(0, 60);
  console.log(`  Generated ${newSeeds.length} new seeds. Total: ${allSeeds.length}`);

  // Expand each seed via DataForSEO (30 parallel calls with rate limiting)
  const limit = pLimit(5); // 5 concurrent
  console.log('  Expanding seeds via DataForSEO (~30 related keywords each)...');

  let expandedKeywords = [];
  try {
    const expansions = await Promise.all(
      allSeeds.map(seed => limit(async () => {
        try {
          const data = await dfsPost('dataforseo_labs/google/related_keywords/live', [{
            keyword: seed,
            language_code: 'en',
            location_code: 2840,
            limit: 30
          }], cfg);
          const items = data.tasks?.[0]?.result?.[0]?.items || [];
          return items.map(i => ({
            keyword: i.keyword_data?.keyword,
            volume: i.keyword_data?.keyword_info?.search_volume || 0,
            kd: i.keyword_data?.keyword_properties?.keyword_difficulty || 0,
            source: `seed_expansion:${seed}`
          })).filter(k => k.keyword);
        } catch (e) { return []; }
      }))
    );
    expandedKeywords = expansions.flat();
  } catch (e) {
    console.warn('  ⚠️  Seed expansion failed — using seeds directly:', e.message);
    expandedKeywords = allSeeds.map(kw => ({
      keyword: kw, volume: 500, kd: 20, source: 'seed_fallback'
    }));
  }

  return expandedKeywords;
}

// ── Opportunity Scoring ───────────────────────────────────────────────────────
function scoreKeyword(kw) {
  // log-volume normalized against 100k anchor
  const logVolume = kw.volume > 0 ? Math.log10(kw.volume) / Math.log10(100000) : 0;
  // difficulty inverted: low KD = high score
  const diffScore = kw.kd > 0 ? Math.max(0, 1 - (kw.kd / 100)) : 0.5;
  // funnel weight applied later; default 0.5
  const funnelScore = kw._funnel_score || 0.5;

  return Math.round((0.40 * logVolume + 0.40 * diffScore + 0.20 * funnelScore) * 100);
}

// ── TOFU/MOFU/BOFU Classification (Haiku, batches of 50) ─────────────────────
async function classifyFunnel(keywords, claude) {
  console.log(`\n🏷️  Classifying ${keywords.length} keywords into TOFU/MOFU/BOFU...`);
  const BATCH = 50;
  const classified = [];

  for (let i = 0; i < keywords.length; i += BATCH) {
    const batch = keywords.slice(i, i + BATCH);
    const resp = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Classify each keyword as TOFU (awareness), MOFU (consideration), or BOFU (decision).
Return JSON array: [{"keyword":"...","stage":"TOFU|MOFU|BOFU","funnel_score":0.0-1.0}]
funnel_score: TOFU=0.3, MOFU=0.6, BOFU=1.0

Keywords:
${batch.map(k => k.keyword).join('\n')}`
      }]
    });

    try {
      const text = resp.content[0].text;
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        parsed.forEach(item => {
          const orig = batch.find(k => k.keyword === item.keyword);
          if (orig) classified.push({ ...orig, stage: item.stage, _funnel_score: item.funnel_score });
        });
      }
    } catch (e) {
      batch.forEach(k => classified.push({ ...k, stage: 'MOFU', _funnel_score: 0.6 }));
    }

    process.stdout.write(`  ${Math.min(i + BATCH, keywords.length)}/${keywords.length}...\r`);
  }
  console.log('\n  Classification complete.');
  return classified;
}

// ── Cluster into topical groups (Sonnet) ──────────────────────────────────────
async function clusterKeywords(keywords, cfg, claude) {
  console.log('\n🗂️  Clustering keywords into topical groups...');

  // Take top 200 scored keywords for clustering
  const top = keywords
    .sort((a, b) => (b._score || 0) - (a._score || 0))
    .slice(0, 200);

  const resp = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are building a content strategy for ${cfg.business.name}, a BI consulting firm.

Group these ${top.length} keywords into 6–10 topical clusters. Each cluster needs:
- A short cluster name
- A "pillar_keyword" (the primary target — highest volume + feasible KD)
- Supporting keywords (3–8)
- Recommended TOFU/MOFU/BOFU mix

Return valid JSON:
[{
  "cluster": "cluster name",
  "pillar_keyword": "main keyword",
  "supporting_keywords": ["kw1","kw2"],
  "funnel_mix": { "TOFU": 0.4, "MOFU": 0.4, "BOFU": 0.2 },
  "priority": 1
}]

Keywords (keyword | volume | KD | stage | score):
${top.map(k => `${k.keyword} | ${k.volume} | ${k.kd} | ${k.stage || 'MOFU'} | ${k._score || 0}`).join('\n')}`
    }]
  });

  try {
    const text = resp.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch (e) {
    console.warn('  ⚠️  Clustering parse error:', e.message);
    return [];
  }
}

// ── Generate SEO titles for top 10 topics ─────────────────────────────────────
async function generateTitles(clusters, cfg, claude) {
  console.log('\n✍️  Generating SEO titles for top 10 topics (breadth-first)...');

  // One topic per cluster, best score first
  const topics = clusters.slice(0, 10).map(c => ({
    keyword: c.pillar_keyword,
    cluster: c.cluster
  }));

  const resp = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Write one SEO-optimized blog title for each keyword below.
Brand voice: ${cfg.brand_voice.tone}
Company: ${cfg.business.name} — ${cfg.business.description}

Rules:
- Include the keyword naturally
- 50–65 characters
- No clickbait. No "Ultimate Guide". Clear, specific, valuable.
- Return JSON: [{"keyword":"...","title":"...","cluster":"..."}]

Topics:
${topics.map(t => `${t.keyword} (cluster: ${t.cluster})`).join('\n')}`
    }]
  });

  try {
    const text = resp.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch (e) {
    return topics.map(t => ({ keyword: t.keyword, title: `How to Leverage ${t.keyword}`, cluster: t.cluster }));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Angler BI Blog Pipeline — Step 2: Site Intelligence');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const cfg = loadConfig();

  if (!cfg.api_keys.anthropic_api_key) {
    console.error('❌  anthropic_api_key is required. Add it to blog-pipeline/blog-config.json');
    process.exit(1);
  }

  const claude = new Anthropic({ apiKey: cfg.api_keys.anthropic_api_key });

  // ── 1. Harvest keywords from all 3 sources in parallel ─────────────────────
  console.log('📡  Harvesting keywords from 3 sources in parallel...\n');
  const [ownRankings, competitorKws, seedKws] = await Promise.all([
    getOwnRankings(cfg),
    getCompetitorKeywords(cfg),
    expandSeeds(cfg, claude)
  ]);

  const raw = [...ownRankings, ...competitorKws, ...seedKws];
  console.log(`\n  Raw: ${raw.length} keywords (own:${ownRankings.length} comp:${competitorKws.length} seed:${seedKws.length})`);

  // ── 2. Dedup + filter ───────────────────────────────────────────────────────
  const seen = new Set();
  const deduped = raw.filter(k => {
    if (!k.keyword || seen.has(k.keyword)) return false;
    seen.add(k.keyword);
    return (
      k.volume >= cfg.seo.volume_floor &&
      k.kd <= cfg.seo.kd_ceiling
    );
  });
  console.log(`  After dedup + volume/KD filter: ${deduped.length} keywords`);

  // ── 3. Classify funnel stage ────────────────────────────────────────────────
  const classified = await classifyFunnel(deduped, claude);

  // ── 4. Score ────────────────────────────────────────────────────────────────
  const scored = classified.map(k => ({ ...k, _score: scoreKeyword(k) }));
  const viable = scored.filter(k => k._score >= 70);
  console.log(`\n  Viable targets (score ≥ 70): ${viable.length}`);

  // ── 5. Cluster ──────────────────────────────────────────────────────────────
  const clusters = await clusterKeywords(viable.length > 0 ? viable : scored, cfg, claude);
  console.log(`  Created ${clusters.length} topical clusters`);

  // ── 6. Generate titles for pipeline ─────────────────────────────────────────
  const queue = await generateTitles(clusters, cfg, claude);
  console.log(`  Generated ${queue.length} article titles`);

  // ── Save ─────────────────────────────────────────────────────────────────────
  cfg.content_pipeline.clusters = clusters;
  cfg.content_pipeline.queue = queue.map(q => ({
    ...q,
    status: 'pending',
    added: new Date().toISOString()
  }));
  cfg._last_intelligence_run = new Date().toISOString();
  saveConfig(cfg);

  console.log('\n✅  Step 2 complete. Content pipeline populated.');
  console.log('   Queue preview:');
  queue.slice(0, 5).forEach((q, i) => console.log(`   ${i + 1}. ${q.title}`));
  console.log('\n   Run step3-content-engine.js to write the first article.\n');
}

main().catch(err => {
  console.error('❌  Fatal error:', err.message);
  process.exit(1);
});
