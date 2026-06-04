#!/usr/bin/env node
/**
 * ANGLER BI — Blog Pipeline: Step 1 — Onboarding
 * ─────────────────────────────────────────────────
 * Scrapes anglerbi.com, extracts a structured business profile,
 * finds 3 direct competitors via DataForSEO SERP, and saves
 * everything to blog-config.json.
 *
 * Run: node step1-onboarding.js
 * Prereq: npm install axios cheerio
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG_PATH = path.join(__dirname, 'blog-config.json');

// ── Load config ──────────────────────────────────────────────────────────────
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
  console.log('✅  blog-config.json updated.');
}

// ── DataForSEO helper ─────────────────────────────────────────────────────────
async function dfsRequest(endpoint, payload, cfg) {
  const { dataforseo_login: login, dataforseo_password: pass } = cfg.api_keys;
  if (!login || !pass) throw new Error('DataForSEO credentials missing in blog-config.json');

  const resp = await axios.post(
    `https://api.dataforseo.com/v3/${endpoint}`,
    payload,
    { auth: { username: login, password: pass }, headers: { 'Content-Type': 'application/json' } }
  );
  return resp.data;
}

// ── Step 1a: Find competitors via DataForSEO SERP ────────────────────────────
async function findCompetitors(cfg) {
  console.log('🔍  Searching for competitors...');

  const query = `${cfg.business.description} site:${cfg.seo.domain}`;
  const payload = [{
    keyword: 'business intelligence consulting services',
    location_code: 2840, // United States
    language_code: 'en',
    depth: 10
  }];

  try {
    const data = await dfsRequest('serp/google/organic/live/advanced', payload, cfg);
    const results = data.tasks?.[0]?.result?.[0]?.items || [];

    const competitors = results
      .filter(r => r.type === 'organic' && !r.url?.includes('anglerbi.com'))
      .slice(0, 3)
      .map(r => ({
        name: r.title,
        url: r.url,
        domain: new URL(r.url).hostname.replace('www.', ''),
        description: r.description || ''
      }));

    console.log(`  Found ${competitors.length} competitors:`);
    competitors.forEach(c => console.log(`  • ${c.name} (${c.domain})`));
    return competitors;

  } catch (err) {
    console.warn('⚠️  DataForSEO competitor lookup failed:', err.message);
    console.log('   Skipping competitor discovery — you can add them manually to blog-config.json');
    return [];
  }
}

// ── Step 1b: Scrape website for fresh copy ───────────────────────────────────
async function scrapeWebsite(url) {
  console.log(`\n🌐  Fetching ${url}...`);
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AnglerBI-BlogBot/1.0)' },
      timeout: 10000
    });

    // Simple text extraction — no DOM needed for a static site
    const html = resp.data;
    const textBlocks = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    console.log(`  Scraped ${textBlocks.length} chars of content.`);
    return textBlocks.slice(0, 8000); // Limit for Claude context
  } catch (err) {
    console.warn('⚠️  Website scrape failed:', err.message);
    return '';
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Angler BI Blog Pipeline — Step 1: Onboarding');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const cfg = loadConfig();

  // Refresh website scrape
  const siteText = await scrapeWebsite(cfg.business.url);
  cfg.business._last_scraped = new Date().toISOString();
  cfg.business._raw_text_preview = siteText.slice(0, 500);

  // Find competitors
  const competitors = await findCompetitors(cfg);
  if (competitors.length > 0) {
    cfg.competitors = competitors;
  }

  saveConfig(cfg);

  console.log('\n✅  Step 1 complete. Review blog-config.json, then run step2-site-intelligence.js\n');
}

main().catch(err => {
  console.error('❌  Fatal error:', err.message);
  process.exit(1);
});
