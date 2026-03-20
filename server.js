const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3747;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load/save data
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { sets: [], progress: {} };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { sets: [], progress: {} }; }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// GET all sets
app.get('/api/sets', (req, res) => {
  const data = loadData();
  res.json(data.sets);
});

// GET single set
app.get('/api/sets/:id', (req, res) => {
  const data = loadData();
  const set = data.sets.find(s => s.id === req.params.id);
  if (!set) return res.status(404).json({ error: 'Not found' });
  res.json(set);
});

// CREATE set
app.post('/api/sets', (req, res) => {
  const data = loadData();
  const set = { ...req.body, id: Date.now().toString(), createdAt: new Date().toISOString() };
  data.sets.unshift(set);
  saveData(data);
  res.json(set);
});

// UPDATE set
app.put('/api/sets/:id', (req, res) => {
  const data = loadData();
  const idx = data.sets.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.sets[idx] = { ...data.sets[idx], ...req.body };
  saveData(data);
  res.json(data.sets[idx]);
});

// DELETE set
app.delete('/api/sets/:id', (req, res) => {
  const data = loadData();
  data.sets = data.sets.filter(s => s.id !== req.params.id);
  delete data.progress[req.params.id];
  saveData(data);
  res.json({ ok: true });
});

// GET progress
app.get('/api/progress/:setId', (req, res) => {
  const data = loadData();
  res.json(data.progress[req.params.setId] || {});
});

// SAVE progress
app.post('/api/progress/:setId', (req, res) => {
  const data = loadData();
  if (!data.progress) data.progress = {};
  data.progress[req.params.setId] = req.body;
  saveData(data);
  res.json({ ok: true });
});

// ── Shared card-extraction logic ──────────────────────────────────────────

/**
 * parseQuizletHtml(html)
 * Tries multiple strategies to extract {title, description, cards} from
 * any Quizlet page HTML — both live-fetched and locally-saved pages.
 */
function parseQuizletHtml(html) {
  let cards = [];
  let title = 'Imported Set';
  let description = '';

  // ── Strategy 1: __NEXT_DATA__ JSON blob (modern Quizlet) ──────────────────
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);

      // Recursive deep-search for a terms/studiableItems array
      function findTerms(obj, depth) {
        if (depth > 10 || !obj || typeof obj !== 'object') return null;
        if (Array.isArray(obj)) {
          // Quizlet term shape: { term, definition } or { word, definition }
          if (obj.length > 0 &&
            ((obj[0]?.term !== undefined) || (obj[0]?.word !== undefined)) &&
            obj[0]?.definition !== undefined) return obj;
          for (const item of obj) {
            const r = findTerms(item, depth + 1);
            if (r) return r;
          }
        } else {
          // Prioritise well-known keys first for speed
          for (const key of ['terms', 'studiableItems', 'flashcards', 'cardSides']) {
            if (obj[key]) { const r = findTerms(obj[key], depth + 1); if (r) return r; }
          }
          for (const key of Object.keys(obj)) {
            const r = findTerms(obj[key], depth + 1);
            if (r) return r;
          }
        }
        return null;
      }

      function findTitle(obj, depth) {
        if (depth > 6 || !obj || typeof obj !== 'object') return null;
        if (typeof obj.title === 'string' && obj.title.length > 0 && obj.title.length < 300) return obj.title;
        for (const key of Object.keys(obj)) {
          const r = findTitle(obj[key], depth + 1);
          if (r) return r;
        }
        return null;
      }

      const foundTerms = findTerms(nextData, 0);
      if (foundTerms) {
        cards = foundTerms.map((t, i) => ({
          id: i.toString(),
          front: (t.term || t.word || t.question || '').trim(),
          back: (t.definition || t.answer || '').trim()
        })).filter(c => c.front || c.back);
      }

      const foundTitle = findTitle(nextData, 0);
      if (foundTitle) title = foundTitle;

    } catch (e) { /* fall through */ }
  }

  // ── Strategy 2: inline JSON blobs (older Quizlet / partial pages) ─────────
  if (cards.length === 0) {
    // "term":"...","definition":"..."
    const termDef = /"term"\s*:\s*"((?:[^"\\]|\\.)*)","definition"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = termDef.exec(html)) !== null) {
      cards.push({ id: cards.length.toString(), front: JSON.parse('"' + m[1] + '"'), back: JSON.parse('"' + m[2] + '"') });
    }
  }

  // ── Strategy 3: saved/printed HTML — term list DOM pattern ────────────────
  // Quizlet saved pages render the term list as:
  //   <div class="...SetPageTerm..."><div ...>FRONT</div><div ...>BACK</div></div>
  // The exact class names change, so we match loosely on data attributes or
  // the well-known "TermText" / "definition" class fragments.
  if (cards.length === 0) {
    // Match pairs of adjacent divs that look like term/definition cells
    // Pattern seen in saved HTML: two consecutive text nodes separated by structure
    const termBlockRe = /class="[^"]*[Tt]erm[Tt]ext[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>\s*[\s\S]*?class="[^"]*[Dd]efinition[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/g;
    let m;
    while ((m = termBlockRe.exec(html)) !== null) {
      const front = stripTags(m[1]).trim();
      const back = stripTags(m[2]).trim();
      if (front || back) cards.push({ id: cards.length.toString(), front, back });
    }
  }

  // ── Strategy 4: plain-text saved page (markdown/text export) ─────────────
  // This handles the exact format seen in the uploaded file:
  //
  //   بائِع
  //   salesperson, shop assistant
  //
  //   مشروب غازي (مشروبات)
  //   Fizzy drink
  //
  // The "Terms in this set (N)" section is the anchor.
  if (cards.length === 0) {
    const termsSection = extractTermsSection(html);
    if (termsSection) {
      cards = parseTermsPlainText(termsSection);
    }
  }

  // ── Strategy 5: looser full-page plain-text scan ──────────────────────────
  // For saved .html files whose text content is already rendered — strip all
  // tags and look for the term list using surrounding anchors.
  if (cards.length === 0) {
    const plainText = stripTags(html);
    const termsSection = extractTermsSection(plainText);
    if (termsSection) {
      cards = parseTermsPlainText(termsSection);
    }
  }

  // De-duplicate (JSON blob strategies can produce dupes)
  const seen = new Set();
  cards = cards.filter(c => {
    const key = c.front + '|||' + c.back;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Title from <title> tag
  if (title === 'Imported Set') {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      title = titleMatch[1]
        .replace(/\s*[|–—-]\s*Quizlet.*$/i, '')
        .replace(/\s*Flashcards$/i, '')
        .trim();
    }
  }

  // Title from plain-text saved page: look for a short line before "5.0" rating or
  // before "Flashcards / Learn / Test" nav links — it's typically the set title.
  if (title === 'Imported Set') {
    const plain = stripTags(html);
    // The title usually appears just before "5.0 (N review)" or "Flashcards\nLearn"
    const m = plain.match(/\n([^\n]{3,120})\n(?:[\d.]+\s*\(\d+\s*review|Flashcards\s*\n)/i);
    if (m) title = m[1].trim();
  }

  return { title, description, cards };
}

/** Strip HTML tags from a string */
function stripTags(s) {
  return s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, '\n')
    .trim();
}

/**
 * Find the "Terms in this set (N)" section and return the text after it,
 * stopping before the next major section ("About us", "Students also", etc.)
 */
function extractTermsSection(text) {
  // Anchor: "Terms in this set" with optional count
  const anchor = text.search(/Terms in this set\s*\(\d+\)/i);
  if (anchor === -1) return null;
  const start = anchor + text.slice(anchor).search(/\n|\r/); // skip the heading line
  const rest = text.slice(start);
  // Stop at known footer sections
  const stopRe = /Students also studied|About us|About Quizlet|© 20\d\d|Hide definitions|Review with an activity/i;
  const stopMatch = rest.search(stopRe);
  return stopMatch === -1 ? rest : rest.slice(0, stopMatch);
}

/**
 * Parse the "term\ndefinition\n\nterm\ndefinition" plain-text format.
 *
 * Quizlet's saved pages render each card as two consecutive non-empty lines,
 * often separated by blank lines. We also handle the "Still learning / Mastered"
 * section headers that appear in saved pages.
 */
function parseTermsPlainText(text) {
  const cards = [];

  // Remove section headers like "Still learning (16)", "Mastered (54)"
  const cleaned = text
    .replace(/Still learning\s*\(\d+\)[\s\S]*?(?=\n\S)/i, '')
    .replace(/Mastered\s*\(\d+\)[\s\S]*?(?=\n\S)/i, '')
    .replace(/You've begun learning[^\n]*/gi, '')
    .replace(/You know these terms[^\n]*/gi, '')
    .replace(/Select these \d+/gi, '')
    .replace(/Your stats/gi, '')
    .replace(/^\s*(Edit|Save)\s*$/gim, '');  // remove standalone UI button lines

  // Split into lines, remove empties around markers
  const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let i = 0;
  while (i < lines.length - 1) {
    const front = lines[i];
    const back = lines[i + 1];

    // Heuristic: skip if either "line" looks like a UI label, URL, or section header
    const isJunk = l =>
      /^https?:\/\//.test(l) ||
      /^(Still learning|Mastered|Select these|Your stats|Track progress|Get a hint|Terms in this set|Practice questions|Don't know|Choose an answer|Study using|You can also|Hide definitions|Review with|About us|For Students|For teachers|Resources|Language|© 20)/i.test(l) ||
      /^(Edit|Save|Preview|Teacher|New folder|Notifications|Home|Your library|Study groups)$/i.test(l) ||  // single UI button/nav words
      /^\d+ \/ \d+$/.test(l) ||           // "1 / 70"
      l.length > 300;                        // suspiciously long = UI fragment

    if (isJunk(front) || isJunk(back)) { i++; continue; }

    // Accept the pair
    cards.push({ id: cards.length.toString(), front, back });
    i += 2; // consume both lines
  }

  return cards;
}

// IMPORT from Quizlet URL
// Uses Quizlet's internal JSON API — avoids Cloudflare HTML blocking entirely.
app.post('/api/import', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.includes('quizlet.com')) {
    return res.status(400).json({ error: 'Invalid Quizlet URL' });
  }

  // Extract numeric set ID from any Quizlet URL shape:
  //   quizlet.com/123456/flashcards
  //   quizlet.com/gb/123456/...
  //   quizlet.com/123456?...
  const idMatch = url.match(/quizlet\.com\/(?:[a-z]{2}\/)?(\d+)/);
  if (!idMatch) {
    return res.status(400).json({ error: 'Could not find a set ID in that URL. Make sure it is a link to a Quizlet set.' });
  }
  const setId = idMatch[1];

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://quizlet.com/',
    'Origin': 'https://quizlet.com',
  };

  try {
    // ── Step 1: fetch set metadata (title, description) ───────────────────
    let title = 'Imported Set';
    let description = '';
    try {
      const metaResp = await fetch(`https://quizlet.com/webapi/3.4/sets/${setId}`, { headers: HEADERS });
      if (metaResp.ok) {
        const metaJson = await metaResp.json();
        title = metaJson?.responses?.[0]?.models?.set?.[0]?.title || title;
        description = metaJson?.responses?.[0]?.models?.set?.[0]?.description || '';
      }
    } catch (_) { /* non-fatal — title fallback is fine */ }

    // ── Step 2: fetch all cards via studiable-item-documents API ──────────
    let cards = [];
    let page = 1;
    const perPage = 500;

    while (true) {
      const apiUrl =
        `https://quizlet.com/webapi/3.4/studiable-item-documents` +
        `?filters[studiableContainerId]=${setId}` +
        `&filters[studiableContainerType]=1` +
        `&perPage=${perPage}&page=${page}`;

      const apiResp = await fetch(apiUrl, { headers: HEADERS });

      if (!apiResp.ok) {
        // 403 = private set or rate-limited
        if (apiResp.status === 403 || apiResp.status === 401) {
          return res.status(422).json({
            error: 'This set is private or login is required. Save the Quizlet page as an HTML file and use "Import from file" instead.'
          });
        }
        // Any other error — try to keep going or bail
        console.error('Quizlet API error:', apiResp.status, await apiResp.text().catch(() => ''));
        break;
      }

      const json = await apiResp.json();

      // Navigate the response shape:
      // { responses: [{ models: { studiableItem: [...] } }] }
      const items = json?.responses?.[0]?.models?.studiableItem;
      if (!Array.isArray(items) || items.length === 0) break;

      for (const item of items) {
        // Each item has cardSides: [ { label: 'word', media: [{plainText}] }, { label: 'definition', ... } ]
        const sides = item.cardSides;
        if (!Array.isArray(sides) || sides.length < 2) continue;

        // Find word/term side and definition side by label
        const wordSide = sides.find(s => s.label === 'word') || sides[0];
        const defSide = sides.find(s => s.label === 'definition') || sides[1];

        const front = wordSide?.media?.[0]?.plainText?.trim() || '';
        const back = defSide?.media?.[0]?.plainText?.trim() || '';

        if (front || back) {
          cards.push({ id: String(cards.length), front, back });
        }
      }

      // Check if there are more pages
      const totalPages = json?.responses?.[0]?.paging?.totalPages || 1;
      if (page >= totalPages) break;
      page++;
    }

    if (cards.length === 0) {
      return res.status(422).json({
        error: 'Could not extract cards from this set. It may be private or empty. Try saving the Quizlet page as an HTML file and using "Import from file" instead.'
      });
    }

    res.json({ title, description, cards, source: url });

  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: 'Network error fetching from Quizlet. Check your internet connection.' });
  }
});

// IMPORT from uploaded/saved HTML file content
app.post('/api/import-html', (req, res) => {
  const { html, filename } = req.body;
  if (!html) return res.status(400).json({ error: 'No HTML content provided.' });

  const result = parseQuizletHtml(html);

  if (result.cards.length === 0) {
    return res.status(422).json({
      error: 'Could not find flashcard terms in this file. Make sure it is a saved Quizlet flashcard page.'
    });
  }

  // Use filename as title fallback
  if (result.title === 'Imported Set' && filename) {
    result.title = filename.replace(/\.html?$/i, '').replace(/_/g, ' ').replace(/\s*[|_-]\s*Quizlet.*$/i, '').trim();
  }

  res.json({ ...result, source: filename || 'local file' });
});

app.listen(PORT, () => {
  console.log(`\n✦ Flashcard app running at http://localhost:${PORT}\n`);
});
